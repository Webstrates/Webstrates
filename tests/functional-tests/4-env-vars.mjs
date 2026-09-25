// Environment variable config overrides (issue #85): the eight deployment-level
// config.json properties can each be replaced by a WEBSTRATES_* environment
// variable (see helpers/ConfigHelper.js): listeningAddress, listeningPort, db,
// uploadsDir, compressedSnapshots, niceWebstrateIds, maxAssetSize and
// compressedSnapshotCacheDir.
//
// These tests boot a server whose config.json and whose environment
// deliberately disagree on every one of the eight, and verify that the
// environment wins everywhere a property is consumed — the address and port the
// server binds, the MongoDB database documents and sessions are written to,
// the uploads directory, the compressed snapshot cache, nice webstrate ids and
// the asset size limit — and that a server facing invalid values ignores them
// and uses its config.json settings instead.
//
// The server runs through the server harness's configFile mode: the harness
// dictates neither the configuration (the spec's file is used verbatim) nor the
// port — exactly so that the WEBSTRATES_* overrides decide where the server
// binds and what it reads, which is the mechanism under test.
/* global describe before after it */
import { assert } from 'chai';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
// Note: ESM can't import the lib/client directory subpath, hence the
// explicit index.js (the package has no "exports" restrictions).
import sharedb from 'sharedb/lib/client/index.js';
import harness from '../lib/server-harness.mjs';
import util from '../util.js';

// The ShareDB client can't consume the webstrates-specific 'wa' messages
// (hello, tags, assets, ...) the server may send, so silence the expected
// "Ignoring unrecognized message" noise while keeping other warnings visible.
{
	const warn = sharedb.logger.warn.bind(sharedb.logger);
	sharedb.logger.setMethods({
		info: () => {},
		warn: (...args) => {
			if (args[0] === 'Ignoring unrecognized message') return;
			warn(...args);
		}
	});
}

const { MongoClient } = createRequire(import.meta.url)('mongodb');

// Find a free TCP port: bind to port 0 and read back the ephemeral port the
// kernel assigned. Ports are picked fresh instead of fixed, so concurrent test
// runs on one host (or another server on this one) never collide.
const freePort = () => new Promise((resolve, reject) => {
	const probe = net.createServer();
	probe.once('error', reject);
	probe.listen(0, '127.0.0.1', () => {
		const port = probe.address().port;
		probe.close(() => resolve(port));
	});
});

// Create a document through a ShareDB client, the way the browser client does.
// A document created this way goes through ShareDB's op pipeline, which is also
// what feeds the compressed snapshot cache (see helpers/SnapshotCacheManager.js)
// and what makes the server create database, document and ops records.
const createWebstrate = (address, webstrateId) => new Promise((resolve, reject) => {
	const ws = new WebSocket(address.replace(/^http/, 'ws') + webstrateId);
	ws.on('error', reject);
	ws.on('open', () => {
		const connection = new sharedb.Connection(ws);
		const doc = connection.get('webstrates', webstrateId);
		// A json0 document with non-empty data: the snapshot cache only stores
		// documents whose snapshots actually carry data.
		doc.create(['body', 'created by the env-vars tests'], 'json0', (err) => {
			ws.close();
			err ? reject(err) : resolve();
		});
	});
});

// Wait up to 5 s (200 ms steps) for `predicate` to hold.
const waitFor = async (predicate, what) => {
	for (let slept = 0; slept < 5000; slept += 200) {
		if (predicate()) return;
		await sleep(200);
	}
	assert.fail(what);
};

