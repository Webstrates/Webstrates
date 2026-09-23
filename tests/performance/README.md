# Webstrates performance suite

A client-side benchmark suite for comparing the performance of webstrate
versions: DOM manipulation operations (insertion, updating, moving,
deletion — small and large, single-op and batched), document handling
(creation, load, reload, snapshot and op-log fetches, time to first
element / document ready) and cross-client propagation (how fast a change
on one client becomes visible on another, signal delivery, transient
elements).

Benchmarks never fail for being *slow* — they are measurements, not
assertions. A test only fails when the system ends up in a wrong state
(a missing propagation, an op that was never acknowledged, …).

## The batch methodology (why ≈5 s per benchmark)

A single tiny operation takes ~5–1000 ms. At that scale, scheduler jitter,
GC pauses and websocket hiccups dominate the number: two runs of the SAME
version easily differ by ±30–50%, which makes version comparisons useless.

Every benchmark therefore measures a **batch** of operations whose size is
chosen so that one batch of timed work **sums to ≈5 seconds** — not "time to
create one document" but "time to create 20 documents", not "append one
element" but "append 400 elements". The batch sizes were derived from a
baseline run (results/perf-2026-09-17T12-11-54-933Z.json) as
`round(5000 ms / per-op median)`, are fixed named constants at the top of
each spec file, and are part of the benchmark name — so two versions
measure *identical* work.

Each batch is **repeated 4 times**; the suite reports the median of the 4
repetition totals. With ~5000 ms of real processing per sample, run-to-run
noise shrinks to a few percent.

Two implementation details keep a batch honest:

- **Refill pattern (self-timed segments).** A benchmark whose op consumes
  its fixture ("remove the subtree" — after one removal there is nothing
  left) cannot just loop the op, and letting N ops accumulate would
  measure ops against an ever-changing document. Instead each cycle
  restores the fixture **untimed** (wiping/re-seeding, always awaiting
  `dataSaved()` so the next op starts from an acknowledged, pristine
  state — the same state the baseline measured each single op in) and
  times only the real operation; the sample is the **sum of the timed
  segments** (`selfTimed: true` in bench.mjs — `run` returns the
  accumulated milliseconds).
- **Constant-fixture batches.** When the op toggles state instead of
  consuming it (attribute on/off, alternating texts, elements ping-ponging
  between parents), the whole batch is wall-timed — every cycle is still a
  real change producing real ops.

The per-op view is not lost: every benchmark's note carries the average
milliseconds per op (and the document-handling benchmarks carry the
per-document phase medians — time to first element, webstrate object,
DOMContentLoaded, load event, response start).

## Running

```sh
npm run test-perf        # runs tests/performance/ through the test harness
```

The harness (`tests/lib/run-tests.mjs`) starts a local server with the test
configuration (`tests/lib/server.base-config.json`), runs mocha against it
and drops the test database afterwards. Everything is measured **inside the
browser page** (puppeteer, Chrome) against that local server — no network
involved beyond localhost. Each run gets its **own database**
(`webstrate-test-<pid>-<timestamp>`) that only its own teardown drops, so
two concurrent runs cannot contaminate each other; runs killed before their
teardown leave a stale database that the next run sweeps (older than a day).
Before per-run names (2026-09-17) two overlapping runs shared
`webstrate-test`: when the earlier run finished, its teardown dropped the
database out from under the still-running later run — the later run's
snapshot fetches began answering 404 mid-batch (1600 fetches silently
measured error latency before the validity assertions existed) and its
document cleanup failed for 77 of 83 documents.

A normal `npm run test-all` does **not** run the performance suite; it is
opt-in because it takes ~20–25 minutes (44 processing benchmarks, each
≈5 s × 4 repetitions, plus untimed fixture work) and produces noisy numbers
on a loaded machine.

### The performance overview

Mocha itself only reports pass/fail and per-test wall time, so the suite
keeps its own result registry. When the run ends, a root hook prints an
overview table to the console:

```
┏━ Performance overview ────…
┃ (each benchmark processes a batch sized for ≈5 s of work — the batch size
┃  is part of the benchmark name — and is repeated; median of the totals)

┃ DOM INSERTION
┃   append single element ×400 (400 op round-trips)  n= 4  median 5046  …
```

and writes every raw sample to a JSON file in `tests/performance/results/`
(`perf-<timestamp>.json`), together with environment metadata (date, node
version, platform, git commit/branch, server address).

## Comparing versions

```sh
node tests/performance/compare.mjs tests/performance/results/perf-<old>.json \
                                   tests/performance/results/perf-<new>.json
```

This prints the median (and p95) of every benchmark in the old file against
the new file, with the relative change of the median:

- changes within the noise threshold (default ±15%, override with
  `WEBSTRATES_PERF_NOISE=<percent>`) count as *unchanged*;
- bigger changes are flagged IMPROVED or REGRESSED;
- benchmarks that exist in only one file are listed separately;
- the exit code is `2` if anything regressed (usable in CI), `0` otherwise.

