// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';

const uploadAssetHelper = async (page, testAsset, searchable = false) => {
	const fileChooserPromise = page.waitForFileChooser();

	await page.evaluate((searchable) => {
		window.testAssetUploaded = false;
		window.webstrate.uploadAsset(() => {
			window.testAssetUploaded = true;
		}, { searchable });
	}, searchable);

	const fileChooser = await fileChooserPromise;
	await fileChooser.accept([testAsset]);

	await page.waitForFunction(() => window.testAssetUploaded === true, { timeout: 5000 });
};

const deleteAssetHelper = async (page, fileName) => {
	await page.evaluate(async (fileName) => {
		window.testAssetDeleted = false;
		window.webstrate.deleteAsset(fileName, () => {
			window.testAssetDeleted = true;
		});
	}, fileName);

	await page.waitForFunction(() => window.testAssetDeleted === true, { timeout: 5000 });
	await page.reload({ waitUntil: 'networkidle2' });
};

// window.webstrate.assets is an empty *object* until the server has sent the asset list over the
// websocket, so we wait for it to actually become an array. We can't wait for a non-empty list, as
// some of the webstrates we test are expected to have no assets at all.
const getAssets = async (page) => {
	assert.isTrue(await util.waitForFunction(page,
		() => window.webstrate && window.webstrate.loaded, 5),
	'Timed out waiting for the webstrate to load');

	assert.isTrue(await util.waitForFunction(page,
		() => Array.isArray(window.webstrate.assets), 5),
	'Timed out waiting for the asset list to arrive from the server');

	return await page.evaluate(() => window.webstrate.assets);
};

// The client's version lags behind the server's after an asset upload, because the version bump
// comes from a server-side no-op that only reaches us asynchronously. Before tagging we therefore
// ask the server what the version is and wait for the client to catch up, otherwise we might end
// up tagging a version older than the assets we just uploaded.
const getSyncedVersion = async (page) => {
	const serverVersion = await page.evaluate(async () =>
		(await (await fetch('?v')).json()).version);

	assert.isTrue(await util.waitForFunction(page,
		(v) => window.webstrate.version >= v, 5, serverVersion),
	`Timed out waiting for the client to reach version ${serverVersion}`);

	return serverVersion;
};

const bumpVersion = async (page) => {
	const versionBefore = await getSyncedVersion(page);

	await page.evaluate(() =>
		document.body.insertAdjacentHTML('beforeend', '<p>' + Math.random() + '</p>'));

	assert.isTrue(await util.waitForFunction(page,
		(v) => window.webstrate.version > v, 5, versionBefore),
	'Timed out waiting for the document version to be bumped');

	return await page.evaluate(() => window.webstrate.version);
};

const tagHelper = async (page, label, version) => {
	const error = await page.evaluate((label, version) => new Promise((resolve) => {
		window.webstrate.tag(label, version, (error) => resolve(error));
	}), label, version);
	assert.isNotOk(error, `Tagging version ${version} failed: ${error}`);

	assert.isTrue(await util.waitForFunction(page,
		(v, l) => window.webstrate.tags()[v] === l, 5, version, label),
	`Tag ${label} never showed up at version ${version}`);
};

const downloadArchive = async (page, downloadUrl) => {
	const base64 = await page.evaluate(async (downloadUrl) => {
		const response = await fetch(downloadUrl, { credentials: 'include' });
		if (!response.ok) throw new Error('Download failed with status ' + response.status);
		const bytes = new Uint8Array(await response.arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}, downloadUrl);

	return Buffer.from(base64, 'base64');
};

const listArchiveEntries = (buffer) => new Promise((resolve, reject) => {
	yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
		if (err) return reject(err);
		const entries = [];
		zipFile.on('entry', entry => { entries.push(entry.fileName); zipFile.readEntry(); });
		zipFile.on('end', () => resolve(entries));
		zipFile.on('error', reject);
		zipFile.readEntry();
	});
});

