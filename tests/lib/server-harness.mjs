// Server harness for the Webstrates test suites.
//
// Spawns `node webstrates.js` child processes against generated configuration files and
// tears them down again, so the suites exercise the configurations they need instead of
// depending on whatever config.json a developer happens to have installed next to the
// repo (see tests/config.js: one installed config used to swing full-suite results
// between "all green" and "26 failures" depending on e.g. an active rateLimit block).
//
// Usage (from spec files or the runner, see tests/lib/run-tests.mjs):
//   import harness from '../lib/server-harness.mjs';
//   const server = await harness.startServer({
//     label: 'ratelimit',                       // used in log/temp file names
//     port: 7011,                                // preferred port; random free one if omitted
//     config: { rateLimit: { ... } }             // deep-merged over the base config
//   });
//   // or, to exercise WEBSTRATES_* env overrides against a config.json of the
//   // spec's own choosing (the harness then dictates neither config nor port):
//   const server = await harness.startServer({
//     label: 'env-vars', configFile: 'spec-config.json',
//     address: 'http://127.0.0.2:7185/',         // where the env vars put the server
//     env: { WEBSTRATES_LISTENING_ADDRESS: '127.0.0.2', ... }
//   });
//   server.address  // e.g. http://localhost:7011/ — point tests at this
//   server.config   // the exact config the server is running (including the chosen port)
//   await server.stop();
//
// The base configuration (tests/lib/server.base-config.json) matches upstream defaults
// plus the `test` auth provider the suites log in with; per-instance overrides are
// deep-merged on top. Every instance gets its own config file and log file under os.tmpdir()
// for post-mortem inspection.
//
// The server reads its config through the WEBSTRATES_CONFIG environment variable
// (helpers/ConfigHelper.js), which is what makes instances with different configurations
// coexist against one checkout.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.base-config.json');
const START_TIMEOUT_MS = 20000;

const servers = [];

// Kill every tracked server now; safe to call repeatedly. The array is snapshotted
// first: stop() removes each server from `servers` as it goes, and a plain map()
// re-reads the shrinking array length on every iteration, skipping every server
// after the first (leaking their child processes and the mocha run's exit).
const stopAll = () => Promise.all([...servers].map((server) => server.stop().catch(() => {})));

// Deep merge `override` into `base`: plain objects merge recursively, everything else
// (including arrays) is replaced by the override value.
const mergeConfig = (base, override) => {
	if (Array.isArray(override) || typeof override !== 'object' || override === null) {
		return override === undefined ? base : override;
	}
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		result[key] = key in result ? mergeConfig(result[key], value) : value;
	}
	return result;
};

// Find a free TCP port: the preferred one if it is free, otherwise any (bind to port 0
// and read back the ephemeral port the kernel assigned — note that address() must be
// read before the close, it is null afterwards).
const findFreePort = (preferred) => new Promise((resolve, reject) => {
	const tryBind = (port, fallback) => {
		const probe = net.createServer();
		probe.once('error', () => fallback());
		probe.listen(port, '0.0.0.0', () => {
			const assigned = probe.address().port;
			probe.close(() => resolve(assigned));
		});
	};
	if (preferred) {
		tryBind(preferred, () => tryBind(0, () => reject(new Error('no free port'))));
	} else {
		tryBind(0, () => reject(new Error('no free port')));
	}
});

// Wait until the server answers HTTP on its port (any status code counts — the root path
// redirects), or until it exits (e.g. the port was taken between probing and binding).
const waitForServer = async (server) => {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (server.child.exitCode !== null) {
			throw new Error(`server "${server.label}" exited during startup (code ${server.child.exitCode}); ` +
				`see ${server.logFile}`);
		}
		try {
			await fetch(`${server.address}`, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
			return;
		} catch {
			await sleep(100);
		}
	}
	throw new Error(`server "${server.label}" did not come up within ${START_TIMEOUT_MS} ms; see ${server.logFile}`);
};

/**
 * Start a Webstrates server instance against a generated configuration.
 * @param  {Object} opts
 * @param  {string} [opts.label]      Instance name (log and config file names).
 * @param  {number} [opts.port]        Preferred port; a random free one if omitted.
 * @param  {Object} [opts.config]      Overrides deep-merged over the base config.
 * @param  {Object} [opts.env]         Extra environment variables for the server process
 *                                     (e.g. WEBSTRATES_UPLOADS_DIR to test env-var overrides,
 *                                     which take precedence over the generated config file).
 * @param  {string} [opts.configFile]  Use this config file verbatim instead of generating
 *                                     one: no sample/base merge, and the harness does NOT
 *                                     dictate the port (the point is to let the file and
 *                                     `env` disagree, so the WEBSTRATES_* overrides decide
 *                                     where the server binds). Requires `address`.
 * @param  {string} [opts.address]     Where the configFile-mode server comes up (waited
 *                                     on and reported as server.address). Required with
 *                                     configFile, ignored without it.
 * @return {Promise<Object>}           { label, port, address, config, child, logFile, stop }
 */
