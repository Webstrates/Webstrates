// Uploads directory configuration (issue #86): the `uploadsDir` config.json property
// defines where uploaded assets are stored, and the WEBSTRATES_UPLOADS_DIR environment
// variable overrides it. These tests run against their own server instances (through
// the harness) because the base server's uploads directory is the repo's `uploads/`
// directory, which the other suites exercise implicitly.
/* global describe before after it */
import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ZipArchive } from 'archiver';
import harness from '../lib/server-harness.mjs';
import util from '../util.js';

// Creates a ZIP archive in memory from a list of [name, data] entries.
const makeZip = (entries) => new Promise((resolve, reject) => {
	const archive = new ZipArchive();
	const chunks = [];
	archive.on('data', chunk => chunks.push(chunk));
	archive.on('warning', reject);
	archive.on('end', () => resolve(Buffer.concat(chunks)));
	archive.on('error', reject);
	entries.forEach(([name, data]) => archive.append(data, { name }));
	archive.finalize();
});

// Uploads `content` as `fileName` to the webstrate at `webstrateId` on the server at
// `address`, returning the server's asset record.
const uploadAsset = async (address, webstrateId, fileName, content) => {
	const form = new FormData();
	form.append('file', new Blob([content]), fileName);
	const response = await fetch(`${address}${webstrateId}/`, { method: 'POST', body: form });
	assert.equal(response.status, 200, `Uploading ${fileName} should succeed`);
	return await response.json();
};

// The identifier (the name the file is stored under on disk) of a webstrate's asset.
const identifierOf = async (address, webstrateId, fileName) => {
	const assets = await (await fetch(`${address}${webstrateId}?assets`)).json();
	const asset = assets.find(asset => asset.fileName === fileName);
	assert.isDefined(asset, `The webstrate should have an asset ${fileName}`);
	return asset.identifier;
};

// Creates a webstrate through the server-side ZIP import (a minimal index.html), the
// same way the ZIP import suite in 3-assets.mjs does. A plain GET of the webstrate URL
// only serves the client template; the document is created by the browser client.
const createWebstrate = async (address, webstrateId) => {
	const zip = await makeZip([['index.html', `<html><body>${webstrateId}</body></html>`]]);
	const form = new FormData();
	form.append('file', new Blob([zip]), 'create.zip');
	const response = await fetch(`${address}new?apiCall&id=${webstrateId}`,
		{ method: 'POST', body: form });
	assert.equal(response.status, 200, `Creating ${webstrateId} should succeed`);
};