describe('Asset copying', function () {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	// A second source webstrate, used for the 'every asset has been deleted' edge case.
	const emptyWebstrateId = 'test-' + util.randomString();
	const emptyUrl = config.server_address + emptyWebstrateId;

	// Tag labels may not begin with a digit and may not contain periods.
	const tagName = 'x' + util.randomString();

	const deletedFileContent = 'Asset that gets deleted after the tag. ' + util.randomString(10);
	const keptFileContent = 'Asset that never gets deleted. ' + util.randomString(10);

	let browser, page;
	let testDir, deletedFile, keptFile;
	let tagVersion, deletedAtVersion, tagCopyUrl;

	// Every copy we create, so we can clean up after ourselves even if a test fails.
	const copyUrls = [];

	const assertIsCopyUrl = (candidate) => {
		const regex = '^' + util.escapeRegExp(config.server_address) + util.webstrateIdRegex + '/$';
		assert.match(candidate, new RegExp(regex), 'Copying should redirect to a new webstrate');
	};

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();

		testDir = path.join(process.cwd(), 'tests', 'test-assets-copy');
		if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

		deletedFile = path.join(testDir, 'copy-test.txt');
		fs.writeFileSync(deletedFile, deletedFileContent);

		keptFile = path.join(testDir, 'copy-keep.txt');
		fs.writeFileSync(keptFile, keptFileContent);

		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 5);
	});

	after(async () => {
		for (const copyUrl of copyUrls) {
			await page.goto(copyUrl + '?delete', { waitUntil: 'domcontentloaded' });
		}
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await page.goto(emptyUrl + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();

		[deletedFile, keptFile].forEach(file => {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		});
		if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
	});

	it('should be possible to tag a version and then delete an asset afterwards', async () => {
		await uploadAssetHelper(page, deletedFile);
		await uploadAssetHelper(page, keptFile);

		// Bump the version, so the tag doesn't sit on the same version as the uploads, then tag.
		await bumpVersion(page);
		tagVersion = await getSyncedVersion(page);
		await tagHelper(page, tagName, tagVersion);

		const assetsAtTag = await getAssets(page);
		assert.equal(assetsAtTag.length, 2, 'Both assets should exist at the tagged version');
		assetsAtTag.forEach(asset => {
			assert.isUndefined(asset.deletedAt, `${asset.fileName} should not be deleted at the tag`);
			// If an asset were newer than the tag it wouldn't be copied at all, and the tests below
			// would fail for the wrong reason.
			assert.isAtMost(asset.v, tagVersion, `${asset.fileName} was uploaded after the tag`);
		});

		// Make another change, so the deletion happens strictly after the tagged version.
		await bumpVersion(page);
		await deleteAssetHelper(page, 'copy-test.txt');

		const assetsNow = await getAssets(page);
		const deletedAsset = assetsNow.find(asset => asset.fileName === 'copy-test.txt');
		const keptAsset = assetsNow.find(asset => asset.fileName === 'copy-keep.txt');

		assert.isNumber(deletedAsset.deletedAt, 'copy-test.txt should be deleted now');
		assert.isUndefined(keptAsset.deletedAt, 'copy-keep.txt should not be deleted');

		deletedAtVersion = deletedAsset.deletedAt;
		// The whole point: the asset was alive at the tag and deleted only afterwards.
		assert.isAbove(deletedAtVersion, tagVersion,
			'The asset must be deleted after the tagged version for this test to make sense');
	});

	it('copying a tagged version should keep assets that were alive at that tag', async () => {
		await page.goto(`${url}/${tagName}/?copy`, { waitUntil: 'networkidle2' });

		tagCopyUrl = page.url();
		assertIsCopyUrl(tagCopyUrl);
		copyUrls.push(tagCopyUrl);

		const assets = await getAssets(page);
		assert.equal(await page.evaluate(() => window.webstrate.version), 1,
			'A fresh copy should start at version 1');

		const copiedAsset = assets.find(asset => asset.fileName === 'copy-test.txt');
		assert.isDefined(copiedAsset,
			'The asset was alive at the tagged version and should exist in the copy');
		assert.isUndefined(copiedAsset.deletedAt,
			'The copy must not inherit a deletion that happened after the tagged version');

		const keptAsset = assets.find(asset => asset.fileName === 'copy-keep.txt');
		assert.isDefined(keptAsset, 'The never-deleted asset should exist in the copy');
		assert.isUndefined(keptAsset.deletedAt, 'The never-deleted asset should not be deleted');
	});

	it('assets copied from a tag should stay servable as the copy is edited', async () => {
		await page.goto(tagCopyUrl, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 5);

		while (await page.evaluate(() => window.webstrate.version) <= deletedAtVersion) {
			await bumpVersion(page);
		}

		const response = await page.goto(tagCopyUrl + 'copy-test.txt', { waitUntil: 'networkidle2' });
		assert.equal(response.status(), 200, 'The copied asset should still be servable from the copy');
		assert.equal(await page.evaluate(() => document.body.textContent), deletedFileContent,
			'The content of the copied asset does not match the original');
	});

	it('copying at HEAD should not carry over deleted assets', async () => {
		await page.goto(url + '?copy', { waitUntil: 'networkidle2' });

		const headCopyUrl = page.url();
		assertIsCopyUrl(headCopyUrl);
		copyUrls.push(headCopyUrl);

		const assets = await getAssets(page);

		assert.isUndefined(assets.find(asset => asset.fileName === 'copy-test.txt'),
			'An asset deleted before the copied version should not exist in the copy at all');

		const keptAsset = assets.find(asset => asset.fileName === 'copy-keep.txt');
		assert.isDefined(keptAsset, 'Assets that were not deleted should still be copied');
		assert.isUndefined(keptAsset.deletedAt, 'The copied asset should not be deleted');

		const response = await page.goto(headCopyUrl + 'copy-test.txt',
			{ waitUntil: 'domcontentloaded' });
		assert.equal(response.status(), 404, 'The deleted asset should not be servable from the copy');
	});

	it('downloading a tagged version should archive the assets from that version', async () => {
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 5);

		const taggedEntries = await listArchiveEntries(
			await downloadArchive(page, `${url}/${tagName}?dl`));
		assert.include(taggedEntries, `${webstrateId}/copy-test.txt`,
			'The archive of a tagged version should contain the assets alive at that tag');
		assert.include(taggedEntries, `${webstrateId}/copy-keep.txt`,
			'The archive of a tagged version should contain the never-deleted asset');

		const headEntries = await listArchiveEntries(await downloadArchive(page, `${url}?dl`));
		assert.notInclude(headEntries, `${webstrateId}/copy-test.txt`,
			'The archive of the newest version should not contain deleted assets');
		assert.include(headEntries, `${webstrateId}/copy-keep.txt`,
			'The archive of the newest version should contain the never-deleted asset');
	});

	it('copying a webstrate whose only asset has been deleted should still work', async () => {
		await page.goto(emptyUrl, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 5);

		await uploadAssetHelper(page, deletedFile);
		await bumpVersion(page);
		await deleteAssetHelper(page, 'copy-test.txt');

		const response = await page.goto(emptyUrl + '?copy', { waitUntil: 'networkidle2' });
		assert.equal(response.status(), 200, 'Copying should not fail when all assets are deleted');

		assertIsCopyUrl(page.url());
		copyUrls.push(page.url());

		assert.isEmpty(await getAssets(page),
			'A copy of a webstrate with only deleted assets should have no assets');
	});
});
