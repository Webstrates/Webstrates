// Benchmarking core for the Webstrates performance suite.
//
// METHODOLOGY (batch benchmarks): a single tiny operation (~5–1000 ms) is far
// too small a number to compare across versions — scheduler jitter, GC and
// websocket hiccups dominate it. Every benchmark therefore processes a BATCH
// of operations whose size is derived from a baseline run so that the timed
// work of one batch sums to ≈ TARGET_MS (5 s), and that batch is repeated
// REPETITIONS (4) times. The median of the 4 repetition totals is the
// headline number: ~5000 ms of real processing per sample makes relative
// noise small, and the batch sizes (embedded in the benchmark names) are
// fixed constants, so two versions measure identical work.
//
// All measurements are taken CLIENT-SIDE: the timed function runs inside the
// browser page (puppeteer), against a local server started by the test
// harness (tests/lib/run-tests.mjs). The node side only orchestrates: it
// serializes self-contained functions into the page, retrieves the sample
// arrays and computes statistics.
//
// Measurement shapes:
//
//  1. inPageBenchmark — one page, one batch of N operations per repetition.
//     Each repetition is ONE page.evaluate call, so no CDP round-trip noise
//     lands inside a sample (the timing itself stays in the page via
//     performance.now(); the round-trip cost falls between repetitions,
//     outside the timed segments). Evaluating per repetition also bounds the
//     damage of a wedged or leaking renderer: at most one repetition's
//     protocolTimeout (see launchOptions), and the heap watchdog (below)
//     gets a chance to abort between repetitions. By default the
//     sample is the WALL time of the batch (everything inside `run` is timed
//     work). With `selfTimed: true`, `run` itself returns the accumulated
//     milliseconds — use this for the refill pattern (below).
//
//     Refill pattern: a benchmark whose single op consumes its fixture (e.g.
//     "remove the subtree" — after one removal there is nothing left to
//     remove) cannot just loop the op, and letting N ops accumulate would
//     measure ops against an ever-changing document. Instead each cycle
//     restores the fixture UNTIMED (awaiting dataSaved so the next op starts
//     from an acknowledged, pristine state), times only the real operation,
//     and returns the sum of the timed segments (selfTimed).
//
//  2. pageLoadBatchBenchmark / reloadBatchBenchmark — document-handling
//     batches: each repetition navigates `navigations` times (fresh puppeteer
//     page per navigation, or reloads of one page) with an init script
//     (evaluateOnNewDocument) that records document-handling phase timestamps
//     (response start, first element, webstrate object, loaded). A
//     repetition's sample is the SUM of time-to-loaded over its navigations —
//     "time to create 20 documents", not "time to create 1 document".
//
// Statistics are computed on the node side by computeStats(): median is the
// headline number (robust against GC pauses), p95 and min/max give the tail.

/**
 * Every benchmark's batch is sized so one batch of timed work takes ≈ this.
 * Batch sizes live in the spec files as named constants (derived from a
 * baseline results file) and are embedded in the benchmark names.
 */
export const TARGET_MS = 5000;

/** Every batch is repeated this many times; the median of the totals counts. */
export const REPETITIONS = 4;

/**
 * Chrome launch options shared by every spec file (puppeteer.launch(...)).
 *
 * protocolTimeout (5 min): one CDP evaluate covers ONE benchmark repetition
 * (inPageBenchmark evaluates per repetition — see below), i.e. ≈5–25 s of
 * designed work. A slow-but-alive repetition under heavy host load fits
 * comfortably inside 5 minutes, while a wedged renderer costs at most one
 * repetition's timeout instead of stalling a whole multi-repetition batch.
 *
 * --js-flags=--max-old-space-size=512 — a HARD CAP on every renderer's V8
 * heap. The webstrates client has a runaway path (observed 2026-09-17: the
 * 4 KB attribute benchmark against a slow server) that grows a renderer's
 * heap without bound — 7.4 GB, host-wide OOM, kernel kill, swap exhausted.
 * With the cap such a renderer CRASHES at 512 MB, its benchmark fails fast
 * with a protocol error, and the machine survives: the suite must be allowed
 * to fail a benchmark, never the host. Healthy benchmarks stay far below
 * the cap (tens of MB).
 */
