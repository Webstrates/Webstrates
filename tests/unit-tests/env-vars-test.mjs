// Environment variable config overrides (issue #85): the eight deployment-level
// config.json properties can each be replaced by a WEBSTRATES_* environment
// variable (see helpers/ConfigHelper.js): listeningAddress, listeningPort, db,
// uploadsDir, compressedSnapshots, niceWebstrateIds, maxAssetSize and
// compressedSnapshotCacheDir. These tests exercise the override logic in
// isolation — typed coercion, precedence over config.json, and invalid values;
// a running server configured through its environment is covered by
// tests/functional-tests/4-env-vars.mjs.
/* global describe after it */
import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

global.APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The values the fixture config.json carries. Every test that sets an
// environment variable sets it to something DIFFERENT, so "the config.json
// value survived" always means "the override did not apply".
const configValues = {
	listeningAddress: '127.0.0.1',
	listeningPort: 7285,
	db: 'mongodb://127.0.0.1:27017/webstrate-test-env-vars-unit-cfg',
	uploadsDir: '/uploads/from/config',
	compressedSnapshots: true,
	niceWebstrateIds: true,
	maxAssetSize: 100,
	compressedSnapshotCacheDir: 'cache-from-config'
};

// The module captures WEBSTRATES_CONFIG at load time, so it has to be set before
// the require below. The fixture config file it points at keeps the tests off
// the repo's own config.json (which getConfig() would otherwise create from the
// sample).
const configFixturePath = path.join(os.tmpdir(), `webstrates-env-vars-test-${process.pid}.json`);
fs.writeFileSync(configFixturePath, JSON.stringify(configValues));
process.env.WEBSTRATES_CONFIG = configFixturePath;

const require = createRequire(import.meta.url);
const configHelperPath = path.join(global.APP_PATH, 'helpers/ConfigHelper.js');
// ConfigHelper captures WEBSTRATES_CONFIG when it is loaded, and mocha loads
// all spec files into one process: whichever spec required it first would fix
// the fixture path for every other spec. Drop any cached copy and load a fresh
// one bound to the fixture above (tests/unit-tests/uploads-dir-test.mjs does
// the same, so the two specs stay order-independent).
delete require.cache[require.resolve(configHelperPath)];
const configHelper = require(configHelperPath);

// The eight override variables these tests set and clear, plus WEBSTRATES_CONFIG.
// Everything is cleared in after() so nothing leaks into the specs that run
// later in the same mocha process — their servers would inherit a stray
// override (a leftover WEBSTRATES_LISTENING_PORT would drag every spawned
// instance onto one port).
const ENV_VARS = [
	'WEBSTRATES_CONFIG',
	'WEBSTRATES_LISTENING_ADDRESS',
	'WEBSTRATES_LISTENING_PORT',
	'WEBSTRATES_DB',
	'WEBSTRATES_UPLOADS_DIR',
	'WEBSTRATES_COMPRESSED_SNAPSHOTS',
	'WEBSTRATES_NICE_WEBSTRATE_IDS',
	'WEBSTRATES_MAX_ASSET_SIZE',
	'WEBSTRATES_COMPRESSED_SNAPSHOT_CACHE_DIR'
];
const clearOverrides = () => ENV_VARS.slice(1).forEach((name) => delete process.env[name]);

