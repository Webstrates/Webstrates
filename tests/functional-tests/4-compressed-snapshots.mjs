// Compressed snapshot cache (compressedSnapshots) — functional tests.
//
// The feature caches brotli-compressed document snapshots server-side
// (helpers/SnapshotCacheManager.js) and serves them to clients over the
// per-webstrate websocket (the fetchSnapshot custom action in
// middleware/customActionHandlerMiddleware.js), so the full JsonML snapshot
// never crosses the wire uncompressed on load. The env-var/config-merge
// mechanics of the feature flags are covered by tests/functional-tests/
// 4-env-vars.mjs and tests/unit-tests/env-vars-test.mjs; the manager's own
// semantics are covered by tests/unit-tests/snapshot-cache-test.mjs. These
// tests cover what only real server processes can prove: the afterWrite
// wiring from committed ops (create/edit/delete), the fetchSnapshot wire
// protocol on the raw websocket (binary hit framing, miss reply shape,
// token validation, the missing-d silence), both delete paths (sharedb del
// op and the HTTP ?delete route), disabled-mode behavior, and the
// end-to-end browser fast path (ingest of the compressed snapshot plus
// ops-since-v catch-up, the client fallbacks for undecodable and
// wrong-shaped cache entries, and the transclusion skip), observed through
// CDP websocket frame capture.
//
// Three server instances are booted: the feature on with a 300 ms debounce
// and a 700 ms staleness bound, the feature off (whose cache directory must
// stay empty forever — the shipped client bundle still attempts the fast
// path because its flag is baked in at build time), and the feature on with
// an 8 s debounce (so an entry can be held stale across a browser reload).
// All three run against one private per-run database (see DB_NAME below).
import { assert } from 'chai';
import fs from 'fs';
import path from 'path';
import zlib from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
// Note: ESM can't import the lib/client directory subpath, hence the
// explicit index.js (the package has no "exports" restrictions).
import sharedb from 'sharedb/lib/client/index.js';
import harness from '../lib/server-harness.mjs';
import util from '../util.js';
import puppeteer from 'puppeteer';
import { MongoClient } from 'mongodb';

// The ShareDB client can't consume the webstrates-specific 'wa' messages
// (hello, tags, assets, ...) the server may send, so silence the expected
// "Ignoring unrecognized message" noise while keeping other warnings visible.
{
	const warn = sharedb.logger.warn.bind(sharedb.logger);
	sharedb.logger.setMethods({
		info: () => {},
		warn: (...args) => {
			if (args[0] === 'Ignoring unrecognized message') return;
			warn(...args);
		}
	});
}

// A server instance's redirected snapshot-cache directory (the harness
// always points generated configs at a private per-instance directory) and
// the entry file names inside it.
const entryPath = (server, webstrateId) =>
	path.join(server.config.compressedSnapshotCacheDir,
		encodeURIComponent(webstrateId) + '.json.br');

const entryPayload = (server, webstrateId) =>
	JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(entryPath(server, webstrateId))));

// All three instances below share one PRIVATE per-run database. The harness's
// base config points every generated instance at the shared `webstrate-test`
// database — which every other run of this suite (and, on a shared MongoDB,
// any other checkout's suite) also uses and drops on runner teardown. Sharing
// that name made results flap when a neighbor's teardown dropped the database
// mid-run: documents vanished underneath the tests and debounced builds
// failed silently. The suffix keeps the required `webstrate-test` prefix
// while making the name unique per run, and after() drops it again.
const DB_NAME = 'webstrate-test-snapcache-' + process.pid + '-' + util.randomString(6);
const DB_URL = 'mongodb://127.0.0.1:27017/' + DB_NAME;

// Wait up to `budget` ms (default 5 s, 200 ms steps) for `predicate`.
const waitFor = async (predicate, what, budget = 5000, step = 200) => {
	const deadline = Date.now() + budget;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(step);
	}
	if (predicate()) return;
	assert.fail(what);
};

// Run a document action over a ShareDB connection to the webstrate's
// websocket endpoint. Awaiting a callback is settled state: the afterWrite
// hooks (which feed the snapshot cache) run before the acknowledgement.
const withDoc = (address, webstrateId, fn) => new Promise((resolve, reject) => {
	const ws = new WebSocket(address.replace(/^http/, 'ws') + webstrateId);
	ws.on('error', reject);
	const connection = new sharedb.Connection(ws);
	connection.on('connected', () => {
		(async () => {
			try {
				await fn(connection.get('webstrates', webstrateId));
				resolve();
			} catch (err) {
				reject(err);
			} finally {
				ws.close();
			}
		})();
	});
});

const docAction = (doc, action) => new Promise((resolve, reject) => {
	action(doc, (err) => (err ? reject(err) : resolve()));
});

// Create a document through a ShareDB client, the way the browser client
// does (json0 with non-empty data: the cache stores nothing for documents
// without type and data).
const createWebstrate = (address, webstrateId, data) =>
	withDoc(address, webstrateId, (doc) =>
		docAction(doc, (d, cb) => d.create(data, 'json0', cb)));

// Talk the raw websocket protocol: open a socket on the webstrate route
// `routeId`, send `message` immediately on open (the server buffers and
// replays early frames), and collect every frame until one correlates with
// `message.token` — the only correlation the protocol has — or `waitMs`
// elapses. Returns { frames, reply }: reply is the correlated Buffer
// (binary hit), the parsed JSON object (miss / error reply), or null
// (nothing correlated arrived; silence tests inspect the frames instead).
// Every socket receives three on-connect announcements before any reply — the
// webstrates {wa:'version'} hello, the {wa:'peerconfig'} STUN/TURN announcement
// (middleware/peerConfigMiddleware.js; every socket gets one, the sample's
// default) and the ShareDB {a:'init'} handshake (see payloadFrames) — all
// uncorrelated, all simply staying in `frames`.
const wsRequest = (server, routeId, message, waitMs = 700) => new Promise((resolve) => {
	const frames = [];
	const ws = new WebSocket(server.address.replace(/^http/, 'ws') + routeId);
	const tokenString = message.token === undefined ? null : String(message.token);
	const replyTo = (buf) => {
		if (tokenString !== null && buf.length > 1 && buf[0] === 1
			&& buf[1] === Buffer.byteLength(tokenString)
			&& buf.slice(2, 2 + buf[1]).toString('utf8') === tokenString) return buf;
		try {
			const parsed = JSON.parse(buf.toString('utf8'));
			if (parsed && tokenString !== null && parsed.token === message.token) return parsed;
		} catch { /* not JSON */ }
		return null;
	};
	let settled = false;
	const finish = (reply) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		try { ws.close(); } catch { /* already closed */ }
		resolve({ frames, reply });
	};
	let timer;
	ws.on('error', () => {});
	ws.on('open', () => ws.send(JSON.stringify(message)));
	ws.on('message', (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		frames.push(buf);
		const reply = replyTo(buf);
		if (reply) finish(reply);
	});
	timer = setTimeout(() => finish(null), waitMs);
});

