// Document-handling benchmarks: creation, loading, reloads, snapshot fetches
// and op-log fetches — the "time to first element / time to document ready"
// family. Everything is measured inside the browser page (see bench.mjs):
// the phase timestamps come from a MutationObserver + event hooks installed
// before page scripts run, so they include the real client bootstrap, the
// websocket connection and the initial snapshot application.
//
// BATCH METHODOLOGY: a repetition does not load one document and call it a
// sample — it loads a BATCH of documents (sizes below) and the sample is the
// SUM of time-to-loaded over the batch, ≈5 s of processing per sample. The
// batch sizes were derived from the 2026-09-17 baseline run
// (results/perf-2026-09-17T12-11-54-933Z.json) as
// round(5000 ms / per-document median) so every benchmark measures ~5 s.
// The per-document phase medians (time to first element, …) are preserved in
// each benchmark's note, so no information from the old phase benchmarks is
// lost — only the headline number is now a 5-second batch total.
//
// These are measurements, not assertions: a test fails only if a document
// ends up in a wrong state (correctness), never for being slow.


import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import { record } from './report.mjs';
import {
	pageLoadBatchBenchmark, reloadBatchBenchmark, openWebstratePage,
	inPageBenchmark, PHASE_DERIVATIONS, median, launchOptions
} from './bench.mjs';

// Batch sizes: navigations per repetition (≈5 s of processing per sample).
const CREATE_DOCS = 20;   // creation ≈ 232 ms/doc → 20 × 232 ≈ 4.6 s
const SMALL_LOADS = 20;   // small load ≈ 238 ms/doc → 20 × 238 ≈ 4.8 s
const LARGE_LOADS = 7;    // large load ≈ 738 ms/doc → 7 × 738 ≈ 5.2 s
const RELOADS = 40;        // reload ≈ 118 ms/doc → 40 × 118 ≈ 4.7 s
// Snapshot fetches / getOps batches (sequential fetches per repetition).
const FETCHES = {
	small: { v: 600, json: 600 },          // ≈ 8.3 / 8.5 ms per fetch
	large: { v: 300, json: 240, raw: 160 } // ≈ 17.3 / 21.2 / 31.5 ms per fetch
};
const GETOPS = { small: 640, large: 160 }; // ≈ 7.8 / 32 ms per fetch

// Per-document phase medians for the note: what one navigation looked like
// inside the batch (the headline number is the batch total).
const phaseNote = (phases) => {
	const parts = [];
	for (const [name, derive] of Object.entries(PHASE_DERIVATIONS)) {
		const values = phases.map(derive).filter(v => Number.isFinite(v));
		if (values.length > 0) {
			parts.push(name + ' ' + median(values).toFixed(1));
		}
	}
	return 'per-document medians (ms): ' + parts.join(' · ');
};

