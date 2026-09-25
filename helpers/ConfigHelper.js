'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// By default the server reads its config from <repo>/config.json. Setting the
// WEBSTRATES_CONFIG environment variable (absolute path, or relative to the repo root)
// overrides this; the test harness uses it to run server instances against generated
// configurations (see tests/lib/server-harness.mjs).
const envConfigPath = process.env.WEBSTRATES_CONFIG;
const configPath = '/config.json';
const sampleConfigPath = '/config-sample.json';

const resolveConfigPath = () => envConfigPath
	? (path.isAbsolute(envConfigPath) ? envConfigPath : path.resolve(APP_PATH, envConfigPath))
	: APP_PATH + configPath;

/** Create config file if it doesn't already exist by copying config-sample. */
const createConfig = () => {
	// The env-provided config is expected to exist (the harness always writes it before
	// starting a server); only the default repo-root config is auto-created from the sample.
	if (envConfigPath) {
		if (!fs.existsSync(resolveConfigPath())) {
			console.error(`Config file "${resolveConfigPath()}" (from WEBSTRATES_CONFIG) not found, terminating`);
			process.exit(1);
		}
		return;
	}
	if (!fs.existsSync(APP_PATH+configPath)) {
		console.warn('No config file present, creating one now');
		if (!fs.existsSync(APP_PATH+sampleConfigPath)) {
			console.error('Sample config not present either, terminating');
			process.exit(1);
		} else {
			try {
				fs.writeFileSync(APP_PATH+configPath, JSON.stringify(getSampleConfig(), null, '\t'));
			} catch (err) {
				console.error('Error creating config file from sample:', err);
				process.exit(1);
			}
		}
	}
};

/** Read config file from disk. */
const getConfig = () => {
	try {
		return JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf8'));
	} catch (e) {
		console.error(envConfigPath
			? `Unable to read config file "${resolveConfigPath()}".`
			: 'Unable to parse config file.');
		process.exit(1);
	}
};

/** Read sample config from disk and add a randomly generated cookie encryption key. */
const getSampleConfig = () => {
	const config = JSON.parse(fs.readFileSync(APP_PATH+sampleConfigPath, 'utf8'));
	const randomSecret = crypto.randomBytes(16).toString('base64');
	config.auth.cookie.secret = randomSecret;
	return config;
};

/**
 * Merge two objects. Use target object with filler as a prototype, e.g. use the property on
 * target if it exists, otherwise copy over the property from filler to the target object.
 * @param  {Object} target Object to base result on.
 * @param  {Object} filler Object to copy missing properties from onto target.
 * @return {Object}        target object with missing properties from filler object.
 */
const mergeJSON = (target, filler) => {
	if (!target) return filler;

	if (typeof filler === 'object') {
		Object.entries(filler).forEach(([key, value]) => {
			target[key] = mergeJSON(target[key], filler[key]);
		});
	}

	return target || filler;
};

/**
 * Environment variables that override individual config.json properties
 *
 * Each entry maps a config property to its environment variable and the
 * property's type — environment variables are strings, so numbers and
 * booleans have to be coerced back
 */