export const launchOptions = {
	protocolTimeout: 300000,
	args: ['--js-flags=--max-old-space-size=512']
};

/**
 * The heap watchdog limit (MB) — see launchOptions. inPageBenchmark checks
 * the page's JS heap between repetitions and aborts (closing the page, which
 * kills the renderer) when a repetition leaves more than this behind.
 */
export const HEAP_CAP_MB = 512;

/**
 * Compute descriptive statistics over an array of numbers.
 * @param {number[]} samples Milliseconds.
 * @returns {object} {n, min, max, mean, median, p95, stdev}
 */
export function computeStats(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const n = sorted.length;
	const pick = p => sorted[Math.min(n - 1, Math.floor(p * n))];
	const mean = sorted.reduce((a, b) => a + b, 0) / n;
	const stdev = n > 1
		? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
		: 0;
	return {
		n,
		min: sorted[0],
		max: sorted[n - 1],
		mean,
		median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
		p95: pick(0.95),
		stdev
	};
}

/** Median of an array of numbers (NaN for an empty array). */
export const median = (values) => computeStats(values).median;

/**
 * Race a promise against a deadline (ms). NODE-SIDE BACKSTOP for CDP calls
 * into a wedged page: puppeteer's protocolTimeout does fire on a busy
 * renderer in the simple case (verified with a sync spin), but the
 * webstrates-client runaway (4 KB attribute batch, 2026-09-17) leaves a
 * per-repetition evaluate pending FAR past protocolTimeout — twice, with
 * protocolTimeout 300 s, the evaluate was still pending after 700 s while
 * its renderer spun at ~98% CPU. A wedged evaluate must fail the benchmark
 * at a bounded cost, never stall the suite until mocha's timeout.
 */
// Race a promise against a deadline. The timer is cleared as soon as the
// race settles — an uncancelled 330 s deadline timer would otherwise hold
// mocha's event loop open for minutes after the last benchmark finished
// (every full run lingered 5.4 min past its summary before this fix).
const withDeadline = (promise, ms, what) => {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(
			what + ' did not settle within ' + ms + ' ms — renderer wedged '
			+ '(webstrates client runaway; see launchOptions)')), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/** Deadline for one repetition's evaluate (see withDeadline). */
const REP_DEADLINE_MS = 330000;

/**
 * Run a benchmark batch entirely inside the page.
 *
 * setup, run and teardown are FUNCTIONS (they are serialized with .toString()
 * and reconstructed in the page) and must therefore be fully self-contained:
 * they may reference globals available in the page (window, document,
 * window.webstrate, helpers installed as page globals in before() …) but NOT
 * anything from their definition scope.
 *
 * `run(i, args)` performs the whole batch (a loop of N operations) and, when
 * the benchmark includes the server round trip, awaits
 * `window.webstrate.dataSaved()` per operation (or once per coherent group of
 * operations, mirroring the original single-op shape).
 *
 * Timing modes:
 *   * wall (default) — the sample is the wall time of the whole `run` call;
 *     use when everything inside `run` is timed work (constant-fixture
 *     batches: attribute toggles, text updates, moves, replaces …).
 *   * selfTimed — `run` returns the accumulated milliseconds of its timed
 *     segments; use with the refill pattern, where untimed fixture
 *     restoration is interleaved with the timed operations (see above).
 *
 * Because the functions are serialized, they CANNOT capture variables from
 * their definition scope (the closure is lost in the page). To parameterize
 * a benchmark, pass `args` — a JSON-serializable value handed to every
 * revived function as the second parameter: `setup(i, args)`, `run(i, args)`,
 * `teardown(i, args)`.
 *
 * The first `warmup` repetitions are discarded; the remaining `iterations`
 * samples are returned. Between repetitions the page idles `settleMs`
 * milliseconds so ops don't queue up behind each other. With ~5 s batches,
 * warmup is unnecessary (JIT and connection warmup happen inside the first
 * batch) and defaults to 0.
 *
 * MEMORY WATCHDOG: between repetitions the page's JS heap is checked; a
 * repetition that leaves more than HEAP_CAP_MB behind aborts the benchmark
 * (the page is closed, killing the renderer) instead of letting a client-side
 * runaway eat the host machine — see launchOptions for the incident that
 * motivated this.
 *
 * @param {Page} page Puppeteer page, already on a loaded webstrate.
 * @param {object} options
 * @param {number}  [options.iterations] Measured repetitions (default REPETITIONS).
 * @param {number}  [options.warmup] Discarded warmup repetitions (default 0).
 * @param {number}  [options.settleMs] Idle time between repetitions (default 150).
 * @param {boolean} [options.selfTimed] run() returns the accumulated ms (see above).
 * @param {Function} [options.setup] Called per repetition before timing.
 * @param {Function} options.run Timed once per repetition (the whole batch).
 * @param {Function} [options.teardown] Called per repetition after timing.
 * @param {mixed}  [options.args] JSON-serializable parameter for the
 *     serialized functions (see above).
 * @returns {Promise<Array<{ms:number, extra?:mixed}>>}
 */
