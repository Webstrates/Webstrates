// Test runner: makes `npm test` / `npm run test-all` self-contained.
//
//   node tests/lib/run-tests.mjs [mocha arguments...]
//
// 1. verifies the prerequisites the suites cannot start themselves (a webpack build of
//    the client bundle, and a reachable MongoDB), with actionable error messages;
// 2. starts a base Webstrates server against the harness base config
//    (tests/lib/server.base-config.json — upstream defaults + the test auth provider,
//    rate limiting inactive, no dropped-feature leftovers like godApi/pubsub). The base
//    config points the server at a dedicated test database (webstrate-test), never the
//    default database a real deployment would use, and the runner drops that database
//    again when it finishes — repeated runs start from a pristine database and no test
//    data accumulates anywhere else;
// 3. runs mocha with the given arguments, passing the base server's address and config
//    to the specs via WEBSTRATES_HARNESS_STATE (read by tests/config.js). Spec files that
//    need other configurations start their own instances through tests/lib/server-harness.mjs;
// 4. stops every harness server, reaps chromium processes the specs left behind
//    (specs whose hooks never finished do not close their own browsers), and exits
//    with mocha's exit code.
//
// An externally started server (the old workflow: install a config.json and run
// `node webstrates.js` yourself) keeps working when mocha is invoked directly, e.g.
// `npx mocha tests/unit-tests tests/functional-tests` — tests/config.js then falls back
// to the repo-root config.json.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The harness's own signal handlers would process.exit the runner before its
// teardown (which includes the chromium reaper) can run — the flag below makes the
// harness skip registering them. It has to be set before the harness module is
// evaluated, hence the dynamic import.
process.env.WEBSTRATES_HARNESS_NO_SIGNAL_HANDLERS = '1';
const harness = (await import('./server-harness.mjs')).default;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCHA_BIN = path.join(REPO_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const DEFAULT_SPECS = ['tests/unit-tests', 'tests/functional-tests'];

const fail = (message) => {
	console.error(`\n${message}\n`);
	process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. Prerequisites
// ---------------------------------------------------------------------------

const ensureBuild = async () => {
	const bundle = path.join(REPO_ROOT, 'static', 'webstrates.js');
	if (!fs.existsSync(bundle)) {
		console.log('No client bundle found (static/webstrates.js) — building it now (npm run build).');
		await new Promise((resolve, reject) => {
			const webpack = spawn(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js'),
				'--mode', 'production'], {
				cwd: REPO_ROOT,
				env: { ...process.env, NODE_ENV: 'production' },
				stdio: 'inherit'
			});
			webpack.on('error', reject);
			webpack.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`webpack exited with ${code}`)));
		});
	}
};

