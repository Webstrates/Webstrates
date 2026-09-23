// DOM-insertion benchmarks. All mutations go through the real client
// pipeline (MutationObserver → op creation → ShareDB submit → server ack),
// and every operation awaits `webstrate.dataSaved()`, so the timed work of a
// batch contains the full client → server → acknowledgement round trip for
// the op(s) each mutation produced.
//
// BATCH METHODOLOGY (see bench.mjs): one repetition = a batch of N insertion
// cycles, sized so the timed work sums to ≈5 s (N derived from the
// 2026-09-17 baseline, results/perf-2026-09-17T12-11-54-933Z.json; the
// baseline measured each single op against a freshly emptied body). To keep
// every op hitting the same document state as the baseline — instead of
// letting N inserts accumulate in one ever-growing document — each cycle
// first restores the fixture UNTIMED (wipe the body, await ack) and only the
// insertion itself (plus its ack) is timed; the benchmarks therefore run in
// selfTimed mode and `run` returns the sum of its timed segments.
//
// Two op shapes are distinguished, as in the baseline:
//   * sequential mutations — N separate elements, each its own op;
//   * one-shot large changes — a single mutation (e.g. innerHTML) that
//     produces one big op.


import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import { record } from './report.mjs';
import { inPageBenchmark, openWebstratePage, median, launchOptions } from './bench.mjs';

// Batch sizes: insertion cycles per repetition (≈5 s of timed work each).
const APPEND_ELEMENT = 400;    // ≈ 12.6 ms/op → 5.0 s
const APPEND_TEXT = 500;        // ≈ 10.2 ms/op → 5.1 s
const APPEND_COMPOSITE = 450;   // ≈ 11.1 ms/op → 5.0 s
const INSERT_10 = 300;          // ≈ 16.9 ms/batch-of-10 → 5.1 s
const INSERT_100_SEQ = 105;     // ≈ 47.6 ms/batch-of-100 → 5.0 s
const INSERT_100_HTML = 140;    // ≈ 35.6 ms/big-op → 5.0 s
const DEEP_SUBTREE = 40;        // ≈ 128.2 ms/op → 5.1 s
const LARGE_TEXT = 80;          // ≈ 64.2 ms/op → 5.1 s