export async function inPageBenchmark(page, {
	iterations = REPETITIONS, warmup = 0, settleMs = 150, selfTimed = false,
	setup, run, teardown, args
}) {
	// dataSaved() with a guard (openWebstratePage already installed it on
	// the page; idempotent): a webstrates client whose websocket died mid-run
	// can wedge dataSaved() forever (pending ops never acked, and the
	// reconnect does not resubmit them). A wedged page must FAIL the
	// benchmark quickly with diagnostics, not hang the whole suite for
	// mocha's timeout. Serialized setup/run/teardown functions must therefore
	// await window.__dataSaved() instead of window.webstrate.dataSaved().
	await withDeadline(installDataSavedGuard(page), REP_DEADLINE_MS,
		'dataSaved-guard installation');

	// Surface client-side errors (uncaught exceptions, console.error) in the
	// mocha output while a benchmark runs, prefixed with the benchmark body's
	// first line — invaluable when a client hiccup makes a benchmark fail.
	const lines = String(run).split('\n').map((l) => l.trim())
		.filter((l) => l && l !== '{' && l !== '}');
	const tag = 'perf:' + (lines[1] || lines[0] || 'benchmark').slice(0, 60);
	const onConsole = (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			console.error(`[${tag}] console.${msg.type()}: ${msg.text()}`);
		}
	};
	const onPageError = (err) => console.error(`[${tag}] pageerror: ${err.message}`);
	page.on('console', onConsole);
	page.on('pageerror', onPageError);

	// Serialized payload for one repetition's evaluate (the functions are
	// revived inside the page and must stay fully self-contained — see the
	// doc comment above).
	const rep = (i) => ({
		i,
		args: args === undefined ? null : args,
		setup: setup ? setup.toString() : null,
		run: run.toString(),
		teardown: teardown ? teardown.toString() : null
	});

	// Annotate the failure modes a wedged or crashed renderer produces, so
	// the mocha output names the cause instead of a bare puppeteer error (a
	// renderer that hits the 512 MB V8 cap from launchOptions dies exactly
	// like this — see launchOptions for the observed runaway paths).
	const annotate = (err) => {
		const msg = String((err && err.message) || err);
		if (/timed out|Target closed|Session closed|Protocol error/i.test(msg)) {
			err.message = msg + ' — renderer wedged or crashed mid-repetition; with the '
				+ '512 MB V8 cap (launchOptions in bench.mjs) this is the signature of '
				+ 'a webstrates client runaway (observed on batched 4 KB attribute ops '
				+ 'and on repeated 100-child subtree removals), not a harness bug';
		}
		return err;
	};

	try {
		const samples = [];
		for (let i = 0; i < warmup + iterations; i++) {
			// ONE evaluate PER REPETITION: a wedged or leaking renderer kills
			// at most one repetition's protocolTimeout, and the heap
			// watchdog below can inspect the page between repetitions. The
			// timing is unaffected — `run` still measures itself inside the
			// page; the CDP round-trip cost falls between repetitions,
			// outside the timed segments.
			let wall, ret;
			try {
				({ wall, ret } = await withDeadline(page.evaluate(async (cfg) => {
					const revive = (src) => src ? eval('(' + src + ')') : null;
					const setup = revive(cfg.setup);
					const run = revive(cfg.run);
					const teardown = revive(cfg.teardown);
					const benchArgs = cfg.args === null ? undefined : cfg.args;

					// Bounded wait until the webstrate is ready to mutate (a
					// page that never finishes loading must fail, not hang).
					for (let waited = 0; !window.webstrate || !window.webstrate.loaded;) {
						if (waited > 120000) {
							throw new Error('webstrate never reached loaded state '
								+ '(waited ' + waited + ' ms)');
						}
						await new Promise((r) => setTimeout(r, 5));
						waited += 5;
					}

					if (setup) await setup(cfg.i, benchArgs);
					const t0 = performance.now();
					const runResult = await run(cfg.i, benchArgs);
					const runWall = performance.now() - t0;
					if (teardown) await teardown(cfg.i, benchArgs);
					return { wall: runWall, ret: runResult };
				}, rep(i)), REP_DEADLINE_MS, 'repetition ' + i + ' of "' + tag + '"'));
			} catch (err) {
				// A wedged or crashed renderer must not keep burning CPU
				// until mocha's timeout: close the page — the browser process
				// kills the renderer — then fail THIS benchmark. close() can
				// ITSELF hang on a busy renderer, so bound it and always
				// report the original benchmark error (a renderer that
				// survives a hung close is memory-capped by the V8 flag and
				// crashes on its own runaway allocation, and the browser is
				// closed at the end of the file regardless).
				await withDeadline(page.close(), 15000,
					'closing the wedged page').catch(() => {});
				throw annotate(err);
			}

			let ms = wall;
			if (selfTimed) {
				if (typeof ret !== 'number' || !Number.isFinite(ret)) {
					throw new Error('self-timed benchmark: run() must return the '
						+ 'accumulated milliseconds of its timed segments');
				}
				ms = ret;
			}

			// Heap watchdog (see launchOptions): abort — closing the page,
			// which kills the renderer — before a client-side runaway can
			// endanger the host. performance.memory is Chrome-only; without
			// it the launch flag remains the hard cap.
			const heapMB = await withDeadline(page.evaluate(() =>
				performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null),
			30000, 'heap-watchdog probe').catch(() => null);
			if (heapMB !== null && heapMB > HEAP_CAP_MB) {
				await page.close().catch(() => {});
				throw new Error('benchmark aborted after repetition ' + i + ': page JS '
					+ 'heap ' + Math.round(heapMB) + ' MB exceeds the ' + HEAP_CAP_MB
					+ ' MB cap — webstrates client memory runaway (see launchOptions in '
					+ 'bench.mjs); page closed to protect the host');
			}

			// Sample only measured repetitions, but settle after every one.
			if (i >= warmup) {
				samples.push({ ms, extra: selfTimed || ret === undefined ? null : ret });
			}
			await new Promise((r) => setTimeout(r, settleMs));
		}
		return samples;
	} finally {
		page.off('console', onConsole);
		page.off('pageerror', onPageError);
	}
}