describe('Performance: document handling', function() {
	// Each navigation adds ~0.4–1 s wall; batches run 4×. Plenty of headroom.
	this.timeout(900000);

	const ids = {
		create: [],
		small: 'perf-' + util.randomString() + '-small',
		large: 'perf-' + util.randomString() + '-large',
		reload: 'perf-' + util.randomString() + '-reload'
	};
	const url = id => config.server_address + id + '/';

	let browser;
	let seedPage;

	// Elements in the "large" document.
	const LARGE_ELEMENTS = 2000;

	before(async function() {
		// Shared launch options (protocolTimeout per repetition evaluate +
		// the 512 MB renderer V8 cap) — see launchOptions in bench.mjs.
		browser = await puppeteer.launch(launchOptions);

		// Seed the small document (a bit of content so the initial render has
		// something to paint), the reload document (same content, so the
		// reload benchmark loads a real small document) and the large one.
		const seedRows = (page) => page.evaluate(() => {
			const frag = document.createDocumentFragment();
			for (let i = 0; i < 20; i++) {
				const div = document.createElement('div');
				div.setAttribute('data-i', String(i));
				div.textContent = 'seed ' + i;
				frag.appendChild(div);
			}
			document.body.appendChild(frag);
			// Guarded dataSaved: a wedged client (dead websocket, ops never
			// acked) must fail the suite here instead of hanging it.
			return Promise.race([
				window.webstrate.dataSaved(),
				new Promise((_, reject) => setTimeout(() => reject(new Error(
					'seeding: dataSaved() did not resolve within 60 s — client wedged')), 60000))
			]);
		});

		seedPage = await openWebstratePage(browser, url(ids.small));
		await seedRows(seedPage);

		const reload = await openWebstratePage(browser, url(ids.reload));
		await seedRows(reload);
		await reload.close();

		const large = await openWebstratePage(browser, url(ids.large));
		await large.evaluate(async (count) => {
			// One big innerHTML op: the whole subtree is a single mutation.
			const html = Array.from({ length: count },
				(_, i) => `<div data-i="${i}" class="row">row ${i} <span>cell</span></div>`).join('');
			document.body.innerHTML = html;
			// Guarded dataSaved, as in seedRows.
			await Promise.race([
				window.webstrate.dataSaved(),
				new Promise((_, reject) => setTimeout(() => reject(new Error(
					'large-doc seeding: dataSaved() did not resolve within 60 s — client wedged')), 60000))
			]);
		}, LARGE_ELEMENTS);
		await large.close();

		// Give the tags/ops a moment to settle before measuring loads.
		await util.sleep(1);
	});

	after(async function() {
		// Delete every document this suite created (including per-navigation
		// creation ids) so repeated runs don't accumulate state in the database.
		// Cache stays off on the cleanup page: ?delete answers with a redirect
		// chain (→ / → /frontpage/), and a goto on a redirect whose target is
		// served from cache can hang forever (puppeteer bug, see
		// DOM-STRESS-FLAKE.md) — with cache disabled the chain is safe.
		const cleanup = await browser.newPage();
		await cleanup.setCacheEnabled(false);
		for (const id of [...ids.create, ids.small, ids.large, ids.reload]) {
			try {
				await cleanup.goto(url(id) + '?delete', { waitUntil: 'domcontentloaded', timeout: 10000 });
			} catch (err) {
				util.warn('Could not delete', id, '-', err.message);
			}
		}
		await cleanup.close();
		await browser.close();
	});

	it('measures creating 20 new documents (fresh page, fresh id each)', async function() {
		// Every navigation opens a never-before-used id: visiting it creates
		// the webstrate. A repetition creates CREATE_DOCS documents and the
		// sample is the summed time-to-loaded of all of them. Note: an empty
		// new document has no content, so the firstElement phase does not
		// fire — see bench.mjs.
		const prefix = 'perf-' + util.randomString() + '-create-';
		const reps = await pageLoadBatchBenchmark(browser, {
			navigations: CREATE_DOCS,
			url: (nav) => {
				const id = prefix + nav;
				ids.create.push(id);
				return url(id);
			}
		});
		assert.isTrue(reps.every(r => r.navigations === CREATE_DOCS),
			'every repetition should create all documents');
		record({
			group: 'document handling: creation (empty document)',
			name: `create ${CREATE_DOCS} documents — total time to document ready (sum over ${CREATE_DOCS} fresh pages)`,
			samples: reps.map(r => r.total),
			note: phaseNote(reps.flatMap(r => r.phases))
				+ '; visiting a new id creates the webstrate (empty docs have no firstElement phase)'
		});
	});

	it('measures loading an existing small document 20 times (fresh pages)', async function() {
		const reps = await pageLoadBatchBenchmark(browser,
			{ navigations: SMALL_LOADS, url: url(ids.small) });
		assert.isTrue(reps.every(r => r.navigations === SMALL_LOADS));
		record({
			group: 'document handling: existing document (small, ~20 elements)',
			name: `load small document ×${SMALL_LOADS} — total time to document ready (sum over ${SMALL_LOADS} fresh pages)`,
			samples: reps.map(r => r.total),
			note: phaseNote(reps.flatMap(r => r.phases))
				+ '; server renders the snapshot to HTML, then the client re-syncs over the websocket'
		});
	});

	it('measures loading a large document 7 times (fresh pages)', async function() {
		const reps = await pageLoadBatchBenchmark(browser,
			{ navigations: LARGE_LOADS, url: url(ids.large) });
		assert.isTrue(reps.every(r => r.navigations === LARGE_LOADS));
		record({
			group: 'document handling: existing document (large, 2000 elements)',
			name: `load large document ×${LARGE_LOADS} — total time to document ready (sum over ${LARGE_LOADS} fresh pages)`,
			samples: reps.map(r => r.total),
			note: phaseNote(reps.flatMap(r => r.phases))
				+ '; firstElement ≈ initial HTML parse; loaded includes the full ws re-sync'
		});
	});

	it('measures reloading an existing document 40 times (same page)', async function() {
		const page = await browser.newPage();
		await page.goto(url(ids.reload), { waitUntil: 'load', timeout: 30000 });
		const reps = await reloadBatchBenchmark(page,
			{ navigations: RELOADS, url: url(ids.reload) });
		await page.close();
		assert.isTrue(reps.every(r => r.navigations === RELOADS));
		record({
			group: 'document handling: reload (small document)',
			name: `reload small document ×${RELOADS} — total time to document ready (sum over ${RELOADS} reloads)`,
			samples: reps.map(r => r.total),
			note: phaseNote(reps.flatMap(r => r.phases))
				+ '; repeated navigations of one page/tab'
		});
	});

	it('measures snapshot fetches over HTTP from a connected client (small + large)', async function() {
		// Each repetition performs a batch of sequential fetches of the page's
		// own document (location.pathname), so the timed function is fully
		// self-contained; the nc= cache-buster keeps the browser from serving
		// the response from its cache. The sample is the wall time of the
		// whole batch.
		const fetchBench = async (label, id, queries) => {
			const page = await openWebstratePage(browser, url(id));
			for (const [q, n] of Object.entries(queries)) {
				const samples = await inPageBenchmark(page, {
					args: { q, n },
					run: async (i, a) => {
						for (let k = 0; k < a.n; k++) {
							const r = await fetch(location.pathname + '?' + a.q
								+ '&nc=' + Math.random(), { credentials: 'include' });
							const body = await r.text();
							// A benchmark must never time an error response (a 404 is
							// faster than a real fetch, i.e. garbage data), and a
							// dropped-and-recreated document answers ?v with version 0
							// and ?json/?raw with an empty snapshot — fail loudly on
							// both. (Caught a real incident 2026-09-17: a concurrent
							// harness run dropped this run's shared test DB mid-batch,
							// and 1600 fetches silently measured 404 latency.)
							if (!r.ok) {
								throw new Error('fetch ?' + a.q + ' -> HTTP ' + r.status
									+ ' — the suite must not measure error responses');
							}
							if ((a.q === 'v' || a.q === 'version')
								? !JSON.parse(body).version
								: body.length < 100) {
								throw new Error('fetch ?' + a.q + ' returned an empty '
									+ 'document: "' + body.slice(0, 60) + '"');
							}
						}
					}
				});
				record({
					group: 'document handling: snapshot fetches',
					name: `fetch snapshot (?${q}) ×${n} — ${label}`,
					samples: samples.map(s => s.ms),
					note: `${n} sequential HTTP fetches by a connected client; `
						+ `avg ${(median(samples.map(s => s.ms)) / n).toFixed(2)} ms per fetch`
				});
			}
			await page.close();
		};

		await fetchBench('small document (~20 elements)', ids.small, FETCHES.small);
		await fetchBench('large document (2000 elements)', ids.large, FETCHES.large);
	});

	it('measures fetching the op log over the websocket (getOps)', async function() {
		const page = await openWebstratePage(browser, url(ids.small));
		const getOpsBench = (n) => inPageBenchmark(page, {
			args: { n },
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					await new Promise((accept, reject) => {
						window.webstrate.getOps(0, undefined, (err, ops) => {
							if (err) return reject(err);
							// An empty op log means the document is missing or was
							// dropped and recreated — that is a wrong state, not a
							// fast response (see the fetch benchmarks above).
							if (!ops || !ops.length) {
								return reject(new Error('getOps returned an empty op log — '
									+ 'document missing or recreated'));
							}
							accept(ops);
						});
					});
				}
			}
		});

		const smallSamples = await getOpsBench(GETOPS.small);
		record({
			group: 'document handling: op log',
			name: `getOps(0, head) ×${GETOPS.small} — small document`,
			samples: smallSamples.map(s => s.ms),
			note: `${GETOPS.small} sequential op-log fetches; `
				+ `avg ${(median(smallSamples.map(s => s.ms)) / GETOPS.small).toFixed(2)} ms per fetch`
		});

		const large = await openWebstratePage(browser, url(ids.large));
		const largeSamples = await inPageBenchmark(large, {
			args: { n: GETOPS.large },
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					await new Promise((accept, reject) => {
						window.webstrate.getOps(0, undefined, (err, ops) => {
							if (err) return reject(err);
							if (!ops || !ops.length) {
								return reject(new Error('getOps returned an empty op log — '
									+ 'document missing or recreated'));
							}
							accept(ops);
						});
					});
				}
			}
		});
		record({
			group: 'document handling: op log',
			name: `getOps(0, head) ×${GETOPS.large} — large document`,
			samples: largeSamples.map(s => s.ms),
			note: `avg ${(median(largeSamples.map(s => s.ms)) / GETOPS.large).toFixed(2)} ms per fetch`
		});

		const opsFetched = await large.evaluate(() => new Promise((accept, reject) =>
			window.webstrate.getOps(0, undefined, (err, ops) => err ? reject(err) : accept(ops.length))));
		// The large document is created by one big op; sanity-check the log.
		assert.isAtLeast(opsFetched, 1, 'should fetch at least the creation ops');
		await large.close();
		await page.close();
	});
});
