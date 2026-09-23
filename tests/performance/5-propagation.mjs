// Cross-client propagation benchmarks. Two pages (A = actor, B = observer)
// are open on the same webstrate; A mutates the document while B records
// when each change ARRIVES (a MutationObserver on B, plus 'signal' handlers).
// Every benchmark gets a FRESH pair (beforeEach): B's arrival log is per-page
// state, and an observer that desyncs mid-run has no op-gap recovery — a
// fresh pair contains such a blip to that one benchmark instead of failing
// every later arrival assertion too.
//
// BATCH METHODOLOGY (see bench.mjs): one repetition = a batch of N mutation
// cycles on page A, sized so the summed propagation work is ≈5 s (N derived
// from the 2026-09-17 baseline, results/perf-2026-09-17T12-11-54-933Z.json).
// Each cycle seeds its fixture UNTIMED (a fresh row, awaited) and then
// performs the measured mutation; the node side pairs every mutation with
// B's arrival record (matched by the element's unique data-perf marker) and
// the SAMPLE is the SUM of the per-op latencies over the batch — "propagate
// 550 inserts to B", not "propagate one insert". The per-op average is kept
// in each benchmark's note.
//
// Cross-page timing uses Date.now(), which is shared by all pages of one
// browser, so "arrival at B minus mutation at A" is a meaningful latency.
// `run` on A returns the per-op records {key, mut, ack} of its batch; the
// node side pairs them with B's drained records.
//
// Recorded numbers per benchmark (all ≈5 s sums):
//   * propagation A→B — when B's DOM shows the change, summed over the batch;
//   * ack at A — when the server confirmed the ops (client → server → ack).
//
// Also covers: signal delivery (one-way and round-trip via
// element.webstrate.signal), a typing burst (first keystroke on A until the
// last character is visible on B, summed over bursts), and transient
// elements (local-only changes that must NOT produce ops).


import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import { record } from './report.mjs';
import { inPageBenchmark, openWebstratePage, median, launchOptions } from './bench.mjs';

// Batch sizes: mutation cycles per repetition (≈5 s of summed latency each).
const INSERT_1 = 550;        // ≈ 9.0 ms/op → 5.0 s
const ATTR_UPDATES = 550;    // ≈ 9.0 ms/op → 5.0 s
const TEXT_UPDATES = 420;    // ≈ 12.0 ms/op → 5.0 s
const DELETES = 550;         // ≈ 9.0 ms/op → 5.0 s
const BATCHES_100 = 84;      // ≈ 59.5 ms/batch → 5.0 s
const TYPE_BURSTS = 45;      // ≈ 110 ms/burst → 5.0 s
const SIGNALS_ONEWAY = 1200; // ≈ 4.0 ms/signal → 4.8 s
const SIGNALS_RT = 950;      // ≈ 5.2 ms/round trip → 4.9 s
const TRANSIENTS = 25000;   // ≈ 0.2 ms/append → 5.0 s