const ensureMongo = async () => {
	const baseConfig = JSON.parse(fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.base-config.json'), 'utf8'));
	const require = createRequire(import.meta.url);
	const { MongoClient } = require('mongodb');
	const client = new MongoClient(baseConfig.db, { serverSelectionTimeoutMS: 3000 });
	try {
		await client.db().command({ ping: 1 });
	} catch (err) {
		fail(`MongoDB is not reachable at ${baseConfig.db} (the test server stores documents ` +
			`and sessions there):\n  ${err.message}\nStart it (e.g. mongod --dbpath …) and re-run.`);
	} finally {
		await client.close().catch(() => {});
	}
};

// ---------------------------------------------------------------------------
// 2-4. Base server, mocha, teardown
// ---------------------------------------------------------------------------

// The suite runs against the harness's dedicated test database (see
// server.base-config.json; per-instance config overrides can point a server elsewhere).
// Drop it after the run so nothing accumulates from repeated runs and no test data ever
// touches a real deployment's database. Only databases whose name carries the harness's
// test prefix are ever dropped — a caller that deliberately pointed a server at another
// database keeps its data.
const TEST_DB_PREFIX = 'webstrate-test';

const dropTestDatabase = async (dbUrl) => {
	const dbName = new URL(dbUrl).pathname.replace(/^\//, '');
	if (!dbName.startsWith(TEST_DB_PREFIX)) {
		console.log(`Not dropping database "${dbName}" (no ${TEST_DB_PREFIX} prefix — not a harness test database).`);
		return;
	}
	const { MongoClient } = createRequire(import.meta.url)('mongodb');
	const client = new MongoClient(dbUrl, { serverSelectionTimeoutMS: 3000 });
	try {
		await client.connect();
		await client.db(dbName).dropDatabase();
		console.log(`Dropped test database ${dbName}.`);
	} catch (err) {
		console.error(`Could not drop test database ${dbName}: ${err.message}`);
	} finally {
		await client.close().catch(() => {});
	}
};

// ---------------------------------------------------------------------------
// Chromium leftovers
// ---------------------------------------------------------------------------

// A spec whose before-hook never finished does not reach its after-hook either, so
// the browser it was launching can outlive mocha: the launch is abandoned mid-flight
// and the orphaned chromium keeps running. Puppeteer marks every browser it launches
// with a temporary profile whose name starts with puppeteer_dev_chrome_profile, and
// once the launching process is gone such a browser is re-parented onto init. Any
// marked process without a living parent therefore belongs to a finished run and is
// killed here together with its process tree; browsers of a run that is still going
// hold a living parent and are left alone.
const PUPPETEER_PROFILE_MARK = 'puppeteer_dev_chrome_profile';

const reapOrphanedChromiums = async () => {
	const processes = [];
	try {
		for (const entry of fs.readdirSync('/proc')) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
				const ppidMatch =
					/^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${entry}/status`, 'utf8'));
				if (ppidMatch === null) continue; // the process went away while we were reading
				processes.push({
					pid: Number(entry),
					ppid: Number(ppidMatch[1]),
					marked: cmdline.includes(PUPPETEER_PROFILE_MARK)
				});
			} catch {
				// The process went away between the readdir and the read — the /proc
				// walk happens exactly when chromium trees are tearing down, so this
				// is routine. Skipping one entry must not abort the whole reap.
				continue;
			}
		}
	} catch {
		// No /proc to walk (non-Linux platform): nothing that can be done here.
		return;
	}

	const alive = new Set(processes.map((proc) => proc.pid));
	const victims = new Set();
	for (const proc of processes) {
		if (proc.marked && proc.ppid !== process.pid
			&& (proc.ppid === 1 || !alive.has(proc.ppid))) {
			victims.add(proc.pid);
		}
	}

	// Renderer and utility processes carry no profile marker of their own; they are
	// reached through their parents, so the victim set is closed over descendants.
	const childrenOf = new Map();
	for (const proc of processes) {
		if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, []);
		childrenOf.get(proc.ppid).push(proc.pid);
	}
	const stack = [...victims];
	while (stack.length > 0) {
		for (const child of childrenOf.get(stack.pop()) || []) {
			if (!victims.has(child)) {
				victims.add(child);
				stack.push(child);
			}
		}
	}

	if (victims.size === 0) return;
	// Chromium mains are detached process-group leaders, so signaling the group also
	// reaches helper processes forked between the scan above and the kill passes
	// below (a victim abandoned mid-launch is exactly a main still forking helpers).
	const killTree = (pid, signal) => {
		try { process.kill(-pid, signal); } catch { /* victim is no process-group leader */ }
		try { process.kill(pid, signal); } catch { /* already gone */ }
	};
	for (const pid of victims) {
		killTree(pid, 'SIGTERM');
	}
	await sleep(500);
	for (const pid of victims) {
		killTree(pid, 'SIGKILL');
	}
	console.log(`Reaped ${victims.size} orphaned chromium process(es) left behind by the specs.`);
};

const run = async () => {
	await ensureBuild();
	await ensureMongo();

	const mochaArgs = process.argv.slice(2);
	if (mochaArgs.length === 0) mochaArgs.push(...DEFAULT_SPECS);
	if (!fs.existsSync(MOCHA_BIN)) {
		fail(`mocha not found at ${MOCHA_BIN} — run npm install first.`);
	}

	console.log('Starting base test server (tests/lib/server.base-config.json)…');
	const base = await harness.startServer({ label: 'base', port: 7007, config: {} });
	console.log(`Base server up: ${base.address} — test database: ${base.config.db} (dropped after the run)`);

	const stateFile = path.join(os.tmpdir(), `webstrates-harness-state-${process.pid}.json`);
	fs.writeFileSync(stateFile, JSON.stringify({
		base: { label: base.label, port: base.port, address: base.address, config: base.config }
	}));

	// Chromium refuses to run as root without --no-sandbox (and root containers usually
	// lack the user namespaces the sandbox needs), so as root puppeteer goes through
	// tests/lib/chrome-wrapper, which adds the container-safe flags. An explicit
	// PUPPETEER_EXECUTABLE_PATH always wins.
	const chromeEnv = {};
	if (typeof process.getuid === 'function' && process.getuid() === 0
		&& !process.env.PUPPETEER_EXECUTABLE_PATH) {
		chromeEnv.PUPPETEER_EXECUTABLE_PATH = path.join(REPO_ROOT, 'tests', 'lib', 'chrome-wrapper');
		console.log('Running as root: puppeteer launches chromium through tests/lib/chrome-wrapper.');
	}

	// Mocha runs detached as its own process-group leader, so everything it spawns
	// (in particular servers that specs start through the harness) stays in that
	// group and can be swept with one group signal after mocha exits — mocha's
	// death orphans such children to init otherwise. Chromium puppeteer spawns
	// detaches into groups of its own; the reaper below catches those separately.
	const mocha = spawn(process.execPath, [MOCHA_BIN, ...mochaArgs], {
		cwd: REPO_ROOT,
		env: { ...process.env, WEBSTRATES_HARNESS_STATE: stateFile, ...chromeEnv },
		stdio: 'inherit',
		detached: true
	});

	// This runner owns the whole shutdown sequence: killing mocha first leaves any
	// chromium it still holds without a living parent, so the reaper below catches
	// them. Mocha gets a grace period to exit on its own (its worker pool may need
	// a moment under load) before it is killed outright. The teardown itself runs
	// once, on the main path below, whether mocha finished by itself or by signal.
	let signaled = null;
	const shutdown = async (signal, code) => {
		if (signaled !== null) return;
		signaled = code;
		mocha.kill(signal);
		const exited = await new Promise((resolve) => {
			const grace = setTimeout(() => resolve(false), 10000);
			mocha.once('exit', () => { clearTimeout(grace); resolve(true); });
		});
		if (!exited) mocha.kill('SIGKILL');
	};
	process.on('SIGINT', async () => { await shutdown('SIGINT', 130); });
	process.on('SIGTERM', async () => { await shutdown('SIGTERM', 143); });

	const mochaCode = await new Promise((resolve) => mocha.on('exit', resolve));

	// Whatever mocha's suites left running in its process group (a spec-started
	// server whose after-hook never ran, say) is swept here — on an interrupted run
	// those children are already orphaned to init.
	try { process.kill(-mocha.pid, 'SIGKILL'); } catch { /* group already gone */ }

	fs.rmSync(stateFile, { force: true });
	await harness.stopAll();
	await reapOrphanedChromiums();
	await dropTestDatabase(base.config.db);
	console.log(`Base server stopped. mocha exit code: ${signaled !== null ? signaled : mochaCode}`);
	process.exit(signaled !== null ? signaled : mochaCode);
};

run().catch(async (err) => {
	await harness.stopAll();
	await reapOrphanedChromiums();
	// Startup failed, but a base server may have started and written test data first —
	// the database configured for it (base config + harness test prefix guard) goes too.
	const baseConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.base-config.json');
	await dropTestDatabase(JSON.parse(fs.readFileSync(baseConfigPath, 'utf8')).db);
	fail(`Failed to start the test environment: ${err.message}\n${err.stack || ''}`);
});