const ENV_OVERRIDES = {
	// Address the HTTP server binds, e.g. WEBSTRATES_LISTENING_ADDRESS=127.0.0.1.
	listeningAddress: { env: 'WEBSTRATES_LISTENING_ADDRESS', type: 'string' },
	// Port the HTTP server binds, e.g. WEBSTRATES_LISTENING_PORT=7007.
	listeningPort: { env: 'WEBSTRATES_LISTENING_PORT', type: 'port' },
	// MongoDB connection URL, e.g. WEBSTRATES_DB=mongodb://127.0.0.1:27017/webstrate.
	db: { env: 'WEBSTRATES_DB', type: 'string' },
	// Directory uploads (assets) are stored in, e.g. WEBSTRATES_UPLOADS_DIR=/var/webstrates/uploads.
	uploadsDir: { env: 'WEBSTRATES_UPLOADS_DIR', type: 'string' },
	// Store snapshots of settled documents as compressed cache entries,
	// e.g. WEBSTRATES_COMPRESSED_SNAPSHOTS=false. (The client's compressed
	// fast path reads a copy of this flag baked into the bundle at build time —
	// the server-side cache follows this setting as it is configured.)
	compressedSnapshots: { env: 'WEBSTRATES_COMPRESSED_SNAPSHOTS', type: 'boolean' },
	// Give new webstrates human-readable ids, e.g. WEBSTRATES_NICE_WEBSTRATE_IDS=true.
	niceWebstrateIds: { env: 'WEBSTRATES_NICE_WEBSTRATE_IDS', type: 'boolean' },
	// Maximum asset upload size in megabytes, e.g. WEBSTRATES_MAX_ASSET_SIZE=50.
	maxAssetSize: { env: 'WEBSTRATES_MAX_ASSET_SIZE', type: 'number' },
	// Directory compressed snapshot cache entries are stored in,
	// e.g. WEBSTRATES_COMPRESSED_SNAPSHOT_CACHE_DIR=/var/webstrates/snapshot-cache.
	compressedSnapshotCacheDir: { env: 'WEBSTRATES_COMPRESSED_SNAPSHOT_CACHE_DIR', type: 'string' }
};

/** What a valid value of each ENV_OVERRIDES type looks like, for warning messages. */
const TYPE_DESCRIPTIONS = {
	string: 'a non-empty string',
	number: 'a positive number',
	port: 'an integer between 1 and 65535',
	boolean: '"true" or "false"'
};

/**
 * Coerce an environment variable's string value to the type its config property
 * expects. Returns undefined when the value is unset, empty, or does not parse
 * as its type, so the config.json value survives.
 * @param  {string} value Environment variable value.
 * @param  {string} type  Config property type: 'string', 'number', 'port' or 'boolean'.
 * @return {string|number|boolean|undefined} Coerced value, or undefined if not coercible.
 */
const coerceEnvValue = (value, type) => {
	if (typeof value !== 'string' || value === '') return undefined;
	switch (type) {
		case 'boolean':
			// Strictly 'true' or 'false': 'yes', '1' or 'TRUE' are mistakes worth
			// reporting, not guesses to interpret (see applyEnvOverrides).
			if (value === 'true') return true;
			if (value === 'false') return false;
			return undefined;
		case 'number': {
			const number = Number(value);
			// A zero or negative size is a mistake too, not a limit to honor.
			if (!Number.isFinite(number) || number <= 0) return undefined;
			return number;
		}
		case 'port': {
			const port = Number(value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
			return port;
		}
		default:
			return value;
	}
};

/**
 * Apply the environment overrides (ENV_OVERRIDES) onto a config object. Values
 * that don't parse as their property's type are reported and ignored: the
 * operator asked for an override and would otherwise silently not get one.
 * @param  {Object} config Config object (mutated in place).
 * @return {Object}        The same config object.
 */
const applyEnvOverrides = (config) => {
	Object.entries(ENV_OVERRIDES).forEach(([configKey, { env: envVar, type }]) => {
		const raw = process.env[envVar];
		const value = coerceEnvValue(raw, type);
		if (value !== undefined) {
			config[configKey] = value;
		} else if (raw !== undefined && raw !== '') {
			console.warn(`Ignoring environment override ${envVar}="${raw}" (${envVar} must be ` +
				`${TYPE_DESCRIPTIONS[type]}); using the config.json value for "${configKey}" instead.`);
		}
	});
	return config;
};

/**
 * Get merge configs from disk as object.
 * @return {Object} Config.
 */
exports.getConfig = () => {
	createConfig();
	return applyEnvOverrides(mergeJSON(getConfig(), getSampleConfig()));
};

/**
 * Absolute path of the directory uploaded assets are stored in, with a trailing path
 * separator (callers concatenate file names onto it). 
 * @param  {Object} [cfg] Config to read `uploadsDir` from (defaults to global.config).
 * @return {string}      Absolute uploads directory path, with trailing separator.
 */
exports.uploadsPath = (cfg) => {
	const uploadsDir = (cfg || global.config || {}).uploadsDir || 'uploads';
	return path.join(path.resolve(APP_PATH, uploadsDir), path.sep);
};