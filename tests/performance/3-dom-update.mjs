// DOM-update benchmarks: attribute changes, text changes, element moves
// and wholesale replaces. Every operation (or coherent group of operations)
// is followed by `await window.__dataSaved()` — the timed work of a
// batch therefore covers the full client → server → ack round trip.
//
// BATCH METHODOLOGY (see bench.mjs): one repetition = a batch of N operation
// cycles sized so the timed work sums to ≈5 s (N derived from the
// 2026-09-17 baseline, results/perf-2026-09-17T12-11-54-933Z.json).
//
// Most update benchmarks mutate a CONSTANT fixture (one row, 10 rows, two
// parents with 10/20 children, a 100-row body): the operations toggle state
// back and forth (attribute on/off, two different texts, elements ping-ponging
// between parents), so every cycle is a real change and the whole batch can
// simply be wall-timed — nothing needs restoring between ops. Only
// "remove one attribute" consumes its fixture (the attribute is gone after
// the removal): it uses the selfTimed refill pattern — re-set the attribute
// UNTIMED, time only the removal.
//
// Fixtures are (re)built in `setup`, outside the timed region, so every
// repetition starts from a known document state; `teardown` wipes the body.
// The fixture builders are installed as page globals (window.__perf) on every
// benchmark's fresh page (beforeEach), because serialized functions cannot
// capture node-side variables.


import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import { record } from './report.mjs';
import { inPageBenchmark, openWebstratePage, median, launchOptions } from './bench.mjs';

// Batch sizes: operation cycles per repetition (≈5 s of timed work each).
const SET_ATTR_SMALL = 600;    // ≈ 8.7 ms/op → 5.2 s
// The 4 KB batch size was derived from the 2026-09-17 baseline's "set one
// attribute (4 KB value)" per-op median (8.2 ms) — but that baseline sample
// measured FIRST-TIME attribute sets (full-value ops). This benchmark
// alternates two dissimilar 4 KB values on one attribute, which goes through
// diff-match-patch: 'v'.repeat(4096) vs 'w'.repeat(4096) is a worst case with
// no common prefix/suffix, measured 2026-09-19 at ~450 ms of dmp per op on
// BOTH the SQLite and the mongo/ShareDB clients (same dmp 1.0.5, ~8 min per
// 600-op repetition — the suite cannot run that). 12 ops ≈ 5.4 s keeps the
// ≈5 s batch methodology while measuring the real per-op cost.
const SET_ATTR_4KB = 12;       // ≈ 450 ms/op (dmp-bound, both stacks) → 5.4 s
const SET_ATTR_10 = 370;       // ≈ 13.6 ms/10-op group → 5.0 s
const REMOVE_ATTR = 680;       // ≈ 7.4 ms/op → 5.0 s
const UPDATE_SMALL_TEXT = 560; // ≈ 8.9 ms/op → 5.0 s
const UPDATE_100KB_TEXT = 5;   // ≈ 1056.6 ms/op → 5.3 s
const MOVE_WITHIN = 450;      // ≈ 11.1 ms/op → 5.0 s
const MOVE_ACROSS = 450;      // ≈ 11.1 ms/op → 5.0 s
const MOVE_10_ACROSS = 260;   // ≈ 19 ms/10-op group → 4.9 s
const REPLACE_CHILD = 480;    // ≈ 10.5 ms/op → 5.0 s
const REPLACE_BODY = 30;      // ≈ 168.9 ms/op → 5.1 s