/**
 * Init script for the page-load benchmarks: records document-handling
 * milestones into window.__phases (milliseconds since navigationStart, i.e.
 * directly comparable to performance.now() values).
 *
 * Milestones recorded (when they occur):
 *   responseStart     — first byte of the HTML document (navigation timing).
 *   domInteractive    — DOM interactive (navigation timing).
 *   firstElement      — first non-head element appears in the DOM (the
 *                       client's snapshot has begun applying).
 *   webstrateObject   — window.webstrate exists (client bundle booted).
 *   loaded            — the 'loaded' event fired: document ready.
 *   domContentLoaded  — browser's DCL event (navigation timing).
 *   loadEvent         — browser's load event (navigation timing).
 *
 * Note: for a webstrates page the server HTML is nearly empty (the DOM is
 * built by the client from the ShareDB snapshot), so firstElement→loaded is
 * the interesting band: it contains connection setup, snapshot fetch and
 * initial DOM population.
 */
export const PHASE_INIT_SCRIPT = () => {
	window.__phases = {};
	// Record a phase once. Second argument records an explicit value (used
	// for navigation-timing offsets, which are already relative to
	// navigationStart).
	window.__phase = (name, value) => {
		if (window.__phases[name] === undefined) {
			window.__phases[name] = value !== undefined ? value : performance.now();
		}
	};

	// First element: any content inside <html> beyond the empty skeleton the
	// server ships (an empty <head> and <body>). Content nodes mean the
	// client's snapshot apply has begun.
	const observer = new MutationObserver(() => {
		const hasContent = (document.body && document.body.childNodes.length)
			|| (document.head && document.head.childNodes.length);
		if (hasContent) {
			window.__phase('firstElement');
			observer.disconnect();
		}
	});
	observer.observe(document, { childList: true, subtree: true });

	const awaitWebstrate = () => {
		if (window.webstrate) {
			window.__phase('webstrateObject');
			window.webstrate.on('loaded', () => window.__phase('loaded'));
		} else {
			requestAnimationFrame(awaitWebstrate);
		}
	};
	requestAnimationFrame(awaitWebstrate);

	document.addEventListener('DOMContentLoaded', () => {
		window.__phase('domContentLoaded');
		const nav = performance.getEntriesByType('navigation')[0];
		if (nav) {
			window.__phase('responseStart', nav.responseStart);
			window.__phase('domInteractive', nav.domInteractive);
		}
	});
	window.addEventListener('load', () => window.__phase('loadEvent'));
};

