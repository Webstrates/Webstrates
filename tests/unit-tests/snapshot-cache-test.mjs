// Compressed snapshot cache (compressedSnapshots) — unit tests of
// helpers/SnapshotCacheManager.js.
//
// The manager is the server-side half of the feature: per webstrate it stores
// a brotli-compressed {v, type, data} snapshot at
// <cacheDir>/<encodeURIComponent(id)>.json.br, rebuilt debounced after ops
// settle (an op with .del removes the entry at once), immediately after a
// fetchSnapshot cache miss, and bounded by a staleness deadline under
// continuous editing. These tests pin the manager's own semantics in
// isolation — gating, debounce coalescing and deadline extension, del-op and
// removeEntry invalidation, miss-build immediacy and in-flight deduplication,
// the staleness bound, payload shape, file naming and atomic writes, the
// coercion of the three knobs (debounce, quality, staleness bound) and both
// failure paths' logging. The wire protocol, the afterWrite wiring through a
// real server, both delete paths
// and the browser fast path are covered by
// tests/functional-tests/4-compressed-snapshots.mjs.
//
// The manager's only dependency is documentManager.getDocument(); a fake is
// planted into require.cache before the manager is first required, so the
// real DocumentManager (which connects to MongoDB through ShareDBWrapper)
// never loads. The fake records every call — the recorded timestamps make
// debounce-deadline assertions immune to event-loop stalls — and can serve
// per-id snapshots, reject, or hang on a test-controlled promise; the last
// one pins the in-flight-build behaviors deterministically, with no
// sleep-based races. Every timing assertion is one-sided safe: timers never
// fire early, so absence-before-deadline and presence-long-before-a-budget
// cannot flake on a slow machine.
import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The manager reads the bare APP_PATH global at load time (it requires
// APP_PATH + '/helpers/DocumentManager.js'), so the application root must be
// on the global before anything below requires the manager.
global.APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const require = createRequire(import.meta.url);

// All test cache directories live under one temp root, removed in after().
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'webstrates-snapcache-'));

// Fake DocumentManager: the manager's only call is getDocument({webstrateId}).
// 'auto' mode serves fake.snapshot (or fake.snapshots[webstrateId]), 'reject'
// makes every call throw, and 'defer' hands back a promise the test resolves
// when it wants the (in-flight) build to land — exact control over the
// manager's buildingNow set.
const fake = {
	calls: [],
	snapshot: null,
	snapshots: {},
	mode: 'auto',
	deferreds: [],
	async getDocument({ webstrateId }) {
		fake.calls.push({ webstrateId, at: Date.now() });
		if (fake.mode === 'reject') throw new Error('fake getDocument failure');
		if (fake.mode === 'defer') {
			const deferred = {};
			deferred.promise = new Promise((resolve, reject) => {
				deferred.resolve = resolve;
				deferred.reject = reject;
			});
			fake.deferreds.push(deferred);
			return deferred.promise;
		}
		return webstrateId in fake.snapshots ? fake.snapshots[webstrateId] : fake.snapshot;
	}
};

// Plant the fake into require.cache BEFORE the manager is first required, so
// its load-time require(APP_PATH + '/helpers/DocumentManager.js') gets the
// fake and the real DocumentManager never runs (require.resolve only resolves
// the path; loaded:true stops Node from treating the entry as an unfinished
// circular require). No other mocha spec requires DocumentManager in-process
// and harness servers are spawned child processes, so the plant can stay for
// the whole mocha run, harmlessly.
const dmPath = path.join(global.APP_PATH, 'helpers/DocumentManager.js');
const dmResolved = require.resolve(dmPath);
require.cache[dmResolved] = { id: dmResolved, filename: dmResolved, loaded: true, exports: fake };

const snapshotCacheManager =
	require(path.join(global.APP_PATH, 'helpers/SnapshotCacheManager.js'));

