// Result registry and reporting for the Webstrates performance suite.
//
// Mocha has no built-in performance reporting — it reports pass/fail and
// per-test wall time. The suite therefore records its own measurements
// (bench.mjs) and this module prints a performance OVERVIEW at the end of
// the run, in addition to mocha's spec report:
//
//   * a per-benchmark table (group, benchmark, n, median, p95, min, max,
//     ±stdev) to the console, and
//   * a JSON results file with every raw sample (tests/performance/results/),
//     for comparison across webstrate versions (see compare.mjs).
//
// The overview is flushed from a mocha ROOT hook (the top-level `after()`
// below), which mocha runs after every spec file in the run — this file is
// loaded as a spec itself (it defines no tests, so it is an empty suite).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import config from '../config.js';
import { computeStats } from './bench.mjs';

const RESULTS = [];

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(PERF_DIR, 'results');

/**
 * Record the result of one benchmark.
 * @param {object} bench
 * @param {string} bench.group Benchmark group, e.g. 'DOM insertion'.
 * @param {string} bench.name Benchmark name, e.g. 'append single element (op round-trip)'.
 * @param {number[]} bench.samples Milliseconds.
 * @param {string} [bench.unit='ms']
 * @param {string} [bench.note] Optional context (what the number contains).
 */
export function record({ group, name, samples, unit = 'ms', note = '' }) {
	RESULTS.push({ group, name, unit, note, samples: [...samples], stats: computeStats(samples) });
}

/**
 * Environment metadata stored alongside the results (for later comparison).
 */
export function environment(config) {
	const meta = {
		date: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		server: config.server_address
	};
	try {
		meta.commit = execSync('git rev-parse HEAD', { cwd: path.resolve(PERF_DIR, '..', '..') })
			.toString().trim();
		meta.branch = execSync('git rev-parse --abbrev-ref HEAD',
			{ cwd: path.resolve(PERF_DIR, '..', '..') }).toString().trim();
	} catch (err) {
		// Not a git checkout (e.g. an exported tree) — fine.
	}
	if (config.server) {
		meta.serverConfig = {
			rateLimit: config.server.rateLimit ? 'ACTIVE' : 'inactive',
			niceWebstrateIds: config.server.niceWebstrateIds,
			tagging: !!config.server.tagging,
			defaultPermissions: config.server.auth && config.server.auth.defaultPermissions
		};
	}
	return meta;
}

const pad = (s, width) => String(s).padEnd(width);
const padL = (s, width) => String(s).padStart(width);
const fmt = ms => Number.isFinite(ms) ? (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)) : '—';

/**
 * Print the overview table and write the JSON results file. Called from the
 * root after() hook at the end of the mocha run.
 */
function flushOverview() {
	if (RESULTS.length === 0) {
		console.log('\nNo benchmark results recorded.');
		return;
	}

	console.log('\n\n┏━ Performance overview ' + '━'.repeat(51));
	console.log('┃ (all values in milliseconds; client-side measurement)');
	console.log('┃ (each benchmark processes a batch sized for ≈5 s of work — the batch size');
	console.log('┃  is part of the benchmark name — and is repeated; median of the totals)');

	let lastGroup = null;
	for (const r of RESULTS) {
		if (r.group !== lastGroup) {
			console.log('\n┃ ' + r.group.toUpperCase());
			lastGroup = r.group;
		}
		console.log('┃   ' + pad(r.name, 46)
			+ 'n=' + padL(r.stats.n, 3) + '  '
			+ 'median ' + padL(fmt(r.stats.median), 6) + '  '
			+ 'p95 ' + padL(fmt(r.stats.p95), 6) + '  '
			+ 'min ' + padL(fmt(r.stats.min), 6) + '  '
			+ 'max ' + padL(fmt(r.stats.max), 6) + '  '
			+ '± ' + padL(fmt(r.stats.stdev), 5));
		if (r.note) {
			console.log('┃       ↳ ' + r.note);
		}
	}

	const fastest = [...RESULTS].sort((a, b) => a.stats.median - b.stats.median)[0];
	const slowest = [...RESULTS].sort((a, b) => b.stats.median - a.stats.median)[0];
	console.log('\n┃ ' + RESULTS.length + ' benchmarks · '
		+ RESULTS.reduce((sum, r) => sum + r.stats.n, 0) + ' samples total');
	console.log('┃ fastest: ' + fastest.name + ' (' + fmt(fastest.stats.median) + ' ms median)');
	console.log('┃ slowest: ' + slowest.name + ' (' + fmt(slowest.stats.median) + ' ms median)');
	console.log('┗' + '━'.repeat(74));
}

function writeResultsFile(env) {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = path.join(RESULTS_DIR, `perf-${stamp}.json`);
	const payload = {
		environment: env,
		results: RESULTS.map(({ group, name, unit, note, samples, stats }) =>
			({ group, name, unit, note, samples, stats }))
	};
	fs.writeFileSync(file, JSON.stringify(payload, null, 2));
	console.log('\nResults written to ' + path.relative(path.resolve(PERF_DIR, '..', '..'), file));
	console.log('Compare versions with:  node tests/performance/compare.mjs <old.json> <new.json>');
}

// Root hook: mocha runs this after all suites. The config is imported at
// module top (inside the mocha child process, where WEBSTRATES_HARNESS_STATE
// is set) — see environment().
after(async function() {
	// Give pending page console output a moment so the table is the last thing.
	this.timeout(10000);
	flushOverview();
	writeResultsFile(environment(config));
});