describe('Environment variable config overrides', function () {

	after(() => {
		fs.unlinkSync(configFixturePath);
		ENV_VARS.forEach((name) => delete process.env[name]);
	});

	it('should keep the config.json values without environment variables', () => {
		clearOverrides();
		const config = configHelper.getConfig();
		// Value AND type must survive the merge with the sample config:
		// booleans stay booleans, numbers stay numbers.
		Object.entries(configValues).forEach(([key, value]) => {
			assert.deepStrictEqual(config[key], value,
				`"${key}" should keep its config.json value and type`);
		});
	});

	it('should let every environment variable override its config.json property', () => {
		process.env.WEBSTRATES_LISTENING_ADDRESS = '127.0.0.2';
		process.env.WEBSTRATES_LISTENING_PORT = '7299';
		process.env.WEBSTRATES_DB = 'mongodb://127.0.0.1:27017/webstrate-test-env-vars-unit-env';
		process.env.WEBSTRATES_UPLOADS_DIR = '/uploads/from/environment';
		// The fixture has both toggles enabled, so overriding them with 'false'
		// also proves the coercion: an uncoerced "false" string is truthy and
		// would leave the features on.
		process.env.WEBSTRATES_COMPRESSED_SNAPSHOTS = 'false';
		process.env.WEBSTRATES_NICE_WEBSTRATE_IDS = 'false';
		process.env.WEBSTRATES_MAX_ASSET_SIZE = '2';
		process.env.WEBSTRATES_COMPRESSED_SNAPSHOT_CACHE_DIR = 'cache-from-environment';
		try {
			const config = configHelper.getConfig();
			assert.strictEqual(config.listeningAddress, '127.0.0.2');
			assert.strictEqual(config.listeningPort, 7299,
				'WEBSTRATES_LISTENING_PORT should override and coerce to a number');
			assert.strictEqual(config.db, 'mongodb://127.0.0.1:27017/webstrate-test-env-vars-unit-env');
			assert.strictEqual(config.uploadsDir, '/uploads/from/environment');
			assert.strictEqual(config.compressedSnapshots, false,
				'WEBSTRATES_COMPRESSED_SNAPSHOTS should override and coerce to a boolean');
			assert.strictEqual(config.niceWebstrateIds, false,
				'WEBSTRATES_NICE_WEBSTRATE_IDS should override and coerce to a boolean');
			assert.strictEqual(config.maxAssetSize, 2,
				'WEBSTRATES_MAX_ASSET_SIZE should override and coerce to a number');
			assert.strictEqual(config.compressedSnapshotCacheDir, 'cache-from-environment');
		} finally {
			clearOverrides();
		}
	});

	it('should keep type coercion strict ("true"/"false", not anything truthy)', () => {
		process.env.WEBSTRATES_COMPRESSED_SNAPSHOTS = 'true';
		process.env.WEBSTRATES_NICE_WEBSTRATE_IDS = 'false';
		try {
			const config = configHelper.getConfig();
			assert.strictEqual(config.compressedSnapshots, true);
			assert.strictEqual(config.niceWebstrateIds, false);
		} finally {
			clearOverrides();
		}
	});

	it('should ignore values that do not parse as their type', () => {
		process.env.WEBSTRATES_LISTENING_PORT = '70000';          // above 65535
		process.env.WEBSTRATES_MAX_ASSET_SIZE = 'abc';            // not a number
		process.env.WEBSTRATES_COMPRESSED_SNAPSHOTS = 'yes';      // not a boolean
		// '1' is not a boolean either — never a "true" by accident.
		process.env.WEBSTRATES_NICE_WEBSTRATE_IDS = '1';
		try {
			const config = configHelper.getConfig();
			assert.strictEqual(config.listeningPort, configValues.listeningPort,
				'An out-of-range port should not override the config.json port');
			assert.strictEqual(config.maxAssetSize, configValues.maxAssetSize,
				'A non-numeric size should not override the config.json size');
			assert.strictEqual(config.compressedSnapshots, configValues.compressedSnapshots,
				'A non-boolean value should not override the config.json toggle');
			assert.strictEqual(config.niceWebstrateIds, configValues.niceWebstrateIds,
				'A non-boolean value should not override the config.json toggle');
		} finally {
			clearOverrides();
		}
	});

	it('should ignore non-integer ports, non-positive sizes and empty values', () => {
		process.env.WEBSTRATES_LISTENING_PORT = '7007.5';
		process.env.WEBSTRATES_MAX_ASSET_SIZE = '-1';
		process.env.WEBSTRATES_LISTENING_ADDRESS = '';
		process.env.WEBSTRATES_DB = '';
		try {
			const config = configHelper.getConfig();
			assert.strictEqual(config.listeningPort, configValues.listeningPort,
				'A non-integer port should not override the config.json port');
			assert.strictEqual(config.maxAssetSize, configValues.maxAssetSize,
				'A non-positive size should not override the config.json size');
			assert.strictEqual(config.listeningAddress, configValues.listeningAddress,
				'An empty address should not override the config.json address');
			assert.strictEqual(config.db, configValues.db,
				'An empty database URL should not override the config.json database');
		} finally {
			clearOverrides();
		}
	});

	it('should report invalid values instead of silently ignoring them', () => {
		process.env.WEBSTRATES_LISTENING_PORT = 'not-a-port';
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (...args) => warnings.push(args.join(' '));
		try {
			configHelper.getConfig();
		} finally {
			console.warn = originalWarn;
			clearOverrides();
		}
		assert.lengthOf(warnings, 1, 'Exactly the invalid variable should be reported');
		assert.include(warnings[0], 'WEBSTRATES_LISTENING_PORT');
		assert.include(warnings[0], 'not-a-port');
	});
});