describe('Performance: DOM update', function() {
	this.timeout(600000);

	const webstrateId = 'perf-' + util.randomString() + '-update';
	const url = config.server_address + webstrateId + '/';

	let browser, page;

	// Install fixture builders as page globals. Serialized setup/run/
	// teardown functions may reference page globals — not their own
	// definition scope — so this is the sanctioned way to share code.
	const installPerf = () => page.evaluate(() => {
		window.__perf = {
			// N simple rows with an id, a class, a data-i and a text child.
			rows(n) {
				const html = Array.from({ length: n },
					(_, i) => `<div id="row-${i}" class="row" data-i="${i}">row ${i} text</div>`)
					.join('');
				document.body.innerHTML = html;
			},
			// One <pre id="big"> with a 100 KB text child of `fill` chars.
			largeText(fill) {
				document.body.innerHTML = '<pre id="big"></pre>';
				document.getElementById('big')
					.appendChild(document.createTextNode(fill.repeat(100 * 1024)));
			},
			// Two parent divs (#pa, #pb) with n <p> children each.
			twoParents(n) {
				const mk = (id) => Array.from({ length: n },
					(_, i) => `<p id="${id}-${i}" data-i="${i}">c${i}</p>`).join('');
				document.body.innerHTML = `<div id="pa">${mk('a')}</div><div id="pb">${mk('b')}</div>`;
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
		group: 'DOM update', name, samples: samples.map(s => s.ms),
		note: `${n} ops per repetition; avg ${(median(samples.map(s => s.ms)) / n).toFixed(2)} ms per op`
			+ (note ? '; ' + note : '')
	});

	it('sets one attribute 600 times (small value, 600 op round-trips)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: SET_ATTR_SMALL },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Toggle the value so every set is a real change (and op).
					const row = await window.__perf.get('row-0');
					row.setAttribute('data-flag', k % 2 ? 'on' : 'off');
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`set one attribute ×${SET_ATTR_SMALL} (small value, ${SET_ATTR_SMALL} op round-trips)`,
			SET_ATTR_SMALL, samples);
	});

	it('sets one attribute 600 times (4 KB value)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: SET_ATTR_4KB },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					const row = await window.__perf.get('row-0');
					row.setAttribute('data-blob', (k % 2 ? 'v' : 'w').repeat(4 * 1024));
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`set one attribute ×${SET_ATTR_4KB} (4 KB value, ${SET_ATTR_4KB} ops)`,
			SET_ATTR_4KB, samples);
	});

	it('sets an attribute on 10 elements, 370 times (3700 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: SET_ATTR_10 },
			setup: async () => {
				window.__perf.rows(10);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					const value = k % 2 ? 'on' : 'off';
					for (let c = 0; c < 10; c++) {
						(await window.__perf.get('row-' + c)).setAttribute('data-flag', value);
					}
					// One ack for the whole 10-op group, as in the baseline.
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`set attribute on 10 elements ×${SET_ATTR_10} (3700 ops, 1 ack per 10)`,
			SET_ATTR_10 * 10, samples, 'each cycle sets data-flag on 10 rows, then awaits one ack');
	});

	it('removes one attribute 680 times (self-timed removes, untimed re-sets)', async function() {
		const samples = await inPageBenchmark(page, {
			selfTimed: true,
			args: { n: REMOVE_ATTR },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				let ms = 0;
				for (let k = 0; k < a.n; k++) {
					// Untimed refill: put the attribute back for the next removal.
					const row = await window.__perf.get('row-0');
					row.setAttribute('data-flag', 'on');
					await window.__dataSaved();
					const t = performance.now();
					row.removeAttribute('data-flag');
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
		recordBatch(`remove one attribute ×${REMOVE_ATTR} (${REMOVE_ATTR} op round-trips)`,
			REMOVE_ATTR, samples, 're-setting the attribute between removals is untimed');
	});

	it('updates a small text node 560 times (560 op round-trips)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: UPDATE_SMALL_TEXT },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Vary the text so each op is a real change.
					const row = await window.__perf.get('row-0');
					row.firstChild.data = 'row 0 text v' + k;
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`update small text node ×${UPDATE_SMALL_TEXT} (${UPDATE_SMALL_TEXT} op round-trips)`,
			UPDATE_SMALL_TEXT, samples);
	});

	it('updates a 100 KB text node 5 times (5 large ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: UPDATE_100KB_TEXT },
			setup: async () => {
				window.__perf.largeText('x');
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Overwrite with different content of the same size,
					// alternating so every update is a real diff.
					const pre = await window.__perf.get('big');
					pre.firstChild.data = (k % 2 ? 'y' : 'z').repeat(100 * 1024);
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`update 100 KB text node ×${UPDATE_100KB_TEXT} (${UPDATE_100KB_TEXT} large ops)`,
			UPDATE_100KB_TEXT, samples);
	});

	it('moves an element to the front of its parent 450 times (450 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: MOVE_WITHIN },
			setup: async () => {
				window.__perf.twoParents(10);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					const parent = await window.__perf.get('pa');
					parent.insertBefore(parent.lastChild, parent.firstChild);
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`move element within parent ×${MOVE_WITHIN} (${MOVE_WITHIN} op round-trips)`,
			MOVE_WITHIN, samples, 'each move rotates the last child to the front');
	});

	it('moves an element across parents 450 times (450 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: MOVE_ACROSS },
			setup: async () => {
				window.__perf.twoParents(10);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Ping-pong between the parents: every move is a real
					// cross-parent op and neither parent ever runs dry.
					const a = await window.__perf.get('pa');
					const b = await window.__perf.get('pb');
					if (a.firstChild) b.appendChild(a.firstChild);
					else a.appendChild(b.firstChild);
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`move element across parents ×${MOVE_ACROSS} (${MOVE_ACROSS} op round-trips)`,
			MOVE_ACROSS, samples);
	});

	it('moves 10 elements across parents, 260 times (2600 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: MOVE_10_ACROSS },
			setup: async () => {
				window.__perf.twoParents(20);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Alternate direction every cycle so both parents keep
					// at least 10 children to move.
					const pa = await window.__perf.get('pa');
					const pb = await window.__perf.get('pb');
					const [from, to] = k % 2 ? [pb, pa] : [pa, pb];
					for (let c = 0; c < 10; c++) {
						to.appendChild(from.firstChild);
					}
					// One ack for the whole 10-move group, as in the baseline.
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`move 10 elements across parents ×${MOVE_10_ACROSS} (2600 ops, 1 ack per 10)`,
			MOVE_10_ACROSS * 10, samples);
	});

	it('replaces an element with a new one 480 times (replaceChild, 480 ops)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: REPLACE_CHILD },
			setup: async () => {
				window.__perf.rows(1);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					const fresh = document.createElement('div');
					fresh.id = 'row-0';
					fresh.className = 'row';
					fresh.textContent = 'row 0 replaced ' + k;
					document.body.replaceChild(fresh, await window.__perf.get('row-0'));
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`replaceChild single element ×${REPLACE_CHILD} (${REPLACE_CHILD} op round-trips)`,
			REPLACE_CHILD, samples);
	});

	it('replaces the whole body content via innerHTML, 30 times (100 elements)', async function() {
		const samples = await inPageBenchmark(page, {
			args: { n: REPLACE_BODY },
			setup: async () => {
				window.__perf.rows(100);
				await window.__dataSaved();
			},
			run: async (i, a) => {
				for (let k = 0; k < a.n; k++) {
					// Same size, different content — a real diff, not a no-op;
					// alternating variants keep every replacement a change.
					const suffix = k % 2 ? 'changed' : 'again';
					const html = Array.from({ length: 100 },
						(_, c) => `<div id="row-${c}" class="row2" data-i="${c}">row ${c} ${suffix}</div>`)
						.join('');
					document.body.innerHTML = html;
					await window.__dataSaved();
				}
			},
			teardown: async () => {
				document.body.innerHTML = '';
				await window.__dataSaved();
			}
		});
		recordBatch(`replace body via innerHTML ×${REPLACE_BODY} (100 elements, ${REPLACE_BODY} ops)`,
			REPLACE_BODY, samples,
			'compare with insert-100-via-innerHTML and the deletion benchmarks');
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
