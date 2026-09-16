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
// 4. stops every harness server and exits with mocha's exit code.
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

import harness from './server-harness.mjs';

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

	const mocha = spawn(process.execPath, [MOCHA_BIN, ...mochaArgs], {
		cwd: REPO_ROOT,
		env: { ...process.env, WEBSTRATES_HARNESS_STATE: stateFile, ...chromeEnv },
		stdio: 'inherit'
	});

	const forward = (signal) => () => mocha.kill(signal);
	process.on('SIGINT', forward('SIGINT'));
	process.on('SIGTERM', forward('SIGTERM'));

	const mochaCode = await new Promise((resolve) => mocha.on('exit', resolve));

	fs.unlinkSync(stateFile);
	await harness.stopAll();
	await dropTestDatabase(base.config.db);
	console.log(`Base server stopped. mocha exit code: ${mochaCode}`);
	process.exit(mochaCode);
};

run().catch(async (err) => {
	await harness.stopAll();
	// Startup failed, but a base server may have started and written test data first —
	// the database configured for it (base config + harness test prefix guard) goes too.
	const baseConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.base-config.json');
	await dropTestDatabase(JSON.parse(fs.readFileSync(baseConfigPath, 'utf8')).db);
	fail(`Failed to start the test environment: ${err.message}\n${err.stack || ''}`);
});