Benchmarks are matched by group + name, and the batch size is part of the
name — so a comparison only pairs benchmarks with the SAME batch size
(files produced before 2026-09-17 used single-op benchmarks and will not
pair up; they are listed as absent/new). For meaningful comparisons, run
both versions on the same machine, idle, with the same browser. Compare
medians, not means or single samples.

## What is measured

Batch sizes below are per repetition; every batch is repeated 4× and the
median of the 4 totals is reported.

### 1. Document handling (`1-document-handling.mjs`)
Fresh-page batches (navigation included; the batch total is the summed
time-to-ready of all navigations, phases recorded by an init script before
any page code runs):

- creating 20 documents (fresh id per navigation),
- loading an existing small (~20 elements) document 20 times,
- loading a large (2000 elements) document 7 times,
- reloading a small document 40 times (one page),
- snapshot fetches over HTTP from a connected client: `?v`/`?json` on the
  small document ×600, `?v` ×300 / `?json` ×240 / `?raw` ×160 on the large
  document — every response is validated (`ok`, a non-zero `?v` version, a
  non-trivial `?json`/`?raw` body): an error page is FASTER than a snapshot,
  so silently timing one produces garbage data. This caught a real incident
  (2026-09-17): a concurrent harness run dropped the shared test database
  mid-batch and 1600 fetches quietly measured 404 latency,
- fetching the whole op log over the websocket (`getOps(0, head)`): ×640
  on the small document, ×160 on the large one (an empty op log fails the
  benchmark — same wrong-state rule).

Per-load phases (time to first element, time to webstrate object, time to
document ready, DOMContentLoaded, load event, server response start) are
reported as per-document medians in each benchmark's note.

### 2. DOM insertion (`2-dom-insertion.mjs`)
Per repetition (each cycle inserts into a freshly emptied body — the untimed
refill — and only the insertion is timed):

- append a single element ×400, a single text node ×500, an element with
  attributes + 3 children ×450,
- sequential batches of 10 elements ×300 (fragment insert, one ack per 10),
  100 elements ×105 (one ack per 100),
- one large innerHTML op of 100 elements ×140,
- a deep subtree (5 levels × 5 children) ×40,
- a 100 KB text node ×80.

### 3. DOM update (`3-dom-update.mjs`)
Constant-fixture batches (every cycle is a real change; whole batch timed):

- attribute set ×600 (small value) and ×600 (4 KB value), attribute removal
  ×680 (self-timed; the re-set between removals is untimed),
  — known issue: the 4 KB-value benchmark deterministically triggers a
  webstrates-client runaway (the single-op baseline never saw it — one op
  per fresh page; see "Memory containment" above); its bounded, annotated
  failure is a client finding, not benchmark noise,
- set an attribute on 10 elements ×370 (one ack per 10-op group),
- small text updates ×560, 100 KB text updates ×5,
- moves within a parent ×450 and across parents ×450 (elements ping-pong
  so neither parent runs dry), 10-element moves ×260 (one ack per group),
- replaceChild ×480, whole-body replacement via innerHTML (100 elements) ×30.

### 4. DOM deletion (`4-dom-deletion.mjs`)
Deletions consume their fixture, so most batches are self-timed with an
untimed refill per cycle (the re-created fixture is never timed):

- remove a single element ×550 and a single text node ×560 (the whole
  batch fixture is created untimed; the document only shrinks),
- remove a 100-child subtree ×470 (a repeated 100-child removal + refill
  can also trigger the client runaway — same contained failure shape),
- remove 100 elements sequentially ×76 (one ack per 100-op group),
- remove a 100 KB text node ×270,
- wipe the body (100 elements present) via innerHTML ×175,
- remove 1 element from a 2000-element document ×125 (the re-appended row
  is the untimed refill).

### 5. Cross-client propagation (`5-propagation.mjs`)
Two clients (pages A and B) on the same document. A mutates a batch of N
times (seeding each cycle's fixture untimed), B records arrival times (via
a MutationObserver, matched by a `data-perf` marker; cross-page timing uses
`Date.now()`, which is shared by all pages of one browser). The recorded
sample is the **summed latency** of the batch's ops:

- insert / attribute update / text update / delete: 550 / 550 / 420 / 550
  ops of A→B propagation (plus the ack-at-A sum for inserts),
- 100-element batches ×84: summed latency until the *first* and until the
  *last* element of each batch is visible on B,
- typing bursts (10 sequential text ops, 10 ms cadence) ×45: summed
  first-keystroke → last-character-visible spans,
- signals: one-way ×1200 (5 ms send cadence) and round-trip (B auto-replies)
  ×950 — every round trip awaited, whole batch timed,