describe('Uploads directory configuration', function () {
	this.timeout(30000);

	let server, envServer;
	let webstrateId, configuredBase, configuredDir, envBase, envDir, zipFileContent;

	before(async () => {
		// The configured directory points at a path that does not exist yet: the server
		// has to create it (multer does, and the ZIP import writes straight into it).
		configuredBase = fs.mkdtempSync(path.join(os.tmpdir(), 'webstrates-uploads-config-'));
		configuredDir = path.join(configuredBase, 'uploads');

		// The environment variable points at another not-yet-existing directory.
		envBase = fs.mkdtempSync(path.join(os.tmpdir(), 'webstrates-uploads-env-'));
		envDir = path.join(envBase, 'uploads');

		// A server with the directory configured in its config.json, and a server where
		// the WEBSTRATES_UPLOADS_DIR environment variable overrides that configuration.
		server = await harness.startServer({
			label: 'uploads-dir-config',
			config: { uploadsDir: configuredDir }
		});
		envServer = await harness.startServer({
			label: 'uploads-dir-env',
			config: { uploadsDir: configuredDir },
			env: { WEBSTRATES_UPLOADS_DIR: envDir }
		});

		webstrateId = 'test-' + util.randomString();
		await createWebstrate(server.address, webstrateId);

		// Unique contents make every run's files unique, so identifiers can never clash
		// with files left behind by earlier runs (or the other suites).
		zipFileContent = 'zip asset for the uploads-dir tests ' + util.randomString(10);
	});

	after(async () => {
		await fetch(`${server.address}${webstrateId}?delete`).catch(() => {});
		await harness.stopAll();
		fs.rmSync(configuredBase, { recursive: true, force: true });
		fs.rmSync(envBase, { recursive: true, force: true });
	});

	it('should create the configured uploads directory', async () => {
		assert.isTrue(fs.existsSync(configuredDir),
			'The server should create the directory configured as uploadsDir');
	});

	it('should upload assets into the directory configured in config.json', async () => {
		await uploadAsset(server.address, webstrateId, 'uploads-dir-test.txt',
			'asset for the uploads-dir tests ' + util.randomString(10));
		const identifier = await identifierOf(server.address, webstrateId, 'uploads-dir-test.txt');
		assert.isTrue(fs.existsSync(path.join(configuredDir, identifier)),
			'The uploaded file should be stored in the configured uploads directory');
	});

	it('should serve assets from the configured uploads directory', async () => {
		const content = 'served asset for the uploads-dir tests ' + util.randomString(10);
		await uploadAsset(server.address, webstrateId, 'uploads-dir-served.txt', content);

		const response = await fetch(`${server.address}${webstrateId}/uploads-dir-served.txt`);
		assert.equal(response.status, 200, 'The uploaded asset should be served from its URL');
		assert.equal(await response.text(), content, 'The served content should match the upload');
	});

	it('should store assets from ZIP imports in the configured uploads directory', async () => {
		const zip = await makeZip([
			['index.html', '<html><body>uploads dir zip import test</body></html>'],
			['zip-asset.txt', zipFileContent]
		]);
		const form = new FormData();
		form.append('file', new Blob([zip]), 'import.zip');
		const response = await fetch(`${server.address}new?apiCall&id=${webstrateId}-zip`,
			{ method: 'POST', body: form });
		assert.equal(response.status, 200, 'Importing a valid ZIP file should succeed');

		const identifier = await identifierOf(server.address, `${webstrateId}-zip`, 'zip-asset.txt');
		assert.isTrue(fs.existsSync(path.join(configuredDir, identifier)),
			'Assets extracted from a ZIP import should be stored in the configured uploads directory');
	});

	it('should serve files inside ZIP assets from the configured uploads directory', async () => {
		// A ZIP uploaded as an asset is served through UPLOAD_DEST too (listing it with
		// ?dir, and serving files from within it), not just stored there.
		const webstrateId = 'test-' + util.randomString();
		await createWebstrate(server.address, webstrateId);

		const innerContent = 'inside a zip asset ' + util.randomString(10);
		await uploadAsset(server.address, webstrateId, 'nested.zip', await makeZip([
			['inner.txt', innerContent]
		]));

		const dirResponse = await fetch(`${server.address}${webstrateId}/nested.zip/?dir`);
		assert.equal(dirResponse.status, 200, 'Listing the ZIP asset should succeed');
		assert.include(await dirResponse.json(), 'inner.txt', 'The ZIP listing should contain the file');

		const innerResponse = await fetch(`${server.address}${webstrateId}/nested.zip/inner.txt`);
		assert.equal(innerResponse.status, 200, 'Serving a file from within the ZIP asset should succeed');
		assert.equal(await innerResponse.text(), innerContent, 'The file from within the ZIP should match');

		await fetch(`${server.address}${webstrateId}?delete`).catch(() => {});
	});

	it('should delete assets from the configured uploads directory with the webstrate', async () => {
		const identifier = await identifierOf(server.address, webstrateId, 'uploads-dir-served.txt');

		const response = await fetch(`${server.address}${webstrateId}?delete`);
		assert.equal(response.status, 200, 'Deleting the webstrate should succeed');

		assert.isFalse(fs.existsSync(path.join(configuredDir, identifier)),
			'Deleting the webstrate should delete its assets from the configured uploads directory');
	});

	it('WEBSTRATES_UPLOADS_DIR should override the config.json directory', async () => {
		// The env-var server runs with uploadsDir = configuredDir in its config file, but
		// WEBSTRATES_UPLOADS_DIR = envDir in its environment: uploads must land in envDir.
		const webstrateId = 'test-' + util.randomString();
		await createWebstrate(envServer.address, webstrateId);

		const content = 'env asset for the uploads-dir tests ' + util.randomString(10);
		await uploadAsset(envServer.address, webstrateId, 'uploads-dir-env.txt', content);
		const identifier = await identifierOf(envServer.address, webstrateId, 'uploads-dir-env.txt');

		assert.isTrue(fs.existsSync(path.join(envDir, identifier)),
			'The uploaded file should be stored in the WEBSTRATES_UPLOADS_DIR directory');
		assert.isFalse(fs.existsSync(path.join(configuredDir, identifier)),
			'The uploaded file should not be stored in the overridden config.json directory');

		// The file must also be served — the whole server (not just the upload path) has
		// to agree on where uploads live.
		const response = await fetch(`${envServer.address}${webstrateId}/uploads-dir-env.txt`);
		assert.equal(await response.text(), content,
			'The asset uploaded through the environment variable\'s directory should be served');

		await fetch(`${envServer.address}${webstrateId}?delete`).catch(() => {});
	});
});