const startServer = async ({ label = `server-${servers.length + 1}`, port, config = {}, env = {},
	configFile, address } = {}) => {
	if (configFile) {
		if (port !== undefined || Object.keys(config).length > 0) {
			throw new Error('configFile cannot be combined with port or config ' +
				'overrides (the file is used verbatim)');
		}
		if (!address) {
			throw new Error('configFile requires address (the harness cannot know ' +
				'where the server will bind)');
		}
	}
	const port_ = configFile ? null : await findFreePort(port);
	let fullConfig;
	if (configFile) {
		// The spec's own config file, verbatim: server.config reports its contents (the
		// WEBSTRATES_* overrides from `env` apply on top at runtime — see ConfigHelper).
		fullConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
	} else {
		// The effective configuration the server will run: the sample's defaults, overridden
		// by the base config, overridden by this instance's overrides. Building it here (the
		// same merge the server applies to a config.json against the sample — see
		// helpers/ConfigHelper.js) means server.config reports exactly what runs, including
		// keys only the sample provides (e.g. messageRateLimit, maxZipEntries).
		const sample = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config-sample.json'), 'utf8'));
		const baseConfig = JSON.parse(fs.readFileSync(BASE_CONFIG_PATH, 'utf8'));
		fullConfig = mergeConfig(mergeConfig(sample, baseConfig), config);
		// The harness always dictates the port: instances with the same base config (which
		// carries listeningPort 7007) must not fight over it.
		fullConfig.listeningPort = port_;
	}

	const tmp = os.tmpdir();
	// Generated configurations get the compressed-snapshot cache pointed at a private
	// directory: the sample config points it at a directory relative to the repo cwd,
	// which every concurrently running server instance (and every suite sharing this
	// checkout) would write into. Random webstrate ids make actual cache collisions
	// between instances unlikely, but the cache is per-server mutable state and deserves
	// the same isolation as the port. (Entry names are just the webstrate id, so sharing
	// also let one suite's entries accumulate in another's checkout forever.) A
	// configFile the spec provided verbatim is left alone — its cache settings are part
	// of what the spec is exercising.
	if (!configFile) {
		fullConfig.compressedSnapshotCacheDir = path.join(
			fs.mkdtempSync(path.join(tmp, 'webstrates-harness-')), 'snapshot-cache');
	}
	// Config and log files carry the spawning process's pid in their name: labels are the
	// same across test suites (every suite's ratelimit tests use "ratelimit"), so on a
	// shared host two concurrent runs would otherwise overwrite each other's config mid-
	// boot and interleave their logs (the state file is already pid-unique).
	const configFilePath = path.join(tmp, `webstrates-harness-config-${label}-${process.pid}.json`);
	const logFile = path.join(tmp, `webstrates-harness-${label}-${process.pid}.log`);
	if (!configFile) {
		fs.writeFileSync(configFilePath, JSON.stringify(fullConfig, null, '\t'));
	}

	// The harness dictates every instance's configuration through the generated
	// config file (and per-instance `env` overrides, applied after this). A
	// WEBSTRATES_* variable inherited from the shell running the tests would
	// override the harness's own choices — every instance would bind the same
	// WEBSTRATES_LISTENING_PORT, say — so the inherited environment is cleaned
	// first. (WEBSTRATES_CONFIG is set explicitly below; `env` is applied on
	// top and may deliberately carry WEBSTRATES_* variables, e.g. the
	// uploads-dir suite sets WEBSTRATES_UPLOADS_DIR.)
	const cleanEnv = { ...process.env };
	Object.keys(cleanEnv).forEach((key) => {
		if (key.startsWith('WEBSTRATES_')) delete cleanEnv[key];
	});

	// One file descriptor for both streams, so stdout and stderr interleave
	// chronologically in the log: with two descriptors ('w' for stdout, 'a'
	// for stderr) the first stdout write restarts at offset 0 and overwrites
	// whatever early stderr (startup warnings) had already been appended.
	const logFd = fs.openSync(logFile, 'w');
	const child = spawn(process.execPath, [path.join(REPO_ROOT, 'webstrates.js')], {
		cwd: REPO_ROOT,
		env: { ...cleanEnv, WEBSTRATES_CONFIG: configFile || configFilePath, ...env },
		stdio: ['ignore', logFd, logFd]
	});

	const server = {
		label,
		port: port_,
		address: address || `http://localhost:${port_}/`,
		config: fullConfig,
		child,
		logFile,
		async stop() {
			const index = servers.indexOf(server);
			if (index === -1) return; // already stopped
			servers.splice(index, 1);
			if (server.child.exitCode === null) {
				server.child.kill('SIGTERM');
				await new Promise((resolve) => {
					const exited = server.child.once.bind(server.child, 'exit', resolve);
					const timer = setTimeout(() => {
						server.child.removeListener('exit', exited);
						server.child.kill('SIGKILL');
						resolve();
					}, 3000);
					server.child.once('exit', () => { clearTimeout(timer); resolve(); });
				});
			}
		}
	};

	servers.push(server);

	try {
		await waitForServer(server);
	} catch (err) {
		await server.stop();
		throw err;
	}

	return server;
};

// Never leave servers behind, however the importing process ends (crash, mocha --bail,
// unhandled rejection): killing a child is synchronous-safe in an exit handler.
process.on('exit', () => {
	servers.forEach((server) => server.child.kill('SIGKILL'));
});
process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
process.on('SIGTERM', async () => { await stopAll(); process.exit(143); });

export default { startServer, stopAll };
export { startServer, stopAll };