/**
 * Navigate once with the phase-recording init script installed, and resolve
 * with that navigation's phases. Shared by pageLoadBatchBenchmark and
 * reloadBatchBenchmark.
 */
async function timedNavigation(page, target, timeoutMs) {
	await page.goto(target, { waitUntil: 'load', timeout: timeoutMs });
	await page.waitForFunction(() => window.__phases && window.__phases.loaded !== undefined,
		{ timeout: timeoutMs, polling: 25 });
	// Give late navigation-timing entries a moment to land.
	await new Promise(r => setTimeout(r, 100));
	return await page.evaluate(() => window.__phases);
}

/**
 * Summarize one repetition: the sample is the sum of time-to-loaded over the
 * repetition's navigations; the per-navigation phases are kept for notes.
 */
const summarizeRepetition = (phases) => {
	const loaded = phases.map(p => p.loaded).filter(Number.isFinite);
	return {
		total: loaded.reduce((a, b) => a + b, 0),
		navigations: phases.length,
		phases
	};
};

/**
 * Run a document-creation/load batch: every repetition opens `navigations`
 * fresh puppeteer pages (a new page per navigation, cache disabled) on `url`,
 * with the phase-recording init script installed before navigation. A
 * repetition's sample is the SUM of time-to-loaded over its navigations —
 * e.g. "create 20 documents" measures 20 full creation round trips.
 *
 * @param {Browser} browser Puppeteer browser (fresh page per navigation).
 * @param {object} options
 * @param {string|Function} options.url Page URL to open — either a fixed
 *     string, or `(navigationIndex) => url` when every navigation must open a
 *     different document (e.g. fresh ids for a creation benchmark). The index
 *     counts across repetitions, so urls stay unique.
 * @param {number} options.navigations Navigations per repetition (the batch).
 * @param {number} [options.repetitions] Repetitions of the batch.
 * @param {number} [options.timeoutMs] Per-navigation hard timeout (default 30s).
 * @returns {Promise<Array<{total:number, navigations:number, phases:object[]}>>}
 *     One entry per repetition.
 */