describe('Performance: DOM insertion', function() {
	this.timeout(600000);

	const webstrateId = 'perf-' + util.randomString() + '-insert';
	const url = config.server_address + webstrateId + '/';

	let browser, page;

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

	// Shared body reset: wipe the body and wait for the server to ack, so
	// every repetition starts from a pristine document.
	const wipe = async () => {
		await page.evaluate(async () => {
			document.body.innerHTML = '';
			await window.__dataSaved();
		});
	};

	// Record helper: samples are per-repetition batch totals; the note shows
	// the per-op average so the old single-op view stays visible.
	const recordBatch = (name, n, samples, note) => record({
		group: 'DOM insertion', name, samples: samples.map(s => s.ms),
		note: `${n} ops per repetition; avg ${(median(samples.map(s => s.ms)) / n).toFixed(2)} ms per op`
			+ (note ? '; ' + note : '')
	});

	it('appends single elements (400 op round-trips)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: APPEND_ELEMENT },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill: empty body, as in the baseline.
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const el = document.createElement('div');
					el.textContent = 'hello';
					document.body.appendChild(el);
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
		recordBatch(`append single element ×${APPEND_ELEMENT} (${APPEND_ELEMENT} op round-trips)`,
			APPEND_ELEMENT, samples, 'create+insert one <div> with text, await server ack');
	});

	it('appends single text nodes (500 op round-trips)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: APPEND_TEXT },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					document.body.appendChild(document.createTextNode('some text'));
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
		recordBatch(`append single text node ×${APPEND_TEXT} (${APPEND_TEXT} op round-trips)`,
			APPEND_TEXT, samples);
	});

	it('appends elements with attributes and children (450 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: APPEND_COMPOSITE },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const el = document.createElement('section');
					el.setAttribute('class', 'box');
					el.setAttribute('data-flag', 'on');
					for (let c = 0; c < 3; c++) {
						const p = document.createElement('p');
						p.textContent = 'child ' + c;
						el.appendChild(p);
					}
					document.body.appendChild(el);
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
		recordBatch(`append element with attributes + 3 children ×${APPEND_COMPOSITE} (${APPEND_COMPOSITE} ops)`,
			APPEND_COMPOSITE, samples);
	});

	it('inserts 10 elements sequentially, 300 times (3000 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: INSERT_10 },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill: empty body before each batch of 10.
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const frag = document.createDocumentFragment();
					for (let c = 0; c < 10; c++) {
						const el = document.createElement('div');
						el.textContent = 'n' + c;
						frag.appendChild(el);
					}
					// Fragment insertion produces one mutation record per inserted
					// child (each becomes its own op), one dataSaved for all.
					document.body.appendChild(frag);
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
		recordBatch(`insert 10 elements sequentially ×${INSERT_10} (3000 ops, 1 ack per 10)`,
			INSERT_10, samples, 'each timed segment is a 10-op fragment insert + one ack');
	});

	it('inserts 100 elements sequentially, 105 times (10500 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: INSERT_100_SEQ },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const frag = document.createDocumentFragment();
					for (let c = 0; c < 100; c++) {
						const el = document.createElement('div');
						el.setAttribute('data-i', String(c));
						el.textContent = 'n' + c;
						frag.appendChild(el);
					}
					document.body.appendChild(frag);
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
		recordBatch(`insert 100 elements sequentially ×${INSERT_100_SEQ} (10500 ops, 1 ack per 100)`,
			INSERT_100_SEQ, samples);
	});

	it('inserts 100 elements via innerHTML, 140 times (140 large ops)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: INSERT_100_HTML },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill: wipe the 100 rows the previous cycle left.
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const html = Array.from({ length: 100 },
						(_, c) => `<div data-i="${c}" class="row">row ${c}</div>`).join('');
					document.body.innerHTML = html;
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
		recordBatch(`insert 100 elements via innerHTML ×${INSERT_100_HTML} (${INSERT_100_HTML} large ops)`,
			INSERT_100_HTML, samples,
			'compare with insert-100-sequential: same content, one op instead of 100');
	});

	it('inserts a deep subtree (5 levels × 5 children), 40 times', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: DEEP_SUBTREE },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const build = (depth) => {
						const el = document.createElement('div');
						el.setAttribute('data-depth', String(depth));
						if (depth > 0) {
							for (let c = 0; c < 5; c++) el.appendChild(build(depth - 1));
						} else {
							el.textContent = 'leaf';
						}
						return el;
					};
					document.body.appendChild(build(4));
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
		recordBatch(`insert deep subtree (5 levels × 5 children) ×${DEEP_SUBTREE} (${DEEP_SUBTREE} ops)`,
			DEEP_SUBTREE, samples);
	});

	it('appends a large text node (100 KB), 80 times', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: LARGE_TEXT },
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					document.body.innerHTML = '';
					await window.__dataSaved();
					const t = performance.now();
					const pre = document.createElement('pre');
					pre.appendChild(document.createTextNode('x'.repeat(100 * 1024)));
					document.body.appendChild(pre);
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
		recordBatch(`append 100 KB text node ×${LARGE_TEXT} (${LARGE_TEXT} ops)`,
			LARGE_TEXT, samples);
	});

	it('document is empty and consistent after the benchmarks', async function() {
		await wipe();
		const state = await page.evaluate(() => ({
			empty: document.body.innerHTML.trim() === '',
			loaded: window.webstrate.loaded
		}));
		assert.isTrue(state.empty, 'body should be empty after cleanup');
		assert.isTrue(state.loaded, 'webstrate should still be loaded');
	});
});
