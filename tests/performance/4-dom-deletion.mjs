// DOM-deletion benchmarks. As with the other DOM suites, every operation
// awaits `webstrate.dataSaved()`, so the timed work of a batch covers the
// full client → server → ack round trip for the op(s) the deletion produced.
//
// BATCH METHODOLOGY (see bench.mjs): one repetition = a batch of N deletion
// cycles sized so the timed work sums to ≈5 s (N derived from the 2026-09-17
// baseline, results/perf-2026-09-17T12-11-54-933Z.json).
//
// Deletions consume their fixture, so every benchmark here uses the
// selfTimed REFILL pattern: restore the fixture UNTIMED (awaiting dataSaved,
// so the next op starts from an acknowledged, pristine document — the same
// state the baseline measured each single op in) and time only the deletion
// itself; the sample is the sum of the timed segments. This also keeps the
// per-op document size identical to the baseline — op cost scales with
// document size, so draining one big fixture would quietly change what the
// benchmark measures.
//
// Op shapes, as in the baseline:
//   * per-op ack — every deletion awaited individually (full round trip);
//   * one ack per group — 100 removals, then one dataSaved (the op-creation
//     and server-commit pipeline, not per-op ping-pong).


import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import { record } from './report.mjs';
import { inPageBenchmark, openWebstratePage, median, launchOptions } from './bench.mjs';

// Batch sizes: deletion cycles per repetition (≈5 s of timed work each).
const REMOVE_ELEMENT = 550;     // ≈ 9.1 ms/op → 5.0 s
const REMOVE_TEXT = 560;       // ≈ 8.9 ms/op → 5.0 s
const REMOVE_SUBTREE = 470;    // ≈ 10.7 ms/op → 5.0 s
const REMOVE_100_SEQ = 76;     // ≈ 65.8 ms/100-op group → 5.0 s
const REMOVE_100KB_TEXT = 270; // ≈ 18.8 ms/op → 5.1 s
const WIPE_BODY = 175;         // ≈ 28.8 ms/op → 5.0 s
const REMOVE_FROM_2000 = 125; // ≈ 40.6 ms/op → 5.1 s

