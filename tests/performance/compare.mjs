// Compare two (or more) performance-suite result files.
//
//   node tests/performance/compare.mjs results/perf-<old>.json results/perf-<new>.json
//
// Prints the median (and p95) of the first file against each following file,
// with the relative change of the median. Changes beyond the noise threshold
// (default ±15%, override with WEBSTRATES_PERF_NOISE) are highlighted as
// improvements/regressions. Benchmarks present in only one file are listed
// separately.
//
// Not a mocha spec: when mocha loads this directory it also executes this
// module (harmlessly — the main block below is guarded); it is meant to be
// run directly with node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const load = file => {
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	return {
		file,
		label: data.environment && (data.environment.commit || data.environment.branch)
			? `${(data.environment.commit || '').slice(0, 8)}${data.environment.branch ? '@' + data.environment.branch : ''}`
			: path.basename(file),
		environment: data.environment,
		byName: new Map(data.results.map(r => [r.group + '/' + r.name, r]))
	};
};

const fmt = ms => Number.isFinite(ms) ? (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)) : '—';
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function main() {
	const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
	if (args.length < 2) {
		console.log('Usage: node tests/performance/compare.mjs <old.json> <new.json> [more.json …]');
		console.log('  Compares medians (and p95) of every benchmark in the files.');
		process.exit(args.length ? 0 : 1);
	}

	const noise = Number(process.env.WEBSTRATES_PERF_NOISE || 15); // percent
	const [oldFile, ...newFiles] = args;
	const oldRun = load(oldFile);
	const newRuns = newFiles.map(load);

	console.log(`\nPerformance comparison (median ms, noise threshold ±${noise}%)`);
	console.log(`  baseline: ${oldRun.label}  (${oldRun.file})`);
	for (const run of newRuns) {
		console.log(`     versus: ${run.label}  (${run.file})`);
	}

	let improved = 0, regressed = 0, unchanged = 0;

	for (const [key, old] of oldRun.byName) {
		console.log('\n  ' + old.group + ' › ' + old.name);
		console.log('    ' + pad('baseline', 10) + 'median ' + padL(fmt(old.stats.median), 8)
			+ '   p95 ' + padL(fmt(old.stats.p95), 8)
			+ '   (n=' + old.stats.n + ')');
		for (const run of newRuns) {
			const next = run.byName.get(key);
			if (!next) {
				console.log('    ' + pad('(absent)', 10) + 'not in ' + run.label);
				continue;
			}
			const delta = old.stats.median === 0 ? 0
				: 100 * (next.stats.median - old.stats.median) / old.stats.median;
			const verdict = Math.abs(delta) <= noise ? 'unchanged'
				: delta < 0 ? 'IMPROVED' : 'REGRESSED';
			if (verdict === 'IMPROVED') improved++;
			else if (verdict === 'REGRESSED') regressed++;
			else unchanged++;
			console.log('    ' + pad(run.label.slice(0, 9), 10)
				+ 'median ' + padL(fmt(next.stats.median), 8)
				+ '   p95 ' + padL(fmt(next.stats.p95), 8)
				+ '   ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%  ' + verdict);
		}
	}

	// Benchmarks that only exist in newer files (new benchmarks).
	for (const run of newRuns) {
		const fresh = [...run.byName.keys()].filter(k => !oldRun.byName.has(k));
		for (const key of fresh) {
			const r = run.byName.get(key);
			console.log('\n  ' + r.group + ' › ' + r.name);
			console.log('    (new in ' + run.label + ')  median ' + fmt(r.stats.median) + ' ms');
		}
	}

	console.log(`\nSummary: ${improved} improved, ${regressed} regressed, ${unchanged} unchanged `
		+ `(beyond ±${noise}%)`);
	process.exit(regressed > 0 ? 2 : 0);
}

if (isMain) {
	main();
}