describe('Snapshot cache manager (compressedSnapshots)', function () {
	this.timeout(10000);

	let previousConfig;
	let cacheDir;
	let seq = 0;
	const issuedIds = new Set();

	// Ids the tests fabricate on their own (special characters, …) join the
	// afterEach sweep explicitly through trackId().
	const newId = () => {
		const id = 'sc-' + (++seq);
		issuedIds.add(id);
		return id;
	};

	const trackId = (id) => {
		issuedIds.add(id);
		return id;
	};

	const entryPath = (id) =>
		path.join(global.config.compressedSnapshotCacheDir, encodeURIComponent(id) + '.json.br');

	const plantEntry = (id, bytes) => {
		fs.mkdirSync(global.config.compressedSnapshotCacheDir, { recursive: true });
		fs.writeFileSync(entryPath(id), bytes);
	};

	const payloadOf = (id) =>
		JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(entryPath(id))));

	const snap = (v) => ({ v, type: 'http://sharejs.org/types/JSONv0', data: ['body', 'v' + v] });

	const callsFor = (id) => fake.calls.filter((call) => call.webstrateId === id).length;

	const callAt = (id, n) => {
		const calls = fake.calls.filter((call) => call.webstrateId === id);
		assert.isAbove(calls.length, n, `expected at least ${n + 1} getDocument calls for ${id}`);
		return calls[n].at;
	};

	const waitFor = async (predicate, what, budget = 2000, step = 25) => {
		const deadline = Date.now() + budget;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await sleep(step);
		}
		if (predicate()) return;
		assert.fail(what);
	};

	beforeEach(() => {
		previousConfig = global.config;
		seq += 1;
		// A child name that does not exist yet: several tests assert that the
		// manager never creates the directory on its own.
		cacheDir = path.join(tmpBase, 'cache-' + seq);
		global.config = {
			compressedSnapshots: true,
			compressedSnapshotCacheDir: cacheDir,
			compressedSnapshotBrotliQuality: 11,
			compressedSnapshotDebounceMs: 50,
			compressedSnapshotMaxStalenessMs: 60000
		};
	});

	afterEach(() => {
		// Cancel any leaked debounce timer and unlink any entry, per issued id
		// (removeEntry is ungated, so this works whatever state global.config
		// is in). Mocha waits for the event loop to drain, so a leaked
		// default-5000 ms debounce timer would delay the whole run's exit.
		for (const id of issuedIds) snapshotCacheManager.removeEntry(id);
		const usedDir = global.config && global.config.compressedSnapshotCacheDir;
		global.config = previousConfig;
		fake.calls = [];
		fake.snapshots = {};
		fake.snapshot = null;
		fake.mode = 'auto';
		fake.deferreds = [];
		fs.rmSync(cacheDir, { recursive: true, force: true });
		if (usedDir && usedDir !== cacheDir) fs.rmSync(usedDir, { recursive: true, force: true });
		issuedIds.clear();
	});

	after(() => {
		fs.rmSync(tmpBase, { recursive: true, force: true });
		// The require.cache plant of DocumentManager and the manager instance
		// stay for the rest of the mocha process: nothing else requires either
		// module in-process, so the fake keeps serving the manager and no
		// other spec ever sees it.
	});

	describe('feature gating', function () {
		it('should no-op scheduleRebuild (ops, miss triggers, del ops) and readEntry while ' +
			'disabled — non-strict-true values count as off, and the flag is re-read on ' +
			'every call', async () => {
			const idA = newId();
			const idB = newId();
			const idC = newId();
			const idD = newId();
			const planted = Buffer.from('planted-by-test');
			global.config.compressedSnapshots = false;

			// Ops, miss triggers and del ops alike no-op while disabled: not
			// even the cache directory is created (a build is the only thing
			// that ever mkdirs it).
			snapshotCacheManager.scheduleRebuild(idA, {});
			snapshotCacheManager.scheduleRebuild(idA, null);
			snapshotCacheManager.scheduleRebuild(idA, { del: true });
			assert.isFalse(fs.existsSync(global.config.compressedSnapshotCacheDir),
				'scheduleRebuild while disabled should not create the cache directory');

			// Serving is gated before disk: a planted entry is not readable.
			fs.mkdirSync(global.config.compressedSnapshotCacheDir, { recursive: true });
			plantEntry(idA, planted);
			assert.isNull(snapshotCacheManager.readEntry(idA),
				'readEntry should return null while the feature is disabled');
			// The enabled gate precedes the del branch, so a disabled server
			// never deletes on a del op either.
			snapshotCacheManager.scheduleRebuild(idA, { del: true });
			assert.isTrue(fs.existsSync(entryPath(idA)),
				'a del op while disabled should leave the entry on disk');

			// Truthy-but-not-true values disable the feature too; the
			// immediate miss-trigger path is the strongest probe.
			const truthyPairs = [[1, idB], ['true', idC], [undefined, idD]];
			for (const [value, id] of truthyPairs) {
				global.config.compressedSnapshots = value;
				snapshotCacheManager.scheduleRebuild(id, null);
			}
			await sleep(200); // 4x the 50 ms would-be debounce; nothing was armed anyway.

			assert.lengthOf(fake.calls, 0, 'nothing should reach getDocument while disabled');
			// Flipping the flag on the same config object takes effect on the
			// very next call: the planted bytes become readable (which makes
			// the null-half above non-vacuous).
			global.config.compressedSnapshots = true;
			assert.equal(Buffer.compare(snapshotCacheManager.readEntry(idA), planted), 0,
				'the same entry should be readable once the feature is enabled');
			// 1 and 'true' were not === true: no entries were ever written.
			assert.isFalse(fs.existsSync(entryPath(idB)),
				'a truthy non-true flag must not enable the feature');
			assert.isFalse(fs.existsSync(entryPath(idC)),
				'a string true flag must not enable the feature');
			assert.isFalse(fs.existsSync(entryPath(idD)),
				'an undefined flag must not enable the feature');
			assert.lengthOf(fake.calls, 0);
		});

		it('should re-check the flag at build time: disabling between arming the debounce ' +
			'and the timer prevents the build entirely', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 0;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, {}); // arms a 0 ms timer…
			// …and the flag is off before that timer can run (same tick: no
			// timer can fire between two synchronous statements).
			global.config.compressedSnapshots = false;
			await sleep(150); // >= 100x the 0 ms timer: it demonstrably ran.
			assert.lengthOf(fake.calls, 0,
				'the build-time gate should stop the build before getDocument');
			assert.isFalse(fs.existsSync(entryPath(id)), 'no entry should be written');
			assert.isFalse(fs.existsSync(cacheDir), 'the cache directory should not be created');
		});

		it('should let removeEntry work ungated: it unlinks the file and cancels a pending ' +
			'debounced rebuild regardless of the flag', async () => {
			const idA = newId();
			const idB = newId();
			// Feature off: cleanup of an entry left behind while the feature
			// was disabled still works (no isEnabled gate in removeEntry).
			global.config.compressedSnapshots = false;
			plantEntry(idA, Buffer.from('stale-while-disabled'));
			snapshotCacheManager.removeEntry(idA);
			assert.isFalse(fs.existsSync(entryPath(idA)),
				'removeEntry should unlink synchronously even with the feature off');
			await sleep(80);
			assert.isFalse(fs.existsSync(entryPath(idA)));

			// Feature on, a 300 ms debounced rebuild pending: removeEntry must
			// cancel the TIMER, not just remove the (nonexistent) file.
			global.config.compressedSnapshots = true;
			global.config.compressedSnapshotDebounceMs = 300;
			const secondDir = path.join(tmpBase, 'cache-' + (++seq));
			global.config.compressedSnapshotCacheDir = secondDir;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(idB, {});
			snapshotCacheManager.removeEntry(idB);
			assert.isFalse(fs.existsSync(secondDir), 'nothing should have been built');
			await sleep(650); // > 2x the armed 300 ms timer
			assert.isFalse(fs.existsSync(secondDir),
				'the cancelled timer should never have fired');
			assert.equal(callsFor(idB), 0,
				'the pending rebuild was cancelled, not just the file removed');
		});
	});

	describe('op-triggered debounced rebuilds', function () {
		it('should coalesce an op burst into a single rebuild that reads the settled document',
			async () => {
				const id = newId();
				global.config.compressedSnapshotDebounceMs = 100;
				fake.snapshot = snap(1);
				for (let i = 0; i < 5; i++) snapshotCacheManager.scheduleRebuild(id, {});
				// No timer can fire mid-tick: the entry cannot exist yet, so
				// no intermediate v1 build ever ran.
				assert.isFalse(fs.existsSync(entryPath(id)));
				// The settled document is what the (single) build must read.
				fake.snapshot = snap(2);
				await waitFor(() => fs.existsSync(entryPath(id)), 'the debounced rebuild');
				assert.equal(callsFor(id), 1,
					'five ops within one debounce window should coalesce into one rebuild');
				assert.deepEqual(payloadOf(id), snap(2),
					'the single build should read the post-burst settled document');
			});

		it('should extend the rebuild deadline from the last op, not the first', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 250;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, {}); // op 1
			await sleep(100);
			const t2 = Date.now();
			snapshotCacheManager.scheduleRebuild(id, {}); // op 2 re-arms
			await waitFor(() => fs.existsSync(entryPath(id)), 'the debounced rebuild');
			assert.equal(callsFor(id), 1, 'both ops should coalesce into one rebuild');
			// The build ran at >= t2 + 250: an implementation arming from the
			// FIRST op fires at t1 + 250, which is only ~t2 + 150, and fails
			// with ~95 ms to spare. The RECORDED call timestamp is asserted,
			// not a wall-clock probe, so a slow machine only pushes it later.
			assert.isAtLeast(callAt(id, 0) - t2, 245,
				'the rebuild should be debounced from the last op');
		});

		it('should treat invalid debounce values (garbage, negative) as the 5000 ms default ' +
			'(not immediate), zero as immediate, and numeric strings as numbers', async () => {
			const idA = newId();
			const idB = newId();
			const idC = newId();
			const idD = newId();
			fake.snapshot = snap(1);

			// '150' coerces to 150: the entry appears well inside 1 s.
			global.config.compressedSnapshotDebounceMs = '150';
			snapshotCacheManager.scheduleRebuild(idA, {});
			await waitFor(() => fs.existsSync(entryPath(idA)),
				'the coerced 150 ms rebuild', 1000);

			// Garbage (NaN) AND a negative number both fall back to the
			// 5000 ms default — NOT to 0. The 1200 ms window is the
			// observation: any wrong default below 1200 ms would have built.
			// (The delay is computed at arm time, so the config change
			// between the two schedules is harmless; afterEach's removeEntry
			// cancels the 5000 ms straggler timers.)
			global.config.compressedSnapshotDebounceMs = 'garbage';
			snapshotCacheManager.scheduleRebuild(idB, {});
			global.config.compressedSnapshotDebounceMs = -5;
			snapshotCacheManager.scheduleRebuild(idD, {});
			await sleep(1200);
			assert.isFalse(fs.existsSync(entryPath(idB)),
				'invalid debounce values must not become immediate rebuilds');
			assert.equal(callsFor(idB), 0);
			assert.isFalse(fs.existsSync(entryPath(idD)),
				'a negative debounce must fall back to the 5000 ms default, not to immediate');
			assert.equal(callsFor(idD), 0);

			// 0 is a legal boundary value (Number.isFinite && >= 0).
			global.config.compressedSnapshotDebounceMs = 0;
			snapshotCacheManager.scheduleRebuild(idC, {});
			await waitFor(() => fs.existsSync(entryPath(idC)),
				'the immediate 0 ms rebuild', 1000);
			assert.equal(callsFor(idC), 1, 'zero is a valid (immediate) debounce');
		});
	});

	describe('miss-triggered rebuilds', function () {
		it('should build immediately on a miss trigger (op === null), not debounced',
			async () => {
				const id = newId();
				global.config.compressedSnapshotDebounceMs = 10000;
				fake.snapshot = snap(1);
				snapshotCacheManager.scheduleRebuild(id, null);
				// getDocument runs within scheduleRebuild's own tick
				// (runRebuild -> buildAndWrite runs synchronously to its first
				// await).
				assert.equal(callsFor(id), 1, 'a miss trigger should fetch the document at once');
				await waitFor(() => fs.existsSync(entryPath(id)), 'the immediate rebuild');
				// The 2 s budget is the discriminator: a debounced
				// implementation waits out the configured 10 s and cannot pass.
				assert.deepEqual(payloadOf(id), snap(1));
			});

		it('should deduplicate miss triggers while a build is in flight, and allow a new one ' +
			'after it lands', async () => {
			const id = newId();
			fake.mode = 'defer';
			snapshotCacheManager.scheduleRebuild(id, null); // build 1 hangs
			snapshotCacheManager.scheduleRebuild(id, null); // deduplicated
			assert.lengthOf(fake.deferreds, 1,
				'the second miss trigger should not consume a getDocument');
			fake.deferreds[0].resolve(snap(5));
			await waitFor(() => fs.existsSync(entryPath(id)), 'the in-flight build');
			assert.equal(payloadOf(id).v, 5, 'the entry should hold the resolved snapshot');
			// buildingNow was cleared when the build landed: a third miss
			// trigger builds again (a leaked dedup would keep the count at 1).
			fake.mode = 'auto';
			fake.snapshot = snap(6);
			snapshotCacheManager.scheduleRebuild(id, null);
			await waitFor(() => payloadOf(id).v === 6, 'the follow-up build');
			assert.equal(callsFor(id), 2, 'the landed build must clear buildingNow');
		});

		it('should skip a miss trigger while an op-debounced rebuild is pending (the freshest ' +
			'data wins)', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 250;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, {}); // arms the 250 ms timer
			await sleep(50);
			snapshotCacheManager.scheduleRebuild(id, null); // the miss: skipped
			await sleep(30);
			assert.equal(callsFor(id), 0,
				'the miss should neither build nor disturb the pending timer');
			// Data that postdates the miss: the surviving debounced build must
			// read THIS (the freshest-data-wins contract).
			fake.snapshot = snap(2);
			await waitFor(() => fs.existsSync(entryPath(id)), 'the pending debounced rebuild', 1000);
			assert.equal(callsFor(id), 1);
			assert.deepEqual(payloadOf(id), snap(2),
				'the debounced build should read data that postdates the miss');
		});

		it('should let an op arriving during an in-flight build arm a fresh debounced rebuild ' +
			'that reads the newer data', async () => {
			const id = newId();
			fake.mode = 'defer';
			snapshotCacheManager.scheduleRebuild(id, null); // build 1 hangs
			global.config.compressedSnapshotDebounceMs = 100;
			snapshotCacheManager.scheduleRebuild(id, {}); // op path arms a fresh timer
			// Build 1 lands (well) before the 100 ms timer fires…
			fake.deferreds[0].resolve(snap(1));
			await waitFor(() => fs.existsSync(entryPath(id)) && payloadOf(id).v === 1,
				'build 1 landing');
			// …then the op-armed timer fires into a second build, which hangs.
			await waitFor(() => fake.deferreds.length === 2, 'build 2 starting');
			fake.deferreds[1].resolve(snap(2));
			await waitFor(() => payloadOf(id).v === 2, 'build 2 landing');
			assert.equal(callsFor(id), 2,
				'the op-armed timer was not swallowed by the in-flight build');
			// Edits landing during a slow build are never lost: the second
			// build, running after the first landed, read the NEWER data.
			assert.equal(payloadOf(id).v, 2);
		});

		it('PIN (concurrent-rebuild defect): a debounced timer firing during an in-flight ' +
			'build starts a SECOND concurrent build — runRebuild lacks the buildingNow guard',
		async () => {
			// This test PINS current behavior (runRebuild has no
			// buildingNow guard, unlike the miss path): a fix that adds
			// the guard must INVERT the calls === 2 assertion below.
			const id = newId();
			fake.mode = 'defer';
			snapshotCacheManager.scheduleRebuild(id, null); // build 1 hangs
			global.config.compressedSnapshotDebounceMs = 50;
			snapshotCacheManager.scheduleRebuild(id, {}); // op path arms a 50 ms timer
			// The timer fires INTO runRebuild, which does not check
			// buildingNow: a second buildAndWrite starts while build 1 is
			// still hanging (deferreds[0] is unresolved throughout).
			// Deadline-based, not a fixed sleep: an event-loop stall around
			// the 50 ms timer must not turn into a spurious failure.
			await waitFor(() => fake.deferreds.length === 2,
				'build 2 starting (the unguarded timer)', 500);
			assert.equal(callsFor(id), 2,
				'the timer should start a second concurrent build (pin: no buildingNow guard)');
			assert.lengthOf(fake.deferreds, 2);
			fake.deferreds[0].resolve(snap(1));
			fake.deferreds[1].resolve(snap(2));
			await waitFor(() => fs.existsSync(entryPath(id)), 'one of the builds landing');
			// Both builds raced on the same .tmp<pid> path; which payload
			// lands is scheduler-dependent, so only "one valid payload, no
			// residue" is asserted — the byte-level interleaving outcomes
			// are reported as a finding, not pinned here.
			assert.oneOf(payloadOf(id).v, [1, 2]);
			assert.deepEqual(fs.readdirSync(cacheDir),
				[encodeURIComponent(id) + '.json.br'],
				'no .tmp residue should remain, in any interleaving');
		});
	});

	describe('staleness bound', function () {
		it('should rebuild immediately once a pending entry is staler than maxStalenessMs ' +
			'(with a fresh-pair control)', async () => {
			const id1 = newId();
			const id2 = newId();
			global.config.compressedSnapshotDebounceMs = 5000;
			global.config.compressedSnapshotMaxStalenessMs = 300;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id1, {}); // arms a 5000 ms timer
			await sleep(350); // the pending entry is now staler than 300 ms
			snapshotCacheManager.scheduleRebuild(id1, {}); // -> immediate rebuild
			// The 2 s budget is 2.5x shorter than the debounce: only the
			// staleness branch can satisfy it.
			await waitFor(() => fs.existsSync(entryPath(id1)), 'the staleness-forced rebuild');
			assert.equal(callsFor(id1), 1);
			// Control: a fresh pending pair merely re-arms — no build, even
			// though a second op arrived.
			snapshotCacheManager.scheduleRebuild(id2, {});
			snapshotCacheManager.scheduleRebuild(id2, {});
			await sleep(600);
			assert.isFalse(fs.existsSync(entryPath(id2)),
				'a second op alone should not build immediately');
			assert.equal(callsFor(id2), 0, 'only the stale pair rebuilds');
		});

		it('should anchor staleness at the first pending op (re-arming never refreshes ' +
			'scheduledAt)', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 5000;
			global.config.compressedSnapshotMaxStalenessMs = 600;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, {}); // op 1: scheduledAt = t0
			await sleep(150);
			snapshotCacheManager.scheduleRebuild(id, {}); // op 2: re-arm (150 < 600)
			await sleep(500); // now t0 + 650
			snapshotCacheManager.scheduleRebuild(id, {}); // op 3: 650 > 600 since op 1
			// Under per-op-refreshing semantics the elapsed time at op 3
			// would be 500 ms (< 600): mere re-arming, and no build could
			// appear within 2 s against the 5000 ms deadline. Under first-op
			// anchoring (the contract) the build runs now. Margins: op 2
			// tolerates a ~450 ms event-loop stall before IT would trip the
			// bound (and both semantics would then agree, making this pass
			// vacuously); op 3's elapsed >= 650 ms is guaranteed against the
			// 600 ms bound because the sleeps only ever overshoot.
			await waitFor(() => fs.existsSync(entryPath(id)),
				'the staleness-forced rebuild at op 3');
			assert.equal(callsFor(id), 1);
		});

		it('should treat invalid maxStalenessMs values (garbage, negative) as the 60000 ms ' +
			'default, never as a small bound', async () => {
			const id1 = newId();
			const id2 = newId();
			global.config.compressedSnapshotDebounceMs = 5000;
			fake.snapshot = snap(1);
			// The exact 60000 default is not observable in test time; the
			// observable contract is that an invalid bound does not collapse
			// to something small. A falsy/||-style default would make it 0:
			// the second op below, 300 ms after the first, would then trip the
			// (nonexistent) bound and rebuild immediately instead of merely
			// re-arming the 5000 ms debounce.
			global.config.compressedSnapshotMaxStalenessMs = 'garbage';
			snapshotCacheManager.scheduleRebuild(id1, {});
			await sleep(300);
			snapshotCacheManager.scheduleRebuild(id1, {}); // 300 ms < 60000: re-arm
			global.config.compressedSnapshotMaxStalenessMs = -1;
			snapshotCacheManager.scheduleRebuild(id2, {});
			await sleep(300);
			snapshotCacheManager.scheduleRebuild(id2, {}); // same re-arm contract
			await sleep(1000); // any wrongly-small bound had 1300 ms to fire
			for (const id of [id1, id2]) {
				assert.isFalse(fs.existsSync(entryPath(id)),
					`an invalid staleness bound must not force a rebuild (${id})`);
				assert.equal(callsFor(id), 0,
					`no build may run off an invalid staleness bound (${id})`);
			}
		});

		it('should treat maxStalenessMs 0 as valid and rebuild on the next op', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 5000;
			global.config.compressedSnapshotMaxStalenessMs = 0;
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, {});
			await sleep(15); // guarantees >= 1 ms of elapsed staleness
			snapshotCacheManager.scheduleRebuild(id, {});
			// 0 is an accepted bound (Number.isFinite && >= 0), not a value
			// that defaults to 60000: an ||-style defaulting bug would leave
			// the entry pending for the full 5 s and fail the 2 s budget.
			// (The exact elapsed === 0 boundary of the strict > comparison is
			// a Date.now ms-granularity coin flip on a same-millisecond burst
			// and is deliberately not asserted.)
			await waitFor(() => fs.existsSync(entryPath(id)),
				'the staleness-forced rebuild');
			assert.equal(callsFor(id), 1);
		});
	});

	describe('deletion and failure paths', function () {
		it('should remove the entry immediately on a del op and cancel the pending rebuild',
			async () => {
				const id = newId();
				global.config.compressedSnapshotDebounceMs = 200;
				fake.snapshot = snap(1);
				snapshotCacheManager.scheduleRebuild(id, null); // warm the entry
				await waitFor(() => fs.existsSync(entryPath(id)), 'the warm entry');
				assert.equal(callsFor(id), 1);
				snapshotCacheManager.scheduleRebuild(id, {}); // arms a 200 ms timer
				snapshotCacheManager.scheduleRebuild(id, { del: true });
				// The unlink is synchronous: a deleted document must never be
				// served, with no debounce window between the del op and the
				// cache effect.
				assert.isFalse(fs.existsSync(entryPath(id)),
					'a del op should remove the entry immediately');
				await sleep(450); // > 2x the armed 200 ms timer
				assert.isFalse(fs.existsSync(entryPath(id)), 'the entry should stay gone');
				assert.equal(callsFor(id), 1,
					'the pending debounced rebuild was cancelled, not just the file removed');
			});

		it('PIN (documented race): an in-flight build re-creates a deleted entry, and the ' +
			'next op rebuilds fresh', async () => {
			// This test PINS the race documented in removeEntry's NOTE
			// (helpers/SnapshotCacheManager.js): neither removeEntry nor the
			// del-op branch checks buildingNow. If the race is ever fixed,
			// this test must be updated — do not work around it.
			const id = newId();
			fake.mode = 'defer';
			snapshotCacheManager.scheduleRebuild(id, null); // build hangs, pre-delete
			snapshotCacheManager.removeEntry(id); // the ?delete path
			assert.isFalse(fs.existsSync(entryPath(id)));
			// The pre-delete getDocument resolves after the deletion: the
			// write path has no re-check, so the entry reappears — stale.
			fake.deferreds[0].resolve(snap(5));
			await waitFor(() => fs.existsSync(entryPath(id)),
				'the in-flight build resurrecting the entry');
			assert.equal(payloadOf(id).v, 5,
				'the resurrected entry holds the pre-delete payload');
			// The self-heal the NOTE promises: the next op rebuilds fresh.
			fake.mode = 'auto';
			fake.snapshot = snap(7);
			global.config.compressedSnapshotDebounceMs = 50;
			snapshotCacheManager.scheduleRebuild(id, {});
			await waitFor(() => payloadOf(id).v === 7, 'the post-op fresh rebuild');
		});

		it('PIN (del-op race): a del op committed while a build is in flight cannot stop it — ' +
			'the landing build resurrects the entry', async () => {
			// The del-op twin of the removeEntry PIN above: the del branch
			// (like removeEntry) never checks buildingNow, so a fetch that
			// resolved after the del op still writes its pre-delete payload.
			// If the race is ever fixed, this test must be inverted — do not
			// work around it.
			const id = newId();
			fake.mode = 'defer';
			snapshotCacheManager.scheduleRebuild(id, null); // build hangs, pre-delete
			snapshotCacheManager.scheduleRebuild(id, { del: true }); // the del op
			assert.isFalse(fs.existsSync(entryPath(id)),
				'the del branch should remove whatever entry existed');
			// The pre-delete fetch resolves after the del op was committed.
			fake.deferreds[0].resolve(snap(5));
			await waitFor(() => fs.existsSync(entryPath(id)),
				'the in-flight build resurrecting the entry');
			assert.equal(payloadOf(id).v, 5,
				'the resurrected entry holds the pre-delete payload');
			// The self-heal: the next op rebuilds fresh.
			fake.mode = 'auto';
			fake.snapshot = snap(7);
			global.config.compressedSnapshotDebounceMs = 50;
			snapshotCacheManager.scheduleRebuild(id, {});
			await waitFor(() => payloadOf(id).v === 7, 'the post-op fresh rebuild');
		});

		it('should keep the previous entry when getDocument rejects, log the failure, and ' +
			'clear buildingNow so the next build succeeds', async () => {
			const id = newId();
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, null); // warm the entry
			await waitFor(() => fs.existsSync(entryPath(id)), 'the warm entry');
			const before = fs.readFileSync(entryPath(id));

			fake.mode = 'reject';
			const errorLines = [];
			const originalError = console.error;
			console.error = (...args) => errorLines.push(args.join(' '));
			try {
				snapshotCacheManager.scheduleRebuild(id, null);
				await waitFor(() => callsFor(id) === 2, 'the failing build to run');
				await sleep(50); // let the failure continuation settle
				assert.isTrue(errorLines.some((line) =>
					line.includes(`SnapshotCache: failed to fetch "${id}":`)),
				'the failure should be logged with the exact prefix');
				// The failed build leaves the OLD entry byte-for-byte intact:
				// stale-but-valid keeps being served (clients catch up via ops).
				assert.equal(Buffer.compare(fs.readFileSync(entryPath(id)), before), 0,
					'the failed build should leave the previous entry untouched');
			} finally {
				console.error = originalError;
			}

			// buildingNow was cleared by the failure's then-path: the next
			// trigger builds again (a leaked dedup would leave the payload at
			// v1 and fail here).
			fake.mode = 'auto';
			fake.snapshot = snap(2);
			snapshotCacheManager.scheduleRebuild(id, null);
			await waitFor(() => callsFor(id) === 3, 'the recovery build');
			await waitFor(() => payloadOf(id).v === 2, 'the recovered entry');
		});

		it('should log a rebuild failure (not a fetch failure) when the write itself throws, ' +
			'keep the previous entry, and clear buildingNow', async () => {
			const id = newId();
			fake.snapshot = snap(1);
			snapshotCacheManager.scheduleRebuild(id, null); // warm the entry
			await waitFor(() => fs.existsSync(entryPath(id)), 'the warm entry');
			const before = fs.readFileSync(entryPath(id));
			// A directory planted at the atomic write's exact .tmp path makes
			// writeFileSync throw EISDIR — the deterministic route into
			// runRebuild's catch (the getDocument rejection has its own
			// prefix, covered by the test above).
			const tmpPath = entryPath(id) + '.tmp' + process.pid;
			fs.mkdirSync(tmpPath);
			const errorLines = [];
			const originalError = console.error;
			console.error = (...args) => errorLines.push(args.join(' '));
			try {
				snapshotCacheManager.scheduleRebuild(id, null);
				await waitFor(() => errorLines.some((line) =>
					line.includes('SnapshotCache: rebuild failed:')),
				'the rebuild-failed log line');
				assert.include(errorLines.find((line) =>
					line.includes('SnapshotCache: rebuild failed:')), 'EISDIR',
				'the write failure itself should be the logged reason');
				// The failed build leaves the OLD entry byte-for-byte intact:
				// stale-but-valid keeps being served (clients catch up via ops).
				assert.equal(Buffer.compare(fs.readFileSync(entryPath(id)), before), 0,
					'the failed write should leave the previous entry untouched');
			} finally {
				console.error = originalError;
				fs.rmSync(tmpPath, { recursive: true, force: true });
			}
			// buildingNow was cleared by the catch: the next trigger builds
			// again (a leaked buildingNow would leave the payload at v1).
			fake.snapshot = snap(2);
			snapshotCacheManager.scheduleRebuild(id, null);
			await waitFor(() => payloadOf(id).v === 2, 'the recovery build');
		});
	});

	describe('payload and file mechanics', function () {
		it('should store {v, type, data} verbatim (including v:0 and data:[]) byte-identical ' +
			'to readEntry, and log the stored line', async () => {
			const id = newId();
			const emptyId = newId();
			const fancy = {
				v: 7,
				type: 'http://sharejs.org/types/JSONv0',
				data: ['html', { class: 'a&b', 'data-u': 'héllo wörld' },
					['body', 'plain & <text>']]
			};
			fake.snapshot = fancy;
			const logLines = [];
			const originalLog = console.log;
			console.log = (...args) => logLines.push(args.join(''));
			try {
				snapshotCacheManager.scheduleRebuild(id, null);
				await waitFor(() => fs.existsSync(entryPath(id)), 'the entry');
				// The stored log fires a microtask after the write: wait for it
				// explicitly instead of assuming the file and the log agree.
				await waitFor(() => logLines.some((line) =>
					line.includes(`SnapshotCache: stored "${id}" v7 `)), 'the stored log line');
			} finally {
				console.log = originalLog;
			}
			// readEntry serves the raw file bytes…
			assert.equal(Buffer.compare(snapshotCacheManager.readEntry(id),
				fs.readFileSync(entryPath(id))), 0,
			'readEntry should serve the raw file bytes');
			// …and they decompress to the exact snapshot — unicode, '&' and
			//'<' survive verbatim, no re-encoding — with nothing else stored.
			const parsed = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(entryPath(id))));
			assert.deepEqual(parsed, fancy);
			assert.deepEqual(Object.keys(parsed).sort(), ['data', 'type', 'v'],
				'only v, type and data should be stored');
			assert.match(logLines.find((line) =>
				line.includes(`SnapshotCache: stored "${id}" v7 `)) || '',
			new RegExp('^SnapshotCache: stored "' + id + '" v7 \\(\\d+ -> \\d+ bytes\\)$'),
			'the build-completed log line should match the documented format');

			// Boundaries: v 0 is preserved verbatim (no falsy-v bug) and an
			// EMPTY ARRAY is cached ([] is truthy, unlike null).
			fake.snapshot = { v: 0, type: 'http://sharejs.org/types/JSONv0', data: [] };
			snapshotCacheManager.scheduleRebuild(emptyId, null);
			await waitFor(() => fs.existsSync(entryPath(emptyId)), 'the empty-array entry');
			assert.deepEqual(payloadOf(emptyId),
				{ v: 0, type: 'http://sharejs.org/types/JSONv0', data: [] },
				'an empty-array snapshot is cached, with v 0 preserved verbatim');
		});

		it('should remove entries for missing or empty documents (null snapshot, null type, ' +
			'null data)', async () => {
			const idN = newId();
			const idT = newId();
			const idD = newId();
			fake.snapshots = {
				[idN]: null,
				[idT]: { v: 2, type: null, data: ['body', 'x'] },
				[idD]: { v: 2, type: 'http://sharejs.org/types/JSONv0', data: null }
			};
			// A stale entry exists for each: a deleted or emptied document
			// must never keep being served.
			plantEntry(idN, Buffer.from('stale'));
			plantEntry(idT, Buffer.from('stale'));
			plantEntry(idD, Buffer.from('stale'));
			for (const id of [idN, idT, idD]) {
				snapshotCacheManager.scheduleRebuild(id, null);
				// The build provably ran (one call) and chose to remove.
				await waitFor(() => callsFor(id) === 1,
					`the build for ${id} to run (and choose to remove)`);
			}
			await sleep(100); // the unlink is synchronous inside the build; margin only
			for (const id of [idN, idT, idD]) {
				assert.isFalse(fs.existsSync(entryPath(id)),
					`the entry for ${id} should be removed`);
			}
			assert.deepEqual(fs.readdirSync(cacheDir), [],
				'nothing should be written for missing or empty documents');
		});

		it('should clamp invalid brotli qualities to exactly 11, coerce in-range numeric ' +
			'strings to their number (a quoted 9 is quality 9, not 11), and let quality 0 ' +
			'produce larger output', async () => {
			const data = ['body', ...Array.from({ length: 1000 }, () => ['p', 'x'])];
			fake.snapshot = { v: 1, type: 'http://sharejs.org/types/JSONv0', data };
			const ids = {};
			// The quality is read at BUILD time, so setting it between builds
			// is enough. Brotli is deterministic, so a byte-identical entry
			// PROVES the exact quality used (not merely 'valid brotli').
			// JSON.stringify keys keep 9 and '9' distinct.
			for (const quality of [11, 9, '9', 99, 'zzz', 0]) {
				const id = newId();
				ids[JSON.stringify(quality)] = id;
				global.config.compressedSnapshotBrotliQuality = quality;
				snapshotCacheManager.scheduleRebuild(id, null);
				await waitFor(() => fs.existsSync(entryPath(id)),
					`the quality-${quality} build`);
			}
			const bytesOf = (id) => fs.readFileSync(entryPath(id));
			assert.equal(Buffer.compare(bytesOf(ids['99']), bytesOf(ids['11'])), 0,
				'quality 99 should clamp to exactly the quality-11 bytes');
			assert.equal(Buffer.compare(bytesOf(ids['"zzz"']), bytesOf(ids['11'])), 0,
				'a garbage quality string should clamp to exactly the quality-11 bytes');
			// An in-range numeric string coerces to the NUMBER 9 (no
			// clamping): byte-identical to a real quality-9 build, and
			// demonstrably NOT the quality-11 bytes.
			assert.equal(Buffer.compare(bytesOf(ids['"9"']), bytesOf(ids['9'])), 0,
				'a numeric-string quality should build exactly the numeric-quality bytes');
			assert.notEqual(Buffer.compare(bytesOf(ids['"9"']), bytesOf(ids['11'])), 0,
				'quality 9 from a string must not clamp to 11 — a real quality of its own');
			assert.isAbove(bytesOf(ids['0']).length, bytesOf(ids['11']).length,
				'quality 0 is a real quality and should compress worse than 11');
			for (const quality of [11, 9, '9', 99, 'zzz', 0]) {
				assert.deepEqual(payloadOf(ids[JSON.stringify(quality)]),
					{ v: 1, type: 'http://sharejs.org/types/JSONv0', data },
					`the quality-${quality} entry should decompress to the same payload`);
			}
		});

		it('should percent-encode webstrate ids into a single flat file name (no path ' +
			'traversal)', async () => {
			const ids = ['a/b c?d', 'ü', '../../x'].map(trackId);
			fake.snapshot = snap(1);
			for (const id of ids) {
				snapshotCacheManager.scheduleRebuild(id, null);
				await waitFor(() => fs.existsSync(entryPath(id)), `the entry for "${id}"`);
			}
			// Set equality also proves containment: a path-traversing
			// implementation would not produce exactly these three names
			// INSIDE the cache dir — '../../x' lands as one flat encoded
			// file name, no subdirectories, nothing escaped.
			assert.deepEqual(fs.readdirSync(cacheDir).sort(),
				['%C3%BC.json.br', '..%2F..%2Fx.json.br', 'a%2Fb%20c%3Fd.json.br'],
				'ids should percent-encode into exactly one flat file name each');
			for (const id of ids) {
				assert.isNotNull(snapshotCacheManager.readEntry(id),
					'write and read should share the encoding');
			}
		});

		it('should write atomically: no .tmp leftovers across repeated builds, and readEntry ' +
			'never reads a planted .tmp', async () => {
			const id = newId();
			global.config.compressedSnapshotDebounceMs = 0;
			for (const v of [1, 2, 3]) {
				fake.snapshot = snap(v);
				snapshotCacheManager.scheduleRebuild(id, {});
				// Keyed on the DECOMPRESSED version advancing, not bare
				// existence: successive atomic writes race a bare existsSync.
				await waitFor(() => fs.existsSync(entryPath(id)) && payloadOf(id).v === v,
					`the v${v} build`);
			}
			assert.deepEqual(fs.readdirSync(cacheDir),
				[encodeURIComponent(id) + '.json.br'],
				'repeated builds should leave no .tmp residue');
			const finalBytes = fs.readFileSync(entryPath(id));
			// A crashed .tmp sibling is never read: readEntry reads only the
			// payload path.
			fs.writeFileSync(entryPath(id) + '.tmp' + process.pid, 'junk');
			assert.equal(Buffer.compare(snapshotCacheManager.readEntry(id), finalBytes), 0,
				'readEntry should ignore a .tmp sibling');
		});
	});

	describe('read and guard edges', function () {
		it('should return null from readEntry for a missing cache dir without creating it, ' +
			'and ignore falsy webstrate ids', async () => {
			const neverCreated = path.join(tmpBase, 'never-created-' + (++seq));
			global.config.compressedSnapshotCacheDir = neverCreated;
			assert.isNull(snapshotCacheManager.readEntry('anything'),
				'a read from a missing cache dir should be null, not a throw');
			snapshotCacheManager.scheduleRebuild('', {});
			snapshotCacheManager.scheduleRebuild(undefined, null);
			snapshotCacheManager.removeEntry('');
			snapshotCacheManager.removeEntry(null);
			assert.isNull(snapshotCacheManager.readEntry(''),
				'a falsy id should harmlessly probe the .json.br name and miss');
			await sleep(150); // nothing should have been armed — this is the proof
			assert.isFalse(fs.existsSync(neverCreated),
				'neither the read path nor the guards should create the directory');
			assert.lengthOf(fake.calls, 0, 'no build should have been attempted');
		});
	});
});