- transient elements: 25000 local-only appends that must not produce ops
  (asserted via the document version and B's records).

## Methodology notes

- **Client-side measurement.** All DOM benchmarks run inside one
  `page.evaluate` call (the whole batch loop), so no CDP round-trip noise
  lands in the samples. Timestamps come from `performance.now()` in the
  page; propagation uses the shared `Date.now()` clock.
- **≈5 s per sample.** Batch sizes are constants derived from the baseline
  run (see above) and embedded in the benchmark names. If you add or change
  a benchmark, pick its batch from a measured run so it lands near 5 s.
- **4 repetitions.** No warmup iterations: with ~5-second batches, JIT and
  connection warmup happen inside the first batch, and discarding a whole
  5-second batch would cost 25% runtime for nothing. Repetitions idle
  ~150 ms between each other so pending work drains before the next.
- **Statistics.** The overview reports n, median, p95, min, max and
  standard deviation per benchmark (n = 4 repetitions). Median is the
  headline number; compare medians across versions. p95 with n=4 is the
  maximum — treat the tail with care.
- **Fixtures are untimed.** Fixtures are built in `setup` (before timing
  starts) or restored between timed segments (the refill pattern), both
  going through `dataSaved()` so the next batch starts with an
  acknowledged, pristine document.
- **One fresh client per benchmark.** Every benchmark opens its own page
  (or, in the propagation suite, its own actor/observer pair) in
  `beforeEach`. A webstrates client that wedges mid-benchmark — a dead
  websocket whose pending ops are never resubmitted, a renderer hang under
  heavy host load — poisons everything that would run on the same page
  afterwards: teardown never ran, the DOM is mid-state, a resync can
  revert fixtures. Fresh pages contain the damage to that one benchmark.
  Connection/JIT warmup happens inside the first batch, so this does not
  bias the medians (4 repetitions, median of the totals).
- **One evaluate per repetition, 5-minute protocolTimeout.** Every
  repetition of a batch is its own `page.evaluate` (the timing still happens
  inside the page, so no CDP noise lands in a sample — the round-trip cost
  falls between repetitions, outside the timed segments). A wedged
  renderer therefore costs at most ONE repetition's `protocolTimeout` (5
  min, shared `launchOptions` in bench.mjs) instead of stalling a whole
  multi-repetition benchmark. The in-page `__dataSaved()` guard (60 s per
  op) still fails wedged-but-alive clients quickly. (`withDeadline` clears
  its timer as soon as the race settles — before that, every full run
  lingered 5.4 minutes past its summary because the uncancelled 330 s
  deadline timers held mocha's event loop open.)
- **Memory containment — the suite must fail a benchmark, never the host.**
  Three shared defenses in bench.mjs (`launchOptions`, `HEAP_CAP_MB`,
  `withDeadline`): Chrome is launched with `--js-flags=--max-old-space-size=512`,
  a hard cap on every renderer's V8 heap; `inPageBenchmark` checks the
  page's JS heap between repetitions, aborting (and closing the page, which
  kills the renderer) past the cap; and every per-repetition evaluate is
  raced against a node-side 330 s deadline, because puppeteer's own
  `protocolTimeout` does not reliably fire on this wedge (observed twice:
  evaluate pending past 700 s with the renderer spinning at ~98% CPU).
  Motivation: the 4 KB attribute benchmark triggered a genuine
  webstrates-client runaway (repeated 4 KB attribute ops in one client)
  that grew a renderer to 7.4 GB and OOM-killed the whole host machine
  (kernel kill, swap exhausted; the single-op baseline never saw it because
  it performed one op per page). With these defenses the runaway costs one
  annotated, bounded benchmark failure (~5 min) and nothing else; healthy
  benchmarks stay in the tens of MB.
- **Rate limiting** is disabled in the test configuration, so sequential
  op benchmarks are not throttled. Keep it that way for comparability.

## Adding benchmarks

Benchmarks live in numbered spec files; use `inPageBenchmark` (or
`pageLoadBatchBenchmark` / `reloadBatchBenchmark` for navigations) from
`./bench.mjs` and register results with
`record({group, name, samples, note})` from `./report.mjs`.

Rules for the timed functions, because they are serialized with
`.toString()` and revived inside the page:

1. they must be **fully self-contained** — they may reference page globals
   (`window`, `document`, `window.webstrate`, helpers you install as page
   globals in `before()`), but **not** variables from their definition
   scope;
2. parameterize them with the benchmark's `args` option, which is passed
   to every function as the second parameter: `run(i, args)`;
3. size the batch so one repetition's timed work is **≈5 s** (measure once,
   then fix the constant and put it in the benchmark name); if the op
   consumes its fixture, use the self-timed refill pattern so untimed
   fixture work stays out of the sample;
4. await **`window.__dataSaved()`** (never bare
   `window.webstrate.dataSaved()`): a webstrates client whose websocket
   dies mid-run never gets its pending ops acknowledged — dataSaved then
   waits forever and the run wedges. The guarded helper (installed by
   inPageBenchmark and openWebstratePage) fails the benchmark after 60 s
   with diagnostics instead.

Navigation rule: always goto the **canonical URL with trailing slash**
(no server redirect) with the **page cache disabled** — a goto on a
redirect whose target is served from cache can hang forever (puppeteer
bug, see DOM-STRESS-FLAKE.md). Cleanup pages that follow the `?delete` →
`/` → `/frontpage/` redirect chain must disable the cache too.