describe('Performance: cross-client propagation', function() {
	this.timeout(600000);

	const webstrateId = 'perf-' + util.randomString() + '-prop';
	const url = config.server_address + webstrateId + '/';

	let browser, pageA, pageB;
	let clientB;

	// Standard per-repetition fixture: a fresh #bench container in the body
	// (removed in teardown). The signal element #sig-el is never touched.
	const benchSetup = async () => {
		const old = document.getElementById('bench');
		if (old) old.remove();
		const bench = document.createElement('div');
		bench.id = 'bench';
		document.body.appendChild(bench);
		await window.__dataSaved();
	};
	const benchTeardown = async () => {
		const old = document.getElementById('bench');
		if (old) old.remove();
		await window.__dataSaved();
	};

	// Instrument B: window.__arr (MutationObserver log of every applied
	// change, keyed by the element's data-perf marker) and the 'signal'
	// handler (records signal arrivals, auto-replies to round-trip pings).
	const instrumentB = () => pageB.evaluate(() => {
		window.__arr = [];
		const rec = (o) => window.__arr.push(Object.assign({ at: Date.now() }, o));
		const observer = new MutationObserver((muts) => {
			for (const m of muts) {
				if (m.type === 'childList') {
					for (const n of m.addedNodes) {
						rec({ kind: 'add',
							key: n.getAttribute ? n.getAttribute('data-perf') : null });
					}
					for (const n of m.removedNodes) {
						rec({ kind: 'remove',
							key: n.getAttribute ? n.getAttribute('data-perf') : null });
					}
				} else if (m.type === 'attributes') {
					rec({ kind: 'attr', key: m.target.getAttribute('data-perf'),
						attr: m.attributeName });
				} else if (m.type === 'characterData') {
					const p = m.target.parentElement;
					rec({ kind: 'text',
						key: p && p.getAttribute ? p.getAttribute('data-perf') : null,
						text: m.target.data });
				}
			}
		});
		observer.observe(document.documentElement,
			{ childList: true, subtree: true, attributes: true, characterData: true });

		window.__sigArr = [];
		document.getElementById('sig-el').webstrate.on('signal', (message, senderId) => {
			window.__sigArr.push({ i: message.i, at: Date.now() });
			if (message.perf === 'ping-rt') {
				document.getElementById('sig-el').webstrate
					.signal({ perf: 'pong', i: message.i }, [senderId]);
			}
		});
	});

	// Instrument A: record signal-reply arrivals, plus a tolerant element
	// lookup (rare client resyncs can momentarily rebuild the DOM).
	const instrumentA = () => pageA.evaluate(() => {
		window.__sigTimes = {};
		document.getElementById('sig-el').webstrate.on('signal', (message) => {
			if (message.perf === 'pong') {
				window.__sigTimes[message.i] = Date.now();
			}
		});
		window.__get = async (id) => {
			for (let t = 0; t < 60; t++) {
				const el = document.getElementById(id);
				if (el) return el;
				await new Promise(r => setTimeout(r, 25));
			}
			throw new Error('element "' + id + '" missing; body has '
				+ document.body.childNodes.length + ' children: '
				+ document.body.innerHTML.slice(0, 120));
		};
	});

	// Open a fresh actor/observer pair, seeding the shared signal element
	// on first use (it persists in the document afterwards). (Guarded
	// dataSaved: a wedged client must fail here instead of hanging.)
	const openPair = async () => {
		if (pageB) await pageB.close().catch(() => {});
		if (pageA) await pageA.close().catch(() => {});
		pageA = await openWebstratePage(browser, url);
		if (!await pageA.evaluate(() => Boolean(document.getElementById('sig-el')))) {
			await pageA.evaluate(async () => {
				const el = document.createElement('div');
				el.id = 'sig-el';
				document.body.appendChild(el);
				await Promise.race([
					window.webstrate.dataSaved(),
					new Promise((_, reject) => setTimeout(() => reject(new Error(
						'signal-element seeding: dataSaved() did not resolve within 60 s — client wedged')), 60000))
				]);
			});
		}
		pageB = await openWebstratePage(browser, url);
		await pageB.waitForFunction(() => {
			const el = document.getElementById('sig-el');
			return el && el.webstrate;
		}, { polling: 50, timeout: 30000 });
		await instrumentB();
		await instrumentA();
		clientB = await pageB.evaluate(() => window.webstrate.clientId);
	};

	before(async function() {
		// Shared launch options (protocolTimeout per repetition evaluate +
		// the 512 MB renderer V8 cap) — see launchOptions in bench.mjs.
		browser = await puppeteer.launch(launchOptions);
	});

	// A FRESH ACTOR/OBSERVER PAIR PER BENCHMARK: B's arrival log and the
	// signal plumbing are per-page state, and an observer that desyncs or
	// wedges mid-benchmark (op delivery has no gap recovery, so a websocket
	// blip at B loses ops entirely) would poison every later arrival-based
	// assertion. A fresh pair contains the damage to that one benchmark —
	// and each benchmark starts from a clean, acknowledged document state.
	beforeEach(async function() {
		await openPair();
	});

	after(async function() {
		if (pageB) await pageB.close().catch(() => {});
		if (pageA) await pageA.close().catch(() => {});
		// Cache off on the cleanup page — ?delete redirects through / to
		// /frontpage/ and a cached redirect target can hang goto forever
		// (puppeteer bug, see DOM-STRESS-FLAKE.md).
		const cleanup = await browser.newPage();
		await cleanup.setCacheEnabled(false);
		await cleanup.goto(url + '?delete', { waitUntil: 'domcontentloaded' })
			.catch(() => {});
		await cleanup.close();
		await browser.close();
	});

	// Read (and clear) B's records.
	const drainArrivals = () => pageB.evaluate(() => {
		const a = window.__arr; window.__arr = []; return a;
	});
	const drainSignals = () => pageB.evaluate(() => {
		const a = window.__sigArr; window.__sigArr = []; return a;
	});

	// Both clients' document versions at drain time, appended to arrival
	// assertion messages: if B missed ops (websocket blip without op-gap
	// recovery), its version lags A's — the log then shows a DESYNC, not
	// just a slow observer.
	const versions = async () => {
		const vA = await pageA.evaluate(() => window.webstrate.version);
		const vB = await pageB.evaluate(() => window.webstrate.version);
		return ` [A@v${vA}, B@v${vB}]`;
	};

	const sum = (values) => values.reduce((a, b) => a + b, 0);

	// Find B's arrival record for a mutation (kind + data-perf key).
	const findArrival = (arrivals, kind, key) =>
		arrivals.find(r => r.kind === kind && r.key === key);

	// Record a latency-sum benchmark: samples are the summed latencies of one
	// repetition's batch; the note keeps the per-op view visible.
	const recordSum = (name, n, samples, note) => record({
		group: 'Propagation', name, samples,
		note: `${n} ops per repetition; avg ${(median(samples) / n).toFixed(2)} ms per op`
			+ (note ? '; ' + note : '')
	});

	it('propagates 550 single inserted elements A→B (and acks them at A)', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: INSERT_1 },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: empty the container (1 op) so every
					// insert lands in a one-element document, as in the baseline.
					bench.innerHTML = '';
					await window.__dataSaved();
					const row = document.createElement('p');
					row.setAttribute('data-perf', 'ins-' + i + '-' + k);
					row.textContent = 'prop ' + k;
					bench.appendChild(row);
					const mut = Date.now();
					await window.__dataSaved();
					ops.push({ key: 'ins-' + i + '-' + k, mut, ack: Date.now() });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const propagation = [], acks = [];
		for (const rep of reps) {
			let prop = 0, ack = 0;
			for (const op of rep.extra) {
				const arrival = findArrival(arrivals, 'add', op.key);
				assert.isOk(arrival, 'insert ' + op.key + ' should arrive at B' + sync);
				prop += arrival.at - op.mut;
				ack += op.ack - op.mut;
			}
			propagation.push(prop);
			acks.push(ack);
		}
		recordSum(`insert 1 element ×${INSERT_1}: A→B propagation (sum of ${INSERT_1})`,
			INSERT_1, propagation);
		recordSum(`insert 1 element ×${INSERT_1}: ack at A (sum of ${INSERT_1})`,
			INSERT_1, acks, 'mutation → server acknowledgement on the acting client');
	});

	it('propagates 550 attribute updates A→B', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: ATTR_UPDATES },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: a fresh row to update.
					const row = document.createElement('p');
					row.setAttribute('data-perf', 'attr-' + i + '-' + k);
					row.textContent = 'seed ' + k;
					bench.appendChild(row);
					await window.__dataSaved();
					const mut = Date.now();
					row.setAttribute('data-flag', 'on');
					await window.__dataSaved();
					ops.push({ key: 'attr-' + i + '-' + k, mut });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const propagation = [];
		for (const rep of reps) {
			let prop = 0;
			for (const op of rep.extra) {
				const arrival = findArrival(arrivals, 'attr', op.key);
				assert.isOk(arrival, 'attribute update ' + op.key + ' should arrive at B' + sync);
				prop += arrival.at - op.mut;
			}
			propagation.push(prop);
		}
		recordSum(`attribute update ×${ATTR_UPDATES}: A→B propagation (sum of ${ATTR_UPDATES})`,
			ATTR_UPDATES, propagation, 'seeding each row is untimed');
	});

	it('propagates 420 text updates A→B', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: TEXT_UPDATES },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: a fresh row to type into.
					const row = document.createElement('p');
					row.setAttribute('data-perf', 'text-' + i + '-' + k);
					row.textContent = 'seed';
					bench.appendChild(row);
					await window.__dataSaved();
					const mut = Date.now();
					row.firstChild.data = 'text ' + k + ' updated';
					await window.__dataSaved();
					ops.push({ key: 'text-' + i + '-' + k, mut });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const propagation = [];
		for (const rep of reps) {
			let prop = 0;
			for (const op of rep.extra) {
				const arrival = findArrival(arrivals, 'text', op.key);
				assert.isOk(arrival, 'text update ' + op.key + ' should arrive at B' + sync);
				prop += arrival.at - op.mut;
			}
			propagation.push(prop);
		}
		recordSum(`text update ×${TEXT_UPDATES}: A→B propagation (sum of ${TEXT_UPDATES})`,
			TEXT_UPDATES, propagation, 'seeding each row is untimed');
	});

	it('propagates 550 element deletions A→B', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: DELETES },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: a fresh row to delete.
					const row = document.createElement('p');
					row.setAttribute('data-perf', 'del-' + i + '-' + k);
					bench.appendChild(row);
					await window.__dataSaved();
					const mut = Date.now();
					row.remove();
					await window.__dataSaved();
					ops.push({ key: 'del-' + i + '-' + k, mut });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const propagation = [];
		for (const rep of reps) {
			let prop = 0;
			for (const op of rep.extra) {
				const arrival = findArrival(arrivals, 'remove', op.key);
				assert.isOk(arrival, 'deletion ' + op.key + ' should arrive at B' + sync);
				prop += arrival.at - op.mut;
			}
			propagation.push(prop);
		}
		recordSum(`delete element ×${DELETES}: A→B propagation (sum of ${DELETES})`,
			DELETES, propagation, 'seeding each row is untimed');
	});

	it('propagates 84 batches of 100 elements A→B (first vs last arrival)', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: BATCHES_100 },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: wipe the previous batch (1 op).
					bench.innerHTML = '';
					await window.__dataSaved();
					const frag = document.createDocumentFragment();
					for (let c = 0; c < 100; c++) {
						const row = document.createElement('p');
						row.setAttribute('data-perf', 'ins100-' + i + '-' + k);
						row.textContent = 'row ' + c;
						frag.appendChild(row);
					}
					const mut = Date.now();
					bench.appendChild(frag);
					await window.__dataSaved();
					ops.push({ key: 'ins100-' + i + '-' + k, mut, ack: Date.now() });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const first = [], last = [], acks = [];
		for (const rep of reps) {
			let firstSum = 0, lastSum = 0, ackSum = 0;
			for (const op of rep.extra) {
				const batch = arrivals
					.filter(r => r.kind === 'add' && r.key === op.key)
					.map(r => r.at);
				assert.lengthOf(batch, 100, 'all 100 elements of batch ' + op.key
					+ ' should arrive at B' + sync);
				firstSum += Math.min(...batch) - op.mut;
				lastSum += Math.max(...batch) - op.mut;
				ackSum += op.ack - op.mut;
			}
			first.push(firstSum);
			last.push(lastSum);
			acks.push(ackSum);
		}
		recordSum(`insert 100 elements ×${BATCHES_100}: first element A→B (sum over ${BATCHES_100} batches)`,
			BATCHES_100, first, 'latency until the first of each 100-element batch is visible on B');
		recordSum(`insert 100 elements ×${BATCHES_100}: full batch A→B (sum over ${BATCHES_100} batches)`,
			BATCHES_100, last, 'latency until the last of each 100-element batch is visible on B; '
				+ `avg ack at A ${(median(acks) / BATCHES_100).toFixed(2)} ms per batch`);
	});

	it('propagates 45 typing bursts A→B (10 sequential text ops each)', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: TYPE_BURSTS },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const bench = await window.__get('bench');
					// Untimed refill: the row this burst types into.
					const row = document.createElement('p');
					row.setAttribute('data-perf', 'type-' + i + '-' + k);
					row.textContent = 'burst ' + k + ': ';
					bench.appendChild(row);
					await window.__dataSaved();
					const node = row.firstChild;
					const keystrokes = [];
					for (let c = 0; c < 10; c++) {
						await new Promise(r => setTimeout(r, 10));
						node.data += 'x';
						keystrokes.push(Date.now());
					}
					await window.__dataSaved();
					ops.push({ key: 'type-' + i + '-' + k, t0: keystrokes[0] });
				}
				return ops;
			},
			teardown: benchTeardown
		});
		const arrivals = await drainArrivals();
		const sync = await versions();
		const spans = [];
		for (const rep of reps) {
			let spanSum = 0;
			for (const op of rep.extra) {
				const batch = arrivals
					.filter(r => r.kind === 'text' && r.key === op.key)
					.map(r => r.at);
				// Consecutive text changes may be composed into one op when two
				// keystrokes land before the first is submitted — so anything
				// between 1 and 10 ops can arrive.
				assert.isAtLeast(batch.length, 1, 'at least one text op of burst ' + op.key
					+ ' should arrive at B' + sync);
				assert.isAtMost(batch.length, 10, 'no more text ops than keystrokes should arrive');
				// Span of one burst: first keystroke on A → last character
				// visible on B (10 ms typing cadence included, as typed).
				spanSum += Math.max(...batch) - op.t0;
			}
			spans.push(spanSum);
		}
		recordSum(`typing burst (10 chars) ×${TYPE_BURSTS}: first keystroke → last char on B (sum over ${TYPE_BURSTS} bursts)`,
			TYPE_BURSTS, spans, 'per burst: 10 keystrokes at 10 ms cadence until the last is visible on B; '
				+ 'seeding each row is untimed');
	});

	it('delivers 1200 one-way signals A→B', async function() {
		const reps = await inPageBenchmark(pageA, {
			args: { n: SIGNALS_ONEWAY, recipient: clientB },
			setup: benchSetup,
			run: async (i, a) => {
				const ops = [];
				for (let k = 0; k < a.n; k++) {
					const el = document.getElementById('sig-el');
					if (!el || !el.webstrate) throw new Error('signal element missing');
					const id = i * 1000000 + k;
					const t0 = Date.now();
					el.webstrate.signal({ perf: 'ping', i: id }, [a.recipient]);
					ops.push({ i: id, t0 });
					// Pace the sends so signals don't queue up behind each other.
					await new Promise(r => setTimeout(r, 5));
				}
				return ops;
			},
			teardown: benchTeardown
		});
		// Give the last signal a moment to land before draining.
		await util.sleep(0.2);
		const arrivals = await drainSignals();
		const sync = await versions();
		const latencies = [];
		for (const rep of reps) {
			let latSum = 0;
			for (const op of rep.extra) {
				const arrival = arrivals.find(r => r.i === op.i);
				assert.isOk(arrival, 'signal ' + op.i + ' should arrive at B' + sync);
				latSum += arrival.at - op.t0;
			}
			latencies.push(latSum);
		}
		recordSum(`signal one-way A→B ×${SIGNALS_ONEWAY} (sum of ${SIGNALS_ONEWAY} deliveries)`,
			SIGNALS_ONEWAY, latencies,
			'element.webstrate.signal(message, [recipient]) delivery latency, 5 ms send cadence');
	});

	it('round-trips 950 signals A→B→A', async function() {
		const samples = await inPageBenchmark(pageA, {
			args: { n: SIGNALS_RT, recipient: clientB },
			setup: benchSetup,
			run: async (i, a) => {
				// Every round trip is awaited, so the whole batch is timed
				// work: ping to B, B auto-replies, until the reply arrives.
				for (let k = 0; k < a.n; k++) {
					const el = document.getElementById('sig-el');
					if (!el || !el.webstrate) throw new Error('signal element missing');
					const id = i * 1000000 + k;
					window.__sigTimes[id] = undefined;
					el.webstrate.signal({ perf: 'ping-rt', i: id }, [a.recipient]);
					const deadline = Date.now() + 5000;
					while (window.__sigTimes[id] === undefined && Date.now() < deadline) {
						await new Promise(r => setTimeout(r, 2));
					}
					if (window.__sigTimes[id] === undefined) {
						throw new Error('signal round trip ' + id + ' did not complete');
					}
				}
			},
			teardown: benchTeardown
		});
		record({
			group: 'Propagation',
			name: `signal round trip A→B→A ×${SIGNALS_RT} (sum of ${SIGNALS_RT} round trips)`,
			samples: samples.map(s => s.ms),
			note: `${SIGNALS_RT} awaited ping/reply round trips; `
				+ `avg ${(median(samples.map(s => s.ms)) / SIGNALS_RT).toFixed(2)} ms per round trip`
		});
	});

	it('applies 25000 transient elements locally without producing ops', async function() {
		// Self-timed: only the local append loop is measured (there is no
		// server round trip by design); the version/no-op check runs after
		// the timed loop, untimed, and fails the benchmark if violated.
		const samples = await inPageBenchmark(pageA, {
			selfTimed: true,
			args: { n: TRANSIENTS },
			setup: benchSetup,
			run: async (i, a) => {
				const v0 = window.webstrate.version;
				const t0 = performance.now();
				for (let k = 0; k < a.n; k++) {
					const el = document.createElement('transient');
					el.setAttribute('data-perf', 'tr-' + i + '-' + k);
					document.body.appendChild(el);
				}
				const ms = performance.now() - t0;
				// Give the client a moment to (not) create ops, then verify.
				await new Promise(r => setTimeout(r, 100));
				const present = document.querySelectorAll('transient').length;
				if (present !== a.n) {
					throw new Error('expected ' + a.n + ' transient elements, found ' + present);
				}
				if (window.webstrate.version !== v0) {
					throw new Error('transient elements must not produce ops (version changed)');
				}
				return ms;
			},
			teardown: async () => {
				document.querySelectorAll('transient').forEach(n => n.remove());
			}
		});
		record({
			group: 'Propagation',
			name: `append transient element ×${TRANSIENTS} (local only, no ops)`,
			samples: samples.map(s => s.ms),
			note: 'local DOM appends only, no server round trip by design; '
				+ `avg ${(median(samples.map(s => s.ms)) / TRANSIENTS).toFixed(3)} ms per append`
		});
		// B must never have seen any transient element.
		const arrivals = await drainArrivals();
		assert.isFalse(arrivals.some(r => typeof r.key === 'string' && r.key.startsWith('tr-')),
			'transient elements must not propagate to B');
	});
});