export async function pageLoadBatchBenchmark(browser,
	{ url, navigations, repetitions = REPETITIONS, timeoutMs = 30000 }) {
	const reps = [];
	let nav = 0;
	for (let r = 0; r < repetitions; r++) {
		const phases = [];
		for (let n = 0; n < navigations; n++, nav++) {
			const target = typeof url === 'function' ? url(nav) : url;
			const page = await browser.newPage();
			await page.setCacheEnabled(false);
			await page.evaluateOnNewDocument(PHASE_INIT_SCRIPT);
			phases.push(await timedNavigation(page, target, timeoutMs));
			await page.close();
		}
		reps.push(summarizeRepetition(phases));
	}
	return reps;
}

/**
 * Reload batch: every repetition reloads ONE page `navigations` times (no
 * fresh page per navigation — the warm path: server render + client
 * bootstrap without a new browser page). Same phases and sample shape as
 * pageLoadBatchBenchmark.
 *
 * @param {Page} page Puppeteer page already open anywhere (navigated to url).
 * @param {object} options
 * @param {string} options.url Page URL to reload.
 * @param {number} options.navigations Reloads per repetition (the batch).
 * @param {number} [options.repetitions] Repetitions of the batch.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Array<{total:number, navigations:number, phases:object[]}>>}
 */
export async function reloadBatchBenchmark(page,
	{ url, navigations, repetitions = REPETITIONS, timeoutMs = 30000 }) {
	await page.setCacheEnabled(false);
	await page.evaluateOnNewDocument(PHASE_INIT_SCRIPT);
	const reps = [];
	for (let r = 0; r < repetitions; r++) {
		const phases = [];
		for (let n = 0; n < navigations; n++) {
			phases.push(await timedNavigation(page, url, timeoutMs));
		}
		reps.push(summarizeRepetition(phases));
	}
	return reps;
}

/**
 * Derive named durations from one navigation's phases. Used for the
 * per-document medians reported in benchmark notes (the headline sample is
 * the batch total). Unknown phases are reported as null (filtered out).
 */
export const PHASE_DERIVATIONS = {
	'time to first element': p => p.firstElement,
	'time to webstrate object': p => p.webstrateObject,
	'time to document ready (loaded)': p => p.loaded,
	'time to DOMContentLoaded': p => p.domContentLoaded,
	'time to loadEvent': p => p.loadEvent,
	'response start (server first byte)': p => p.responseStart
};

/**
 * Wait for a webstrate page to be fully loaded.
 * @param {Page} page
 */
export async function waitForWebstrate(page, timeoutSec = 30) {
	await page.waitForFunction(() => window.webstrate && window.webstrate.loaded,
		{ timeout: timeoutSec * 1000, polling: 50 });
}

/**
 * Install window.__dataSaved (guarded dataSaved — see inPageBenchmark) on a
 * page, so node-side evaluates can use the same fail-fast guard. Idempotent.
 * @param {Page} page
 */
export async function installDataSavedGuard(page) {
	await page.evaluate(() => {
		window.__dataSaved = async (timeoutMs = 60000) => {
			const saved = window.webstrate.dataSaved();
			const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(
				'dataSaved() did not resolve within ' + timeoutMs + ' ms — client wedged '
				+ '(version ' + window.webstrate.version + ', loaded '
				+ window.webstrate.loaded + ', body children '
				+ document.body.children.length + ')')), timeoutMs));
			return Promise.race([saved, timer]);
		};
	});
}

/**
 * Create a page on `url`, wait for it to be ready and install the guarded
 * dataSaved helper.
 */
export async function openWebstratePage(browser, url, timeoutSec = 30) {
	const page = await browser.newPage();
	await page.setCacheEnabled(false);
	await page.goto(url, { waitUntil: 'load', timeout: timeoutSec * 1000 });
	await waitForWebstrate(page, timeoutSec);
	await installDataSavedGuard(page);
	return page;
}