describe('Performance: DOM deletion', function() {
	this.timeout(600000);

	const webstrateId = 'perf-' + util.randomString() + '-delete';
	const url = config.server_address + webstrateId + '/';

	let browser, page;

	// Page-global fixture builders (serialized functions may reference page
	// globals but not their definition scope).
	const installPerf = () => page.evaluate(() => {
		window.__perf = {
			// N simple rows.
			rows(n) {
				const html = Array.from({ length: n },
					(_, i) => `<div id="row-${i}" class="row" data-i="${i}">row ${i} text</div>`)
					.join('');
				document.body.innerHTML = html;
			},
			// One #tree parent with n children.
			tree(n) {
				const html = Array.from({ length: n },
					(_, i) => `<span>leaf ${i}</span>`).join('');
				document.body.innerHTML = `<div id="tree">${html}</div>`;
			},
			// One <pre id="big"> with a 100 KB text child.
			bigText() {
				document.body.innerHTML = '<pre id="big"></pre>';
				document.getElementById('big')
					.appendChild(document.createTextNode('x'.repeat(100 * 1024)));
			},
			// Look up a fixture element, tolerating the rare client resync
			// that rebuilds the DOM right after an acknowledgement (seen
			// under heavy load). Throws with diagnostics if the fixture
			// never appears, so failures explain themselves.
			async get(id) {
				for (let t = 0; t < 60; t++) {
					const el = document.getElementById(id);
					if (el) return el;
					await new Promise(r => setTimeout(r, 25));
				}
				throw new Error('perf fixture "' + id + '" missing; body has '
					+ document.body.childNodes.length + ' children: '
					+ document.body.innerHTML.slice(0, 120));
			}
		};
	});

	before(async function() {
		// Shared launch options (protocolTimeout per repetition evaluate +
		// the 512 MB renderer V8 cap) — see launchOptions in bench.mjs.
		browser = await puppeteer.launch(launchOptions);
	});

	// A FRESH PAGE PER BENCHMARK: a client that wedges mid-benchmark (dead
	// websocket, wedged dataSaved, hung renderer under load) poisons every
	// later benchmark on the same page — teardown never ran, the DOM is
	// mid-state, and a resync can revert fixtures. One page per benchmark
	// contains the damage to that benchmark's own numbers.
	beforeEach(async function() {
		page = await openWebstratePage(browser, url);
		await installPerf();
	});

	afterEach(async function() {
		// Tolerant close: the heap watchdog in inPageBenchmark may already
		// have closed (and killed) this benchmark's page.
		await page.close().catch(() => {});
	});

	after(async function() {
		// Delete the webstrate on a cache-disabled cleanup page — ?delete
		// redirects through / to /frontpage/, and a goto on a redirect whose
		// target is served from cache can hang forever (puppeteer bug, see
		// DOM-STRESS-FLAKE.md).
		const cleanup = await browser.newPage();
		await cleanup.setCacheEnabled(false);
		await cleanup.goto(url + '?delete', { waitUntil: 'domcontentloaded' })
			.catch(() => {});
		await cleanup.close();
		await browser.close();
	});

	// Record helper: samples are per-repetition batch totals (ms), the note
	// keeps the per-op view visible.
	const recordBatch = (name, n, samples, note) => record({
		group: 'DOM deletion', name, samples: samples.map(s => s.ms),
		note: `${n} ops per repetition; avg ${(median(samples.map(s => s.ms)) / n).toFixed(2)} ms per op`
			+ (note ? '; ' + note : '')
	});

	it('removes single elements, 550 times (550 op round-trips)', async function() {
		// Self-timed refill: the baseline measured removing one element from
		// a 1-element document; draining a 550-element document would change
		// the per-op cost (op cost scales with document size). Each cycle
		// therefore re-appends the row UNTIMED and times only its removal.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_ELEMENT },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					if (k > 0) {
						// Untimed refill: re-append the removed row (1 op).
						const el = document.createElement('div');
						el.id = 'row-0';
						el.className = 'row';
						el.setAttribute('data-i', '0');
						el.textContent = 'row 0 text';
						document.body.appendChild(el);
						await window.__dataSaved();
					}
					const t = performance.now();
					document.body.removeChild(await window.__perf.get('row-0'));
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove single element ×${REMOVE_ELEMENT} (${REMOVE_ELEMENT} op round-trips)`,
			REMOVE_ELEMENT, samples, 're-appending the row between removals is untimed');
	});

	it('removes single text nodes, 560 times (560 op round-trips)', async function() {
		// Self-timed refill, mirroring the baseline's single <p>some text</p>
		// fixture: each cycle restores the text node UNTIMED and times only
		// its removal from the one-element document.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_TEXT },
			setup: async () => {
				document.body.innerHTML = '<p id="p">some text</p>';
				await window.__dataSaved();
			},
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					if (k > 0) {
						// Untimed refill: put the text node back (1 op).
						const p = await window.__perf.get('p');
						p.appendChild(document.createTextNode('some text'));
						await window.__dataSaved();
					}
					const t = performance.now();
					const p = await window.__perf.get('p');
					p.removeChild(p.firstChild);
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove single text node ×${REMOVE_TEXT} (${REMOVE_TEXT} op round-trips)`,
			REMOVE_TEXT, samples, 'restoring the text node between removals is untimed');
	});

	it('removes a 100-child subtree, 470 times (470 ops)', async function() {
		// Self-timed refill: rebuild the #tree fixture untimed, time only
		// its removal (one op each cycle).
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_SUBTREE },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill: a fresh #tree with 100 children (1 op).
					document.body.innerHTML =
						'<div id="tree">' + '<span>leaf</span>'.repeat(100) + '</div>';
					await window.__dataSaved();
					const t = performance.now();
					document.body.removeChild(await window.__perf.get('tree'));
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove subtree with 100 children ×${REMOVE_SUBTREE} (${REMOVE_SUBTREE} ops)`,
			REMOVE_SUBTREE, samples, 'rebuilding the subtree between removals is untimed');
	});

	it('removes 100 elements sequentially, 76 times (7600 ops)', async function() {
		// Self-timed refill: 100 rows are created untimed per cycle; the timed
		// segment removes all 100 (100 ops) and awaits one ack — the
		// op-creation and server-commit pipeline, as in the baseline.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_100_SEQ },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill.
					window.__perf.rows(100);
					await window.__dataSaved();
					const t = performance.now();
					while (document.body.firstChild) {
						document.body.removeChild(document.body.firstChild);
					}
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove 100 elements sequentially ×${REMOVE_100_SEQ} (7600 ops, 1 ack per 100)`,
			REMOVE_100_SEQ * 100, samples,
			'mirror of insert-100-sequential: same content, deletions');
	});

	it('removes a 100 KB text node, 270 times (270 ops)', async function() {
		// Self-timed refill: the heavy fixture (a <pre> with a 100 KB text
		// child — one big insert op) is rebuilt untimed; only its removal is
		// timed.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_100KB_TEXT },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill.
					window.__perf.bigText();
					await window.__dataSaved();
					const t = performance.now();
					document.body.removeChild(await window.__perf.get('big'));
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove 100 KB text node ×${REMOVE_100KB_TEXT} (${REMOVE_100KB_TEXT} ops)`,
			REMOVE_100KB_TEXT, samples, 'rebuilding the 100 KB fixture is untimed');
	});

	it('wipes the body via innerHTML, 175 times (100 elements present)', async function() {
		// Self-timed refill: 100 rows created untimed per cycle; the timed op
		// is the one-op body wipe.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: WIPE_BODY },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill.
					window.__perf.rows(100);
					await window.__dataSaved();
					const t = performance.now();
					document.body.innerHTML = '';
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`wipe body via innerHTML ×${WIPE_BODY} (100 elements, ${WIPE_BODY} ops)`,
			WIPE_BODY, samples);
	});

	it('removes one element from a 2000-element document, 125 times', async function() {
		// The 2000-row fixture is built untimed once per repetition; each
		// cycle removes #row-1000 (timed) and re-appends it (untimed refill),
		// so every op hits the same large-document state as the baseline.
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_FROM_2000 },
			setup: async () => {
				window.__perf.rows(2000);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					if (k > 0) {
						// Untimed refill: re-append the removed row (1 op).
						const el = document.createElement('div');
						el.id = 'row-1000';
						el.className = 'row';
						el.setAttribute('data-i', '1000');
						el.textContent = 'row 1000 text';
						document.body.appendChild(el);
						await window.__dataSaved();
					}
					const t = performance.now();
					document.body.removeChild(await window.__perf.get('row-1000'));
					await window.__dataSaved();
					ms += performance.now() - t;
				}
				return ms;
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`remove 1 element from 2000-element doc ×${REMOVE_FROM_2000} (${REMOVE_FROM_2000} ops)`,
			REMOVE_FROM_2000, samples,
			'per-op cost of deleting in a large document; re-appending the row is untimed');
	});

	it('document is empty and consistent after the benchmarks', async function() {
		const state = await page.evaluate(async () => {
			document.body.innerHTML = '';
			await window.__dataSaved();
			return {
				empty: document.body.innerHTML.trim() === '',
				loaded: window.webstrate.loaded
			};
		});
		assert.isTrue(state.empty, 'body should be empty after cleanup');
		assert.isTrue(state.loaded, 'webstrate should still be loaded');
	});
});