describe('Environment variable config overrides', function () {
	this.timeout(90000);

	let baseDir, configFile;
	let configPort, envPort;
	let configUploadsDir, envUploadsDir, configCacheDir, envCacheDir;
	let server, webstrateId;
	let mongo;

	// The two test databases: the config.json one and the environment's. Both
	// carry the harness's webstrate-test prefix and are dropped after the run.
	const configDb = 'webstrate-test-env-vars-cfg';
	const envDb = 'webstrate-test-env-vars-env';

	before(async () => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstrates-env-vars-'));
		configFile = path.join(baseDir, 'config.json');
		configUploadsDir = path.join(baseDir, 'uploads-from-config');
		envUploadsDir = path.join(baseDir, 'uploads-from-environment');
		configCacheDir = path.join(baseDir, 'cache-from-config');
		envCacheDir = path.join(baseDir, 'cache-from-environment');

		[configPort, envPort] = [await freePort(), await freePort()];

		fs.writeFileSync(configFile, JSON.stringify({
			// config.json says: 127.0.0.1:<configPort>, the config database,
			// config directories, both features off, 100 MB assets.
			listeningAddress: '127.0.0.1',
			listeningPort: configPort,
			db: `mongodb://127.0.0.1:27017/${configDb}`,
			uploadsDir: configUploadsDir,
			compressedSnapshots: false,
			niceWebstrateIds: false,
			maxAssetSize: 100,
			compressedSnapshotCacheDir: configCacheDir,
			// Not one of the overridable properties: a low debounce makes the
			// snapshot cache entry appear quickly once ops settle.
			compressedSnapshotDebounceMs: 300,
			auth: {
				cookie: { secret: 'env-vars-test-secret', duration: 31536000000 },
				permissionTimeout: 300,
				defaultPermissions: [
					{ username: 'anonymous', provider: '', permissions: 'arw' }
				],
				providers: { test: {} }
			}
		}));

		// The environment says the opposite on every one of the eight.
		server = await harness.startServer({
			label: 'env-vars',
			configFile,
			address: `http://127.0.0.2:${envPort}/`,
			env: {
				WEBSTRATES_LISTENING_ADDRESS: '127.0.0.2',
				WEBSTRATES_LISTENING_PORT: String(envPort),
				WEBSTRATES_DB: `mongodb://127.0.0.1:27017/${envDb}`,
				WEBSTRATES_UPLOADS_DIR: envUploadsDir,
				WEBSTRATES_COMPRESSED_SNAPSHOTS: 'true',
				WEBSTRATES_NICE_WEBSTRATE_IDS: 'true',
				WEBSTRATES_MAX_ASSET_SIZE: '1',
				WEBSTRATES_COMPRESSED_SNAPSHOT_CACHE_DIR: envCacheDir
			}
		});

		webstrateId = 'test-' + util.randomString();
		await createWebstrate(server.address, webstrateId);

		mongo = new MongoClient('mongodb://127.0.0.1:27017');
		await mongo.connect();
	});

	after(async () => {
		// Stop the servers first (harness.stopAll: whatever else fails below, a
		// live server would keep holding its port and database), then drop the
		// test databases through the (only) mongo client — an open connection
		// pool keeps mocha from exiting, so the client is closed right after —
		// then remove the spec's files. (A failed before() hook runs this with
		// nothing set up: every step guards itself.)
		await harness.stopAll().catch(() => {});
		if (mongo) {
			// Both databases carry the harness's webstrate-test prefix; nothing
			// that isn't a test database is ever dropped here.
			for (const dbName of [configDb, envDb]) {
				if (!dbName.startsWith('webstrate-test')) continue;
				await mongo.db(dbName).dropDatabase().catch(() => {});
			}
			await mongo.close().catch(() => {});
		}
		if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
	});

	// Whether a fetch to `url` fails to connect (nothing listening there).
	const unreachable = async (url) => {
		try {
			await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
			return false;
		} catch {
			return true;
		}
	};

	it('should bind the address and port from the environment', async () => {
		// The server answers where the environment put it…
		const response = await fetch(server.address, { redirect: 'manual' });
		assert.isBelow(response.status, 500,
			'The server should answer on WEBSTRATES_LISTENING_ADDRESS and WEBSTRATES_LISTENING_PORT');
		// …and nowhere else: not on config.json's address (the configured
		// 127.0.0.1 must not be bound when the environment says 127.0.0.2)…
		assert.isTrue(await unreachable(`http://127.0.0.1:${envPort}/`),
			'The server should not be reachable on the config.json address');
		// …and not on config.json's port.
		assert.isTrue(await unreachable(`http://127.0.0.1:${configPort}/`),
			'The server should not be reachable on the config.json port');
	});

	it('should use the database URL from the environment', async () => {
		const inEnvDb = await mongo.db(envDb)
			.collection('webstrates').findOne({ _id: webstrateId });
		assert.isDefined(inEnvDb,
			'The document should live in the database named by WEBSTRATES_DB');
		const inConfigDb = await mongo.db(configDb)
			.collection('webstrates').findOne({ _id: webstrateId });
		assert.isNull(inConfigDb,
			'Nothing should be written to the database named in config.json');
	});

	it('should give new webstrates nice ids from the environment', async () => {
		// GET /new redirects twice — /new → /new/ → /<id>/ — so follow it to the
		// end: the final URL carries the generated id.
		const response = await fetch(`${server.address}new`, { redirect: 'follow' });
		assert.match(response.url, /\/[a-z]{2,13}-[a-z]{2,13}-\d{1,3}\/$/,
			'WEBSTRATES_NICE_WEBSTRATE_IDS=true should redirect to a nice id');
	});

	it('should store uploads in the directory from the environment', async () => {
		const content = 'asset for the env-vars tests ' + util.randomString(10);
		const form = new FormData();
		form.append('file', new Blob([content]), 'env-vars-test.txt');
		const upload = await fetch(`${server.address}${webstrateId}/`,
			{ method: 'POST', body: form });
		assert.equal(upload.status, 200, 'Uploading an asset should succeed');

		const assets = await (await fetch(`${server.address}${webstrateId}?assets`)).json();
		const asset = assets.find(asset => asset.fileName === 'env-vars-test.txt');
		assert.isDefined(asset, 'The webstrate should have the uploaded asset');
		assert.isTrue(fs.existsSync(path.join(envUploadsDir, asset.identifier)),
			'The asset should be stored in the directory named by WEBSTRATES_UPLOADS_DIR');
		assert.isFalse(fs.existsSync(path.join(configUploadsDir, asset.identifier)),
			'The asset should not be stored in the directory named in config.json');

		const served = await fetch(`${server.address}${webstrateId}/env-vars-test.txt`);
		assert.equal(await served.text(), content, 'The asset should be served back');
	});

	it('should limit asset sizes to the size from the environment', async () => {
		// 1.5 MB: allowed by config.json's maxAssetSize of 100, rejected by
		// WEBSTRATES_MAX_ASSET_SIZE=1 (megabytes).
		const form = new FormData();
		form.append('file', new Blob(['x'.repeat(1.5 * 1024 * 1024)]), 'too-big.txt');
		const upload = await fetch(`${server.address}${webstrateId}/`,
			{ method: 'POST', body: form });
		assert.equal(upload.status, 409, 'An asset above WEBSTRATES_MAX_ASSET_SIZE should be rejected');
		assert.include(await upload.text(), 'Maximum file size exceeded');
	});

	it('should write the snapshot cache into the directory from the environment', async () => {
		const envEntry = path.join(envCacheDir, encodeURIComponent(webstrateId) + '.json.br');
		await waitFor(() => fs.existsSync(envEntry),
			`A compressed snapshot entry should appear in ${envCacheDir}`);
		// config.json had compressedSnapshots: false with its own cache
		// directory: the feature runs only because of the environment, so the
		// config.json directory is never even created.
		assert.isFalse(fs.existsSync(configCacheDir),
			'The directory named in config.json should not be used at all');
	});

	it('should ignore invalid environment values and use config.json instead', async () => {
		const invalidServer = await harness.startServer({
			label: 'env-vars-invalid',
			configFile,
			// The environment is broken on three properties: the server must
			// ignore them (with a warning) and come up on config.json's address
			// and port instead.
			address: `http://127.0.0.1:${configPort}/`,
			env: {
				WEBSTRATES_LISTENING_PORT: '99999',
				WEBSTRATES_MAX_ASSET_SIZE: 'abc',
				WEBSTRATES_COMPRESSED_SNAPSHOTS: 'maybe'
			}
		});

		const log = fs.readFileSync(invalidServer.logFile, 'utf8');
		assert.include(log, 'WEBSTRATES_LISTENING_PORT', 'The invalid port should be reported');
		assert.include(log, 'WEBSTRATES_MAX_ASSET_SIZE', 'The invalid size should be reported');
		assert.include(log, 'WEBSTRATES_COMPRESSED_SNAPSHOTS', 'The invalid toggle should be reported');
		assert.include(log, 'using the config.json value',
			'The report should say the config.json value is used instead');

		// A rejected WEBSTRATES_COMPRESSED_SNAPSHOTS must not fall back to
		// truthy-string semantics: config.json's niceWebstrateIds=false stays
		// false, so /new redirects to a random id, not a nice one.
		const response = await fetch(`${invalidServer.address}new`, { redirect: 'follow' });
		assert.notMatch(response.url, /\/[a-z]{2,13}-[a-z]{2,13}-\d{1,3}\/$/,
			'An invalid value should leave niceWebstrateIds as configured (off)');

		await invalidServer.stop();
	});
});