const fetchSnapshot = (server, targetId, token, routeId = targetId) =>
	wsRequest(server, routeId, { wa: 'fetchSnapshot', d: targetId, token });

// Every webstrate socket receives THREE frames on connect, before any
// request: the {wa:'version'} announcement (middleware/versionMiddleware.js),
// the {wa:'peerconfig'} STUN/TURN announcement every socket gets with the
// sample's default (middleware/peerConfigMiddleware.js), and the ShareDB
// server handshake {a:'init', protocol, protocolMinor, id} that share.listen
// emits for the ShareDB connection the socket could host (the raw protocol
// tests never use one). This filters all three announcements out of the
// frames a wsRequest collected, leaving exactly the frames the fetchSnapshot
// request itself produced.
const payloadFrames = (frames) => frames.filter((buf) => {
	try {
		const parsed = JSON.parse(buf.toString('utf8'));
		return !(parsed
			&& (parsed.wa === 'version' || parsed.wa === 'peerconfig' || parsed.a === 'init'));
	} catch {
		return true; // binary frames are never announcements
	}
});

// Parsed JSON of the received text frames (unparseable frames map to null).
const parseText = (frames) => frames.text.map((text) => {
	try { return JSON.parse(text); } catch { return null; }
});

describe('Compressed snapshot cache (compressedSnapshots)', function () {
	this.timeout(90000);

	let serverOn, serverOff, serverStale, browser;
	let warmDocId;
	const tracked = []; // { server, id } — deleted through ?delete in after()
	const recordedPages = [];

	const track = (server, id) => {
		tracked.push({ server, id });
		return id;
	};

	// A puppeteer page whose websocket frames are recorded through the Chrome
	// DevTools Protocol (puppeteer 25 removed the page.on('websocket') frame
	// events; CDP still reports both directions): every sent frame (text,
	// JSON), and every received frame split into binary (opcode 2, base64
	// payload) and text (opcode 1). A fresh page is created per navigation so
	// each recording covers exactly one load.
	const newRecordedPage = async () => {
		const page = await browser.newPage();
		const cdp = await page.createCDPSession();
		await cdp.send('Network.enable');
		const frames = { sent: [], binary: [], text: [] };
		cdp.on('Network.webSocketFrameSent', (params) =>
			frames.sent.push(params.response.payloadData));
		cdp.on('Network.webSocketFrameReceived', (params) => {
			if (params.response.opcode === 2) {
				frames.binary.push(Buffer.from(params.response.payloadData, 'base64'));
			} else {
				frames.text.push(params.response.payloadData);
			}
		});
		recordedPages.push(page);
		return { page, frames };
	};

	const waitForLoaded = (page) =>
		util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 10);

	before(async () => {
		// Feature on, a short debounce so cache entries appear quickly, and a
		// short staleness bound for the mid-burst rebuild test. The sample
		// defaults provide compressedSnapshots: true and quality 11. All
		// three instances get the private per-run database (see DB_NAME).
		serverOn = await harness.startServer({
			label: 'snapcache',
			config: {
				db: DB_URL,
				compressedSnapshotDebounceMs: 300,
				compressedSnapshotMaxStalenessMs: 700
			}
		});
		// Feature off at runtime: every fetchSnapshot must miss forever and
		// the redirected cache directory must never even be created. A SHORT
		// debounce puts a wrongly-armed op-path rebuild well inside the
		// disabled-mode tests' 800 ms observation windows — the sample's
		// 5000 ms default would let a broken isEnabled gate on the op path
		// fire only long after both !existsSync asserts had passed.
		serverOff = await harness.startServer({
			label: 'snapcache-off',
			config: { db: DB_URL, compressedSnapshots: false, compressedSnapshotDebounceMs: 300 }
		});
		// Long debounce so a cache entry can be held stale across a browser
		// reload (the ops-since-v catch-up test).
		serverStale = await harness.startServer({
			label: 'snapcache-stale',
			config: { db: DB_URL, compressedSnapshotDebounceMs: 8000 }
		});
		browser = await puppeteer.launch();

		// The read-only warm fixture: a settled v2 document with a cache
		// entry, reused by the wire-protocol tests. It never changes again.
		warmDocId = track(serverOn, 'test-' + util.randomString());
		await withDoc(serverOn.address, warmDocId, async (doc) => {
			await docAction(doc, (d, cb) =>
				d.create(['body', 'created by the compressed-snapshots tests'], 'json0', cb));
			await docAction(doc, (d, cb) => d.fetch(cb));
			await docAction(doc, (d, cb) => d.submitOp([{ p: [1], li: ' and edited' }], cb));
		});
		await waitFor(() => fs.existsSync(entryPath(serverOn, warmDocId))
			&& entryPayload(serverOn, warmDocId).v === 2, 'the warm fixture cache entry');
	});

	after(async () => {
		// A failed before() runs this with nothing set up: every step guards
		// itself. Pages first, then the browser, then the documents (through
		// the ?delete route, which also removes each cache entry — a
		// permission-restricted document answers 403 to an anonymous delete,
		// harmlessly), then every server, and finally the suite's own
		// database (the runner's teardown only drops the base-config name,
		// never this run's private one, so dropping it here is on us).
		for (const page of recordedPages) await page.close().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		for (const { server, id } of tracked) {
			await fetch(`${server.address}${id}/?delete`, { redirect: 'manual' }).catch(() => {});
		}
		await harness.stopAll().catch(() => {});
		const client = new MongoClient(DB_URL, { serverSelectionTimeoutMS: 3000 });
		try {
			await client.connect();
			await client.db(DB_NAME).dropDatabase();
		} catch {
			// Best-effort teardown: a leftover database is inert.
		} finally {
			await client.close().catch(() => {});
		}
	});

	describe('cache lifecycle through real ops', function () {
		it('should write a cache entry for the settled document with the final {v, type, ' +
			'data} after ops settle', async () => {
			const id = track(serverOn, 'test-' + util.randomString());
			await withDoc(serverOn.address, id, async (doc) => {
				await docAction(doc, (d, cb) =>
					d.create(['body', 'created by the compressed-snapshots tests'], 'json0', cb));
				// afterWrite fired before the acknowledgement, but it only
				// armed the 300 ms debounce: the timer cannot have elapsed.
				assert.isFalse(fs.existsSync(entryPath(serverOn, id)),
					'no entry right after the create: the rebuild is debounced, not inline');
				await docAction(doc, (d, cb) => d.fetch(cb));
				await docAction(doc, (d, cb) => d.submitOp([{ p: [1], li: ' and edited' }], cb));
			});
			await waitFor(() => fs.existsSync(entryPath(serverOn, id))
				&& entryPayload(serverOn, id).v === 2, 'the entry for the settled document');
			assert.deepEqual(entryPayload(serverOn, id), {
				v: 2,
				type: 'http://sharejs.org/types/JSONv0',
				data: ['body', ' and edited', 'created by the compressed-snapshots tests']
			}, 'both ops should coalesce into one entry holding the settled head');
			// Secondary build-completed evidence from the server log.
			assert.include(fs.readFileSync(serverOn.logFile, 'utf8'),
				`SnapshotCache: stored "${id}" v2 (`);
		});

		it('should rebuild mid-burst while ops keep arriving (staleness bound through real ' +
			'ops)', async function() {
			const id = track(serverOn, 'test-' + util.randomString());
			await withDoc(serverOn.address, id, async (doc) => {
				await docAction(doc, (d, cb) => d.create(['body', 'base-text'], 'json0', cb));
				let sawMid = false;
				let midV = 0;
				let previous = Date.now();
				let maxGap = 0;
				for (let i = 0; i < 14; i++) {
					await docAction(doc, (d, cb) => d.submitOp([{ p: [1], li: 'op' + i }], cb));
					const gapEnd = Date.now();
					maxGap = Math.max(maxGap, gapEnd - previous);
					previous = gapEnd;
					if (!sawMid && fs.existsSync(entryPath(serverOn, id))) {
						sawMid = true;
						midV = entryPayload(serverOn, id).v;
					}
					await sleep(100);
				}
				// If any op-to-op gap exceeded 250 ms, the 300 ms debounce could
				// have fired mid-burst on its own — the asserts below would then
				// misattribute a quiet-window build to the staleness bound. The op round-trips
				// themselves can
				// stretch past the window — a property of the machine, not of the
				// cache — so skip rather than report a bogus failure.
				if (maxGap > 250) {
					util.warn('mid-burst rebuild test skipped: op round-trips stretched ' +
						'to ' + maxGap + ' ms — too slow for the debounce-window premise');
					return this.skip();
				}
				assert.isTrue(sawMid,
					'an entry should exist while ops are still being submitted');
				assert.isAtLeast(midV, 2,
					'the mid-burst entry was rebuilt from an intermediate version');
				assert.isAtMost(midV, 14,
					'the mid-burst entry predates the last ops');
				await waitFor(() => fs.existsSync(entryPath(serverOn, id))
					&& entryPayload(serverOn, id).v === 15, 'the final entry');
				// Each op inserts at index 1, so the array folds to
				// ['body', op13, …, op0, 'base-text'].
				const expected = ['body'];
				for (let i = 13; i >= 0; i--) expected.push('op' + i);
				expected.push('base-text');
				assert.deepEqual(entryPayload(serverOn, id).data, expected,
					'the final entry should hold the head state');
			});
		});
	});

	describe('fetchSnapshot wire protocol', function () {
		it('should serve a cache hit as ONE binary frame [0x01][tokenLen][token][brotli ' +
			'payload]', async () => {
			// A dedicated raw socket, so no ShareDB connection ever sees the
			// binary frame.
			const { frames, reply } = await fetchSnapshot(serverOn, warmDocId, 'tok12345');
			assert.isNotNull(reply, 'the warm entry should be served');
			assert.isTrue(Buffer.isBuffer(reply), 'the reply should be one binary frame');
			assert.equal(reply[0], 1, 'marker byte');
			assert.equal(reply[1], 8, 'uint8 token byte length');
			assert.equal(reply.subarray(2, 10).toString('utf8'), 'tok12345',
				'the token should be echoed byte-exact');
			// The frame payload is the cache file VERBATIM — no
			// re-compression, no envelope padding.
			assert.equal(Buffer.compare(reply.subarray(10),
				fs.readFileSync(entryPath(serverOn, warmDocId))), 0,
			'the frame payload should be the cache file, byte for byte');
			assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(reply.subarray(10))), {
				v: 2,
				type: 'http://sharejs.org/types/JSONv0',
				data: ['body', ' and edited', 'created by the compressed-snapshots tests']
			});
			// Exactly one payload frame — the binary reply itself (duplicated
			// sends would show more). The three on-connect announcements are
			// filtered out by payloadFrames.
			assert.equal(payloadFrames(frames).length, 1,
				'besides the three on-connect announcements, only the reply should be on the socket');
		});

		it('should answer a miss with {wa:"reply", token} (no reply/error field), rebuild the ' +
			'entry lazily, and hit on re-fetch', async () => {
			const id = track(serverOn, 'test-' + util.randomString());
			await createWebstrate(serverOn.address, id, ['body', 'miss-rebuild probe']);
			await waitFor(() => fs.existsSync(entryPath(serverOn, id))
				&& entryPayload(serverOn, id).v === 1, 'the warm entry');
			// The warm build completed and no rebuild is pending: removing
			// the file makes the next fetch a genuine miss.
			fs.rmSync(entryPath(serverOn, id));
			const miss = await fetchSnapshot(serverOn, id, 'misstok1');
			// deepEqual pins the ABSENCE of both `reply` and `error` keys —
			// the shape the client reply-matcher maps to a genuine miss.
			assert.deepEqual(miss.reply, { wa: 'reply', token: 'misstok1' });
			// The entry file reappears with NO op in between: only the miss
			// branch lazy rebuild can have rewritten it (the 300 ms debounce
			// cannot be the cause — no op fired after the unlink).
			await waitFor(() => fs.existsSync(entryPath(serverOn, id)), 'the lazy rebuild');
			const hit = await fetchSnapshot(serverOn, id, 'hittok2');
			assert.isTrue(Buffer.isBuffer(hit.reply) && hit.reply[0] === 1,
				'the re-fetch should hit');
			assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(
				hit.reply.subarray(2 + hit.reply[1]))), entryPayload(serverOn, id),
			'the warm-after-miss payload should match the rebuilt entry');
		});

		it('should stay completely silent for falsy tokens (missing, empty string, 0): no ' +
			'reply, no rebuild', async () => {
			// A wrongly-scheduled lazy rebuild would rewrite the entry
			// BYTE-IDENTICALLY (same settled document, deterministic brotli
			// at quality 11), so the entry FILE cannot prove the absence —
			// but every completed rebuild appends a stored line to the server
			// log, and only the warm fixture's own rebuilds mention it. Count
			// the warm fixture's stored lines before and after: a rebuild that
			// ran in between would have appended one.
			const storedLine = `SnapshotCache: stored "${warmDocId}"`;
			const storedLineCount = () =>
				fs.readFileSync(serverOn.logFile, 'utf8').split(storedLine).length - 1;
			const before = storedLineCount();
			const requests = [
				{ wa: 'fetchSnapshot', d: warmDocId }, // token absent
				{ wa: 'fetchSnapshot', d: warmDocId, token: '' },
				{ wa: 'fetchSnapshot', d: warmDocId, token: 0 }
			];
			for (const message of requests) {
				const { frames, reply } = await wsRequest(serverOn, warmDocId, message);
				assert.isNull(reply, 'nothing should correlate: no reply of any kind');
				// Not even an error frame: the falsy-token break runs before
				// readEntry (the on-connect announcements are filtered out).
				assert.equal(payloadFrames(frames).length, 0,
					'nothing but the three on-connect announcements should be on the socket');
			}
			// The break also skipped scheduleRebuild: not one stored line for
			// the warm fixture was appended. (F3/F4 prove this exact socket
			// pattern gets replies with valid tokens, so the silence is not
			// vacuous.)
			assert.equal(storedLineCount(), before,
				'no lazy rebuild should have run for the warm fixture');
		});

		it('should serve 255-byte tokens, reject 256-byte ones with an invalid-token error, ' +
			'and measure the token in UTF-8 bytes', async () => {
			const entry = fs.readFileSync(entryPath(serverOn, warmDocId));
			const reply255 = await fetchSnapshot(serverOn, warmDocId, 'a'.repeat(255));
			assert.isTrue(Buffer.isBuffer(reply255.reply), '255 bytes is the inclusive boundary');
			assert.equal(reply255.reply[1], 255);
			assert.equal(reply255.reply.subarray(2, 257).toString('utf8'), 'a'.repeat(255));
			assert.equal(Buffer.compare(reply255.reply.subarray(257), entry), 0);

			const reply256 = await fetchSnapshot(serverOn, warmDocId, 'a'.repeat(256));
			assert.deepEqual(reply256.reply,
				{ wa: 'reply', token: 'a'.repeat(256), error: 'Invalid token.' },
				'the token should be echoed verbatim with the exact error and no reply field');

			// 128 chars of a two-byte character are 256 UTF-8 BYTES: the byte
			// length decides, not the char count (a naive .length check would
			// serve this token).
			const multiOver = await fetchSnapshot(serverOn, warmDocId, 'é'.repeat(128));
			assert.deepEqual(multiOver.reply,
				{ wa: 'reply', token: 'é'.repeat(128), error: 'Invalid token.' });

			const multiOk = await fetchSnapshot(serverOn, warmDocId, 'é'.repeat(127));
			assert.isTrue(Buffer.isBuffer(multiOk.reply), '254 bytes should be served');
			assert.equal(multiOk.reply[1], 254);
			assert.equal(multiOk.reply.subarray(2, 256).toString('utf8'), 'é'.repeat(127),
				'the multi-byte token should round-trip byte-exact');
		});

		it('PIN (check order): an over-long token gets the plain miss reply on a cold cache ' +
			'but the invalid-token error on a warm one', async () => {
			// Pins the CURRENT ordering (readEntry precedes the token length
			// check): client-visible behavior for an invalid token depends on
			// cache state — reported as a consistency finding.
			const idCold = track(serverOn, 'test-' + util.randomString());
			await createWebstrate(serverOn.address, idCold, ['body', 'cold-order probe']);
			await waitFor(() => fs.existsSync(entryPath(serverOn, idCold))
				&& entryPayload(serverOn, idCold).v === 1, 'the cold document to warm once');
			fs.rmSync(entryPath(serverOn, idCold)); // cold again, no pending rebuild
			const over = 'z'.repeat(300);
			// The cold request goes FIRST, so its own lazy rebuild cannot warm
			// the cache before the reply is sent.
			const replyCold = await fetchSnapshot(serverOn, idCold, over);
			assert.deepEqual(replyCold.reply, { wa: 'reply', token: over },
				'a cold cache gives the plain miss reply (no error key)');
			const replyWarm = await fetchSnapshot(serverOn, warmDocId, over);
			assert.deepEqual(replyWarm.reply,
				{ wa: 'reply', token: over, error: 'Invalid token.' },
				'the same token on a warm cache gets the error reply');
			// The miss branch still scheduled its lazy rebuild, oversize
			// token notwithstanding.
			await waitFor(() => fs.existsSync(entryPath(serverOn, idCold)),
				'the lazy rebuild after the cold miss');
		});

		it('should gate fetchSnapshot on read permission: silent to the client while the ' +
			'cache still builds', async () => {
			const restrictedId = track(serverOn, 'test-' + util.randomString());
			// Anonymous clients may create; the data-auth attribute in the
			// created document then restricts every permission for everyone
			// but the (nonexistent) named user.
			await withDoc(serverOn.address, restrictedId, async (doc) => {
				await docAction(doc, (d, cb) => d.create(['html', {
					'data-auth': JSON.stringify([{
						username: 'snapcache-restricted',
						provider: 'test',
						permissions: 'rw'
					}])
				}, ['head'], ['body', 'restricted content']], 'json0', cb));
			});
			// The cache build is NOT permission-gated (afterWrite fires for
			// every committed op): the build/serve asymmetry.
			await waitFor(() => fs.existsSync(entryPath(serverOn, restrictedId)),
				'the cache entry of the restricted document');
			const { frames, reply } = await wsRequest(serverOn, restrictedId,
				{ wa: 'fetchSnapshot', d: restrictedId, token: 'atok1234' }, 700);
			assert.isNull(reply, 'no frame should correlate: the gate produces silence');
			assert.equal(payloadFrames(frames).length, 0,
				'not even an error frame: an unauthorized client must not learn whether the cache is warm');
			// Server-side evidence that the request ARRIVED and was gated,
			// making the silence non-vacuous.
			assert.include(fs.readFileSync(serverOn.logFile, 'utf8'),
				'Insufficient read permissions in fetchSnapshot call');
		});

		it('should serve the webstrate named in data.d, not the route id of the socket ' +
			'(consistency pin)', async () => {
			// The socket route is a random id that was never a document.
			const routeId = track(serverOn, 'test-' + util.randomString());
			const { reply } = await fetchSnapshot(serverOn, warmDocId, 'crossdoc1', routeId);
			assert.isTrue(Buffer.isBuffer(reply), 'the target snapshot should be served');
			assert.equal(reply[0], 1);
			assert.equal(Buffer.compare(reply.subarray(2 + reply[1]),
				fs.readFileSync(entryPath(serverOn, warmDocId))), 0,
			'the target and the permission check used the client-supplied data.d');
			// Consistency note: the sharedb path is stricter by design
			// (ShareDBWrapper demands an access token when the ids differ);
			// the shipped client only ever sends its own id.
		});

		it('should stay silent on a fetchSnapshot without data.d: the request dies at the ' +
			'permission gate (never reaching the cache)', async () => {
			// With no d, getUserPermissions(undefined) throws before the
			// fetchSnapshot case runs: the rejecting async middleware is
			// nobody's responsibility in runMiddleware, so the server logs an
			// unhandled rejection and the client gets NOTHING (the same
			// silence an older server without the handler produces — the
			// client's 2 s timeout path).
			const rejectionLine = 'Missing webstrateId';
			const rejectionCount = () =>
				fs.readFileSync(serverOn.logFile, 'utf8').split(rejectionLine).length - 1;
			const before = rejectionCount();
			const { frames, reply } = await wsRequest(serverOn, warmDocId,
				{ wa: 'fetchSnapshot', token: 'nodtok1' }, 700);
			assert.isNull(reply, 'nothing should correlate: no reply of any kind');
			assert.equal(payloadFrames(frames).length, 0,
				'silence only — not even an error frame (the request never reaches a ws.send)');
			// The silence is not vacuous: the rejection reached the server
			// log, so the request demonstrably arrived and died at the gate.
			await waitFor(() => rejectionCount() > before,
				'the Missing-webstrateId rejection to be logged');
			const log = fs.readFileSync(serverOn.logFile, 'utf8');
			const at = log.lastIndexOf(rejectionLine);
			assert.include(log.slice(Math.max(0, at - 600), at + 30), 'Unhandled rejection',
				'the request should be logged as an unhandled rejection, not answered');
			// And nothing phantom was cached under the coerced id: the
			// manager's falsy-id guard holds (the throw happens first, so
			// this also pins that no other path caches it).
			assert.isFalse(fs.existsSync(
				path.join(serverOn.config.compressedSnapshotCacheDir, 'undefined.json.br')),
			'no entry may be written for a missing webstrate id');
		});
	});

	describe('invalidation through deletes', function () {
		it('should drop the entry immediately on a sharedb del op and then report a miss',
			async () => {
				const id = track(serverOn, 'test-' + util.randomString());
				await createWebstrate(serverOn.address, id, ['body', 'del-op probe']);
				await waitFor(() => fs.existsSync(entryPath(serverOn, id)), 'the warm entry');
				await withDoc(serverOn.address, id, async (doc) => {
					await docAction(doc, (d, cb) => d.fetch(cb));
					await docAction(doc, (d, cb) => d.del(cb));
					// afterWrite ran before the del acknowledgement — the del
					// branch unlinks synchronously.
					assert.isFalse(fs.existsSync(entryPath(serverOn, id)),
						'the entry should be gone right after the del op');
				});
				await sleep(700); // > 2x the 300 ms debounce
				assert.isFalse(fs.existsSync(entryPath(serverOn, id)),
					'the entry should stay gone (no surviving pending rebuild)');
				const { reply } = await fetchSnapshot(serverOn, id, 'del-op-1');
				assert.deepEqual(reply, { wa: 'reply', token: 'del-op-1' },
					'the next fetchSnapshot should report a miss');
			});

		it('should drop the entry on the HTTP ?delete route (the non-sharedb delete path)',
			async () => {
				const id = track(serverOn, 'test-' + util.randomString());
				await createWebstrate(serverOn.address, id, ['body', 'http-delete probe']);
				await waitFor(() => fs.existsSync(entryPath(serverOn, id)), 'the warm entry');
				const response = await fetch(`${serverOn.address}${id}/?delete`,
					{ redirect: 'manual' });
				// The exact redirect status is an incidental detail of the
				// route; any 3xx behaves identically for every client.
				assert.oneOf(response.status, [301, 302, 303, 307, 308],
					'the delete route should answer with a redirect');
				// deleteWebstrate calls removeEntry BEFORE res.redirect — the
				// entry is gone by the time the response completes. This delete
				// never went through sharedb, so afterWrite never saw it.
				assert.isFalse(fs.existsSync(entryPath(serverOn, id)),
					'the entry should be gone when the response completes');
				await sleep(700);
				assert.isFalse(fs.existsSync(entryPath(serverOn, id)));
				const { reply } = await fetchSnapshot(serverOn, id, 'httpdel1');
				assert.deepEqual(reply, { wa: 'reply', token: 'httpdel1' },
					'the next fetchSnapshot should report a plain miss');
			});

		it('should start the cache over (v resets to 1) when a deleted webstrate is ' +
			'recreated', async () => {
			const id = track(serverOn, 'test-' + util.randomString());
			await createWebstrate(serverOn.address, id, ['body', 'first life']);
			await waitFor(() => fs.existsSync(entryPath(serverOn, id))
				&& entryPayload(serverOn, id).v === 1, 'the entry of the first life');
			await fetch(`${serverOn.address}${id}/?delete`, { redirect: 'manual' });
			await waitFor(() => !fs.existsSync(entryPath(serverOn, id)),
				'the entry to be gone after the delete');
			await createWebstrate(serverOn.address, id, ['body', 'second life']);
			await waitFor(() => fs.existsSync(entryPath(serverOn, id))
				&& entryPayload(serverOn, id).v === 1, 'the recreated entry');
			// The HTTP delete wiped the op log (deleteOps), so the recreate
			// starts at v0 -> v1 with the NEW content — a non-reset v here
			// would be the ghost signature.
			assert.deepEqual(entryPayload(serverOn, id), {
				v: 1,
				type: 'http://sharejs.org/types/JSONv0',
				data: ['body', 'second life']
			});
			// The sharedb-del-then-recreate variant (op log retained,
			// version continues) is deliberately not tested: version
			// continuation is sharedb semantics, not this feature.
		});

		it('should miss and never write an entry for a nonexistent webstrate', async () => {
			const ghostId = track(serverOn, 'test-' + util.randomString()); // never created
			const cacheDir = serverOn.config.compressedSnapshotCacheDir;
			const before = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
			const { reply } = await fetchSnapshot(serverOn, ghostId, 'ghost01');
			assert.deepEqual(reply, { wa: 'reply', token: 'ghost01' },
				'a nonexistent webstrate is a plain miss');
			await sleep(1000); // 10x the real duration of the lazy build attempt
			const after = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
			assert.isFalse(after.some((name) => name.includes(encodeURIComponent(ghostId))),
				'no phantom entry should be created for an id with no document');
			assert.equal(after.length, before.length,
				'the cache directory should hold exactly what it held before');
		});
	});

	describe('disabled server', function () {
		it('should never write entries or create the cache directory, and always reply ' +
			'with a miss (no lazy rebuild either)', async () => {
			const id = track(serverOff, 'test-' + util.randomString());
			await createWebstrate(serverOff.address, id, ['body', 'disabled-mode probe']);
			await sleep(800);
			// The harness redirects the directory but never creates it: only
			// a build running ensureCacheDir ever does.
			assert.isFalse(fs.existsSync(serverOff.config.compressedSnapshotCacheDir),
				'a disabled server should never even create the cache directory');
			const { reply } = await fetchSnapshot(serverOff, id, 'offmode1');
			assert.deepEqual(reply, { wa: 'reply', token: 'offmode1' },
				'a disabled server answers misses forever (never silence, never binary)');
			await sleep(800); // the lazy rebuild would be immediate if wrongly enabled
			assert.isFalse(fs.existsSync(serverOff.config.compressedSnapshotCacheDir),
				'even the lazy rebuild of the miss should never have run');
		});
	});

	describe('edge cache states', function () {
		it('should treat a 0-byte entry file as a hit: envelope-only binary frame and no ' +
			'repair (pins the empty-entry defect)', async () => {
			// Pins the truthy-Buffer quirk: an empty entry is a "hit", so the
			// client gets an envelope-only frame and the miss branch lazy
			// rebuild (the only repair path) never runs — the broken entry
			// stays broken until an op arrives. The client itself falls back
			// correctly (its byteLength === 0 check), so this pins
			// availability-of-warmth, not correctness.
			const id = track(serverOn, 'test-' + util.randomString());
			await createWebstrate(serverOn.address, id, ['body', 'zero-byte probe']);
			await waitFor(() => fs.existsSync(entryPath(serverOn, id))
				&& entryPayload(serverOn, id).v === 1, 'the warm entry');
			fs.writeFileSync(entryPath(serverOn, id), Buffer.alloc(0));
			const { reply } = await fetchSnapshot(serverOn, id, 'zerobyte');
			assert.isTrue(Buffer.isBuffer(reply), 'the empty entry is still a hit');
			assert.equal(reply.length, 2 + 8,
				'the frame should be envelope-only: marker + token length + token');
			assert.equal(reply[0], 1);
			assert.equal(reply[1], 8);
			assert.equal(reply.subarray(2, 10).toString('utf8'), 'zerobyte');
			await sleep(1000); // 3x the debounce: a hypothetical repair had time to land
			assert.equal(fs.statSync(entryPath(serverOn, id)).size, 0,
				'the hit path schedules no rebuild — nothing repairs the empty entry');
		});
	});

	describe('browser fast path', function () {
		// docA is created by the warm-hit test and reused (read-only) by the
		// corrupt-entry test; the latter re-verifies its own precondition.
		let docA;

		it('should load a warm document through the compressed fast path: binary hit, ' +
			'snapshot ingested, ops-only subscribe (no uncompressed snapshot on the wire)',
		async () => {
			docA = track(serverOn, 'test-' + util.randomString());
			await withDoc(serverOn.address, docA, async (doc) => {
				// The full html shape the browser itself creates, so the
				// client does no restructuring ops on load.
				await docAction(doc, (d, cb) =>
					d.create(['html', ['head'], ['body', 'warm-hit marker content']],
						'json0', cb));
			});
			await waitFor(() => fs.existsSync(entryPath(serverOn, docA))
					&& entryPayload(serverOn, docA).v === 1, 'the warm entry of docA');
			// Captured before the goto, with no connection open: nothing
			// can rewrite the file in between, so the byte-compare is
			// stable.
			const entryBytes = fs.readFileSync(entryPath(serverOn, docA));
			const { page, frames } = await newRecordedPage();
			try {
				await page.goto(serverOn.address + docA + '/', { waitUntil: 'networkidle2' });
				assert.isTrue(await waitForLoaded(page), 'the page should load');

				// The bundle-baked serverConfig.compressedSnapshots flag
				// made the client attempt the fast path (eligibility is
				// build-time, not server-driven).
				const sent = frames.sent.map((text) => {
					try { return JSON.parse(text); } catch { return null; }
				});
				assert.isTrue(sent.some((msg) =>
					msg && msg.wa === 'fetchSnapshot' && msg.d === docA),
				'the client should have requested the compressed snapshot');

				// The server sent the cache file verbatim.
				assert.isAtLeast(frames.binary.length, 1, 'a binary hit frame should arrive');
				const hit = frames.binary[0];
				assert.equal(hit[0], 1, 'marker byte');
				assert.isAtLeast(hit[1], 1);
				assert.isAtMost(hit[1], 255);
				assert.equal(Buffer.compare(hit.subarray(2 + hit[1]), entryBytes), 0,
					'the binary frame should carry the cache file verbatim');

				// The subscribe reply carries ops only — the snapshot
				// never crossed the wire again.
				const subscribes = parseText(frames).filter((msg) => msg && msg.a === 's');
				assert.isAtLeast(subscribes.length, 1, 'a subscribe reply should arrive');
				assert.notProperty(subscribes[0], 'data',
					'the subscribe reply should carry no snapshot data (ops-only)');

				// The uncompressed JsonML never crossed the wire either
				// (the core promise of the feature).
				assert.isFalse(frames.text.some((text) =>
					text.includes('warm-hit marker content')),
				'the marker content should never appear in a text frame');

				assert.equal(await page.evaluate(() => window.webstrate.version), 1,
					'the ingested version should be the version of the entry');
				assert.include(await page.evaluate(() => document.body.textContent),
					'warm-hit marker content');
			} finally {
				await page.close().catch(() => {});
			}
		});

		it('should fall back to a normal subscribe when the cached payload does not decode ' +
			'(corrupt entry)', async () => {
			// The same docA as the warm-hit test: its entry is still warm at
			// v1 and no op has fired since (that page was read-only).
			await waitFor(() => fs.existsSync(entryPath(serverOn, docA))
				&& entryPayload(serverOn, docA).v === 1, 'docA still warm at v1');
			// 64 bytes of 0x07: definitely not brotli, guaranteed undecodable.
			fs.writeFileSync(entryPath(serverOn, docA), Buffer.alloc(64, 7));
			const { page, frames } = await newRecordedPage();
			try {
				await page.goto(serverOn.address + docA + '/', { waitUntil: 'networkidle2' });
				assert.isTrue(await waitForLoaded(page), 'the page should load anyway');

				// The server still HIT (readEntry serves file bytes verbatim;
				// the decode failure is purely client-side).
				assert.isAtLeast(frames.binary.length, 1, 'the garbage entry is still a hit');
				const garbage = frames.binary[0];
				assert.equal(Buffer.compare(garbage.subarray(2 + garbage[1]),
					Buffer.alloc(64, 7)), 0, 'the garbage bytes should be served verbatim');

				// The EXACT OPPOSITE signature of the warm-hit test, so the
				// pair is self-checking: the full snapshot re-crossed the wire
				// in the normal subscribe.
				const subscribes = parseText(frames).filter((msg) => msg && msg.a === 's');
				assert.isAtLeast(subscribes.length, 1);
				assert.property(subscribes[0], 'data',
					'the fallback subscribe should carry the full snapshot data');

				assert.include(await page.evaluate(() => document.body.textContent),
					'warm-hit marker content',
					'the page should still load correctly via the fallback');
			} finally {
				await page.close().catch(() => {});
			}
		});

		it('should fall back to a normal subscribe when the cached payload DECODES but has ' +
			'the wrong shape (v not a number, data not an array, not JSON)', async () => {
			// The corrupt-entry test covers undecodable bytes (the catch in
			// decodeBrotliPayload); these cover the SHAPE checks in
			// tryIngestCompressedSnapshot: valid brotli, decodable, but a
			// payload the client must refuse to ingest.
			const variants = [
				{ label: 'v as a string',
					payload: JSON.stringify({ v: '1', type: 'http://sharejs.org/types/JSONv0',
						data: ['body', 'shape probe'] }) },
				{ label: 'data not an array',
					payload: JSON.stringify({ v: 1, type: 'http://sharejs.org/types/JSONv0',
						data: 'not-an-array' }) },
				{ label: 'not JSON at all',
					payload: 'this is not json, merely valid brotli bytes' }
			];
			for (const variant of variants) {
				const id = track(serverOn, 'test-' + util.randomString());
				await withDoc(serverOn.address, id, async (doc) => {
					await docAction(doc, (d, cb) =>
						d.create(['html', ['head'], ['body', 'shape-fallback marker']],
							'json0', cb));
				});
				await waitFor(() => fs.existsSync(entryPath(serverOn, id))
					&& entryPayload(serverOn, id).v === 1, `the warm entry (${variant.label})`);
				const planted = zlib.brotliCompressSync(variant.payload);
				fs.writeFileSync(entryPath(serverOn, id), planted);
				const { page, frames } = await newRecordedPage();
				try {
					await page.goto(serverOn.address + id + '/', { waitUntil: 'networkidle2' });
					assert.isTrue(await waitForLoaded(page),
						`the page should load anyway (${variant.label})`);
					// The server still HIT: readEntry serves file bytes
					// verbatim — refusing the payload is purely client-side.
					assert.isAtLeast(frames.binary.length, 1,
						`the invalid-shape entry is still a hit (${variant.label})`);
					assert.equal(Buffer.compare(
						frames.binary[0].subarray(2 + frames.binary[0][1]), planted), 0,
					`the planted bytes should be served verbatim (${variant.label})`);
					// The same fallback signature as the corrupt-entry test:
					// the full snapshot re-crosses the wire.
					const subscribes = parseText(frames).filter((msg) => msg && msg.a === 's');
					assert.isAtLeast(subscribes.length, 1);
					assert.property(subscribes[0], 'data',
						`the fallback subscribe should carry the full snapshot (${variant.label})`);
					assert.include(await page.evaluate(() => document.body.textContent),
						'shape-fallback marker',
						`the page should load correctly via the fallback (${variant.label})`);
					assert.equal(await page.evaluate(() => window.webstrate.version), 1,
						`the client should hold the document head (${variant.label})`);
				} finally {
					await page.close().catch(() => {});
				}
			}
		});

		it('should converge from a stale-but-valid entry via ops-since-v catch-up (ingest ' +
			'at v, subscribe from v, ops replayed)', async () => {
			const docB = track(serverStale, 'test-' + util.randomString());
			await withDoc(serverStale.address, docB, async (doc) => {
				await docAction(doc, (d, cb) =>
					d.create(['html', ['head'], ['body', 'stale-base-marker']], 'json0', cb));
			});
			// The create debounced build fires at ~8 s. A miss while an
			// op-debounce is pending would be SKIPPED, so waiting out the
			// debounce is the only deterministic warm path — hence a
			// dedicated long-debounce instance for this one test.
			await waitFor(() => fs.existsSync(entryPath(serverStale, docB))
				&& entryPayload(serverStale, docB).v === 1,
			'the debounced entry of docB', 12000);
			await withDoc(serverStale.address, docB, async (doc) => {
				await docAction(doc, (d, cb) => d.fetch(cb));
				await docAction(doc, (d, cb) =>
					d.submitOp([{ p: [2, 1], li: 'stale-edit-A' }], cb));
				await docAction(doc, (d, cb) =>
					d.submitOp([{ p: [2, 2], li: 'stale-edit-B' }], cb));
			});
			// Both acknowledgements are settled state: the document is at v3,
			// while the 8 s debounce re-armed by the last op has ~8 s left.
			assert.equal(entryPayload(serverStale, docB).v, 1,
				'the entry is STALE — the document is at v3');
			const { page, frames } = await newRecordedPage();
			try {
				await page.goto(serverStale.address + docB + '/', { waitUntil: 'networkidle2' });
				assert.isTrue(await waitForLoaded(page), 'the page should load');

				const sent = frames.sent.map((text) => {
					try { return JSON.parse(text); } catch { return null; }
				});
				assert.isTrue(sent.some((msg) =>
					msg && msg.wa === 'fetchSnapshot' && msg.d === docB),
				'the client should have requested the compressed snapshot');

				assert.isAtLeast(frames.binary.length, 1, 'the stale entry is served as a hit');
				const served = JSON.parse(zlib.brotliDecompressSync(
					frames.binary[0].subarray(2 + frames.binary[0][1])));
				assert.equal(served.v, 1, 'the served entry is the stale v1 one');

				const messages = parseText(frames);
				const subscribes = messages.filter((msg) => msg && msg.a === 's');
				assert.isAtLeast(subscribes.length, 1);
				assert.notProperty(subscribes[0], 'data',
					'the subscribe should be ops-only (no snapshot again)');
				assert.isAtLeast(messages.filter((msg) => msg && msg.a === 'op').length, 1,
					'the ops since v should be replayed');

				assert.equal(await page.evaluate(() => window.webstrate.version), 3,
					'the client should have caught up to head');
				const body = await page.evaluate(() => document.body.textContent);
				assert.include(body, 'stale-base-marker');
				assert.include(body, 'stale-edit-A');
				assert.include(body, 'stale-edit-B',
					'the DOM should converge through ops-since-v catch-up');
				// The captured HIT frame above (served.v === 1 against a
				// document at v3) is the proof that the served entry was
				// stale; no on-disk assert follows — the ops re-armed the
				// 8 s debounce, and re-reading the file here would race a
				// rebuild on a slow page-load.
			} finally {
				await page.close().catch(() => {});
			}
		});

		it('should still load pages on a disabled server: the baked client flag attempts ' +
			'the fast path, always misses, falls back', async () => {
			const docC = track(serverOff, 'test-' + util.randomString());
			await withDoc(serverOff.address, docC, async (doc) => {
				await docAction(doc, (d, cb) =>
					d.create(['html', ['head'], ['body', 'disabled-server marker']], 'json0', cb));
			});
			const { page, frames } = await newRecordedPage();
			try {
				await page.goto(serverOff.address + docC + '/', { waitUntil: 'networkidle2' });
				assert.isTrue(await waitForLoaded(page), 'the page should load');
				// The bundle-BAKED flag makes the client attempt the fast path
				// regardless of the runtime config of the server (the client
				// cannot know it is disabled).
				const sent = frames.sent.map((text) => {
					try { return JSON.parse(text); } catch { return null; }
				});
				assert.isTrue(sent.some((msg) =>
					msg && msg.wa === 'fetchSnapshot' && msg.d === docC),
				'the client should still attempt the fast path');
				assert.equal(frames.binary.length, 0, 'a disabled server can never hit');
				assert.include(await page.evaluate(() => document.body.textContent),
					'disabled-server marker',
					'the page should load correctly via the miss fallback');
			} finally {
				await page.close().catch(() => {});
			}
			// Any wrongly-triggered build (which would be immediate) had
			// time to land and provably did not.
			assert.isFalse(fs.existsSync(serverOff.config.compressedSnapshotCacheDir),
				'nothing should ever be written');
		});

		it('should recreate a fresh document (not a ghost) when loading a deleted webstrate',
			async () => {
				const docD = track(serverOn, 'test-' + util.randomString());
				await withDoc(serverOn.address, docD, async (doc) => {
					await docAction(doc, (d, cb) =>
						d.create(['html', ['head'], ['body', 'ghost-check-marker']], 'json0', cb));
				});
				await waitFor(() => fs.existsSync(entryPath(serverOn, docD))
					&& entryPayload(serverOn, docD).v === 1, 'the warm entry of docD');
				// The entry was built and idle long before the delete: no
				// in-flight build can resurrect it (that race is unit-pinned
				// and reported, not e2e-tested).
				await fetch(`${serverOn.address}${docD}/?delete`, { redirect: 'manual' });
				await waitFor(() => !fs.existsSync(entryPath(serverOn, docD)),
					'the entry to be gone after the delete');
				const { page, frames } = await newRecordedPage();
				try {
					await page.goto(serverOn.address + docD + '/', { waitUntil: 'networkidle2' });
					assert.isTrue(await waitForLoaded(page),
						'the client should miss and auto-create a fresh document');
					// A miss, not a ghost hit.
					assert.equal(frames.binary.length, 0,
						'the load should have been a miss, not a ghost hit');
					assert.notInclude(await page.evaluate(() => document.body.textContent),
						'ghost-check-marker',
						'no ghost content should come from any cache');
				} finally {
					await page.close().catch(() => {});
				}
				// The browser create op settles through the 300 ms debounce
				// and a fresh entry appears — the clean-path counterpart of
				// the ghost race.
				await waitFor(() => fs.existsSync(entryPath(serverOn, docD))
					&& entryPayload(serverOn, docD).v === 1, 'the fresh skeleton entry');
				const payload = entryPayload(serverOn, docD);
				assert.equal(payload.v, 1, 'the fresh entry is at v1');
				assert.equal(payload.data[0], 'html',
					'the fresh entry holds the new skeleton (a higher v or the old content ' +
					'would be the ghost signature)');
			});

		it('should skip the fast path for a transcluded (iframed) webstrate: no ' +
				'fetchSnapshot for the child, its snapshot crosses the wire uncompressed',
		async () => {
			// The second half of the client's eligibility rule: the
			// bundle-baked flag is true, but isTranscluded()
			// disqualifies the child — it must load through a normal
			// full-snapshot subscribe on its OWN websocket
			// (reuseWebsocket is false by default).
			const docInner = track(serverOn, 'test-' + util.randomString());
			const docOuter = track(serverOn, 'test-' + util.randomString());
			await withDoc(serverOn.address, docInner, async (doc) => {
				await docAction(doc, (d, cb) =>
					d.create(['html', ['head'], ['body', 'transcluded-child-marker']],
						'json0', cb));
			});
			// Both documents warm: the fast path is AVAILABLE to the
			// child and still not attempted.
			await waitFor(() => fs.existsSync(entryPath(serverOn, docInner))
						&& entryPayload(serverOn, docInner).v === 1, 'the child warm entry');
			await withDoc(serverOn.address, docOuter, async (doc) => {
				await docAction(doc, (d, cb) =>
					d.create(['html', ['head'], ['body',
						['iframe', { src: serverOn.address + docInner + '/' }]]],
					'json0', cb));
			});
			await waitFor(() => fs.existsSync(entryPath(serverOn, docOuter))
						&& entryPayload(serverOn, docOuter).v === 1, 'the parent warm entry');
			const { page, frames } = await newRecordedPage();
			try {
				await page.goto(serverOn.address + docOuter + '/',
					{ waitUntil: 'networkidle2' });
				assert.isTrue(await waitForLoaded(page), 'the parent should load');
				// The child is a same-origin iframe (same process, same
				// page target): whatever websocket IT opens is captured
				// here too.
				const childLoaded = await util.waitForFunction(page, () => {
					const iframe = document.querySelector('iframe');
					return iframe && iframe.contentWindow
								&& iframe.contentWindow.webstrate
								&& iframe.contentWindow.webstrate.loaded;
				}, 10);
				assert.isTrue(childLoaded, 'the transcluded child should load');

				const sent = frames.sent.map((text) => {
					try { return JSON.parse(text); } catch { return null; }
				});
				// The PARENT (not transcluded) attempted its own fast
				// path — proof the capture sees websocket frames on
				// this page.
				assert.isTrue(sent.some((msg) =>
					msg && msg.wa === 'fetchSnapshot' && msg.d === docOuter),
				'the parent should have attempted the fast path');
				// The transcluded child did not — from any frame of
				// the page.
				assert.isFalse(sent.some((msg) =>
					msg && msg.wa === 'fetchSnapshot' && msg.d === docInner),
				'a transcluded client must skip the fast path');
				// Non-vacuity: the child's own load traffic IS in this
				// capture — its full snapshot crossed the wire
				// uncompressed (the by-design counterpart).
				assert.isTrue(frames.text.some((text) =>
					text.includes('transcluded-child-marker')),
				'the child snapshot should have crossed the wire as a text frame');
				assert.equal(await page.evaluate(() =>
					document.querySelector('iframe').contentDocument.body.textContent),
				'transcluded-child-marker',
				'the child document should be rendered in the iframe');
			} finally {
				await page.close().catch(() => {});
			}
		});
	});
});
