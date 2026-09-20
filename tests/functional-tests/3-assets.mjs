// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert, expect } from 'chai';
import { MongoClient } from 'mongodb';
import config from '../config.js';
import util from '../util.js';

import fs from 'fs';
import path from 'path';
import { ZipArchive } from 'archiver';

const IMAGE_DATA = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFzGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNS41LjAiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iCiAgICB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIKICAgZXhpZjpDb2xvclNwYWNlPSIxIgogICBleGlmOlBpeGVsWERpbWVuc2lvbj0iMzIiCiAgIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSIzMiIKICAgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIKICAgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIgogICB0aWZmOkltYWdlTGVuZ3RoPSIzMiIKICAgdGlmZjpJbWFnZVdpZHRoPSIzMiIKICAgdGlmZjpSZXNvbHV0aW9uVW5pdD0iMiIKICAgdGlmZjpYUmVzb2x1dGlvbj0iNzIvMSIKICAgdGlmZjpZUmVzb2x1dGlvbj0iNzIvMSIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNS0w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`;

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

	// Poll on a fixed interval rather than the default (requestAnimationFrame), which never
	// fires in background tabs — i.e. whenever a page shares its browser with other pages.
	await page.waitForFunction(() => {
		return window.testAssetUploaded === true;
	}, { timeout: 5000, polling: 100 });
}

const deleteAssetHelper = async (page, fileName) => {
	await page.evaluate(async (fileName) => {
		window.testAssetDeleted = false;
		window.webstrate.deleteAsset(fileName, () => {
			window.testAssetDeleted = true;
		});
	}, fileName);

	await page.waitForFunction(() => {
		return window.testAssetDeleted === true;
	}, { timeout: 5000, polling: 100 });

	await page.reload({ waitUntil: 'networkidle2' });
}

describe('Assets', function () {
	this.timeout(10000);

	const webstrateIdA = 'test-' + util.randomString();
	const webstrateIdB = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateIdA;
	const urlB = config.server_address + webstrateIdB;

	const textFileContent = 'This is a test file for asset testing.' + util.randomString(10);

	let browserA, browserB, pageA, pageB;
	let testDir;
	let testTextFile, testCsvFile, testEmptyCsvFile, testImageFile, testZipFile, testNumericFile;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();
		pageA = await browserA.newPage();
		pageB = await browserB.newPage();
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });
		await pageB.goto(urlB + '/', { waitUntil: 'networkidle2' });

		// Create test folder and files
		testDir = path.join(process.cwd(), 'tests', 'test-assets');
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}

		// Create a simple text file
		testTextFile = path.join(testDir, 'test.txt');
		fs.writeFileSync(testTextFile, textFileContent);

		// Create a simple CSV file for searchable assets
		testCsvFile = path.join(testDir, 'test.csv');
		fs.writeFileSync(testCsvFile, 'name,age,city\nJohn,25,New York\nJane,30,Los Angeles\nBob,35,Chicago');

		// Create an empty CSV file (no rows at all)
		testEmptyCsvFile = path.join(testDir, 'empty.csv');
		fs.writeFileSync(testEmptyCsvFile, '');

		// Create an image file
		testImageFile = path.join(testDir, 'test.png');
		fs.writeFileSync(testImageFile, Buffer.from(IMAGE_DATA.split(',')[1], 'base64'));

		// Create a simple ZIP with the above files
		testZipFile = path.join(testDir, 'test.zip');
		await new Promise((resolve, reject) => {
			const output = fs.createWriteStream(testZipFile);
			const archive = new ZipArchive();

			output.on('close', () => {
				resolve();
			});
			archive.on('error', (err) => {
				reject(err);
			});

			// Add files to the archive
			archive.pipe(output);
			archive.file(testTextFile, { name: 'test.txt' });
			archive.file(testCsvFile, { name: 'test.csv' });
			archive.file(testImageFile, { name: 'test.png' });
			archive.finalize();
		});
		
		testNumericFile = path.join(testDir, '123456');
		fs.writeFileSync(testNumericFile, 'This is a test file with only numbers as the name.');
	});

	after(async () => {
		// Clean up test files
		[testTextFile, testCsvFile, testEmptyCsvFile, testImageFile, testZipFile, testNumericFile].forEach(file => {
			if (fs.existsSync(file)) {
				fs.unlinkSync(file);
			}
		});
		if (fs.existsSync(testDir)) {
			fs.rmdirSync(testDir);
		}

		await Promise.all([
			pageA.setCacheEnabled(false),
			pageB.setCacheEnabled(false)
		]);
		await pageA.goto(urlA + '/?delete', { waitUntil: 'domcontentloaded' });
		await pageB.goto(urlB + '/?delete', { waitUntil: 'domcontentloaded' });
		await Promise.all([
			browserA.close(),
			browserB.close()
		]);
	});

	it('Users should be able to upload assets using the API', async () => {
		await uploadAssetHelper(pageA, testTextFile);

		const assets = await pageA.evaluate(async () => {
			return await window.webstrate.assets;
		});

		assert.equal(assets.length, 1, 'No assets found after upload');
		assert.equal(assets[0].fileName, 'test.txt', 'Uploaded asset file name does not match');
		assert.equal(assets[0].mimeType, 'text/plain', 'Uploaded asset file type does not match');
		assert.hasAllKeys(assets[0], ['v', 'fileName', 'fileSize', 'mimeType', 'identifier', 'fileHash'], 'Uploaded asset does not have all expected properties');

		// Initial version is 1, after uploading an asset it should be 2
		const version = await pageA.evaluate(() => window.webstrate.version);
		assert.equal(version, 2);
	});
	
	it('Assets without an extension and only numbers as the name should not be uploadable', async () => {
		await uploadAssetHelper(pageA, testNumericFile);

		const assets = await pageA.evaluate(async () => {
			return await window.webstrate.assets;
		});

		assert.equal(assets.length, 1, 'Asset without an extension and only numbers as the name should not be uploadable');
	});

	it('Assets should be accessible from their URL', async () => {
		await pageA.goto(urlA + '/test.txt', { waitUntil: 'networkidle2' });

		const content = await pageA.evaluate(() => {
			return document.body.textContent;
		});
		assert.equal(content, textFileContent, 'Content of the asset does not match the expected content');
	});

	it('All assets should be listed in the API and HTTP API', async () => {
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });

		await uploadAssetHelper(pageA, testCsvFile, true);
		await uploadAssetHelper(pageA, testImageFile);
		await uploadAssetHelper(pageA, testZipFile);

		let assetsAPI = await pageA.evaluate(async () => {
			return await window.webstrate.assets;
		});
		assetsAPI = assetsAPI.sort((a, b) => a.v - b.v);

		await pageA.goto(urlA + '?assets', { waitUntil: 'networkidle2' });
		const content = await pageA.evaluate(() => {
			return document.body.textContent;
		});
		const assetsHTTPAPI = JSON.parse(content).sort((a, b) => a.v - b.v);

		assert.deepEqual(assetsAPI, assetsHTTPAPI, 'Assets from API and HTTP API do not match');
		assert.equal(assetsAPI.length, 4, 'The number of assets in the list does not match the number of uploaded assets');

		assert.isTrue(assetsAPI.some(asset => asset.fileName === 'test.txt'), 'List of assets does not include the text file');
		assert.isTrue(assetsAPI.some(asset => asset.fileName === 'test.csv'), 'List of assets does not include the CSV file');
		assert.isTrue(assetsAPI.some(asset => asset.fileName === 'test.png'), 'List of assets does not include the image file');
		assert.isTrue(assetsAPI.some(asset => asset.fileName === 'test.zip'), 'List of assets does not include the ZIP file');

		assert.isTrue(assetsAPI.some(asset => asset.fileName === 'test.csv' && asset.searchable === true), 'Searchable CSV file is not marked as searchable');
	});

	it('The same asset should have the same identifier across different webstrates', async () => {
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });

		await uploadAssetHelper(pageB, testTextFile);

		const textFileAssetA = await pageA.evaluate(() => {
			return window.webstrate.assets.find(asset => asset.fileName === 'test.txt');
		});
		const textFileAssetB = await pageB.evaluate(() => {
			return window.webstrate.assets.find(asset => asset.fileName === 'test.txt');
		});

		assert.equal(textFileAssetA.identifier, textFileAssetB.identifier, 'The identifiers of the same asset in different webstrates do not match');
	});

	it('Assets should be able to be deleted', async () => {
		await deleteAssetHelper(pageB, 'test.txt');

		const textFileAssetB = await pageB.evaluate(() => {
			return window.webstrate.assets.find(asset => asset.fileName === 'test.txt');
		});

		assert.isNumber(textFileAssetB.deletedAt, 'Asset was not deleted successfully');
	});

	it('Assets with the same identifier should still be accessible after deletion on another webstrate', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		const textFileAssetA = await pageA.evaluate(() => {
			return window.webstrate.assets.find(asset => asset.fileName === 'test.txt');
		});

		assert.isDefined(textFileAssetA, 'Asset should still be defined on webstrate A after deletion on webstrate B');
	});

	it('Files within ZIP archives should be listable using the HTTP API', async () => {
		await pageA.goto(urlA + '/test.zip/?dir', { waitUntil: 'networkidle2' });

		const content = await pageA.evaluate(() => {
			return document.body.textContent;
		});

		try {
			const assetsList = JSON.parse(content);
			assert.isArray(assetsList, 'Content of the ZIP archive should be a JSON array');
			assert.include(assetsList, 'test.txt', 'Content of the ZIP archive does not contain the expected file');
			assert.include(assetsList, 'test.csv', 'Content of the ZIP archive does not contain the expected file');
			assert.include(assetsList, 'test.png', 'Content of the ZIP archive does not contain the expected file');
		} catch (error) {
			assert.fail('Content of the ZIP archive is not a valid JSON array: ' + error.message);
		}
	});

	it('Files within ZIP archives should be directly accessible via their URL', async () => {
		await pageA.goto(urlA + '/test.zip/test.txt', { waitUntil: 'networkidle2' });

		const content = await pageA.evaluate(() => {
			return document.body.textContent;
		});
		assert.equal(content, textFileContent, 'Content of the file within ZIP archive does not match the expected content');
	});

	it('Searchable CSV assets should be searchable', async () => {
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });

		const { err, result, count } = await pageA.evaluate(async () => {
			return new Promise((resolve, reject) => {
				window.webstrate.searchAsset('test.csv', {
					query: { name: 'Bob' }
				}, (err, result, count) => {
					resolve({ err, result, count });
				});
			});
		});

		assert.isUndefined(err, 'Searching for a searchable asset should not throw an error');
		assert.isArray(result, 'Search result should be an array');
		assert.equal(result.length, 1, 'Search result should contain one asset');
		assert.equal(count, 1, 'Search count should be 1');
		assert.deepEqual(result[0], {
			name: 'Bob',
			age: 35,
			city: 'Chicago'
		}, 'Search result does not match expected data');
	});

	it('An empty searchable CSV should upload and be searchable with no results', async () => {
		await uploadAssetHelper(pageA, testEmptyCsvFile, true);

		const emptyCsvAsset = await pageA.evaluate(async () => {
			return (await window.webstrate.assets).find(asset => asset.fileName === 'empty.csv');
		});
		assert.isDefined(emptyCsvAsset, 'Empty CSV asset should be in the asset list');
		assert.isTrue(emptyCsvAsset.searchable, 'Empty CSV asset should be searchable');

		const { err, result, count } = await pageA.evaluate(async () => {
			return new Promise((resolve, reject) => {
				window.webstrate.searchAsset('empty.csv', {
					query: {}
				}, (err, result, count) => {
					resolve({ err, result, count });
				});
			});
		});

		assert.isUndefined(err, 'Searching an empty searchable CSV should not throw an error');
		assert.deepEqual(result, [], 'Search result should be empty');
		assert.equal(count, 0, 'Search count should be 0');
	});

	it('Deleted searchable CSV assets should not be searchable', async () => {
		await deleteAssetHelper(pageA, 'test.csv');

		const { err, result, count } = await pageA.evaluate(async () => {
			return new Promise((resolve, reject) => {
				window.webstrate.searchAsset('test.csv', {
					query: { name: 'Bob' }
				}, (err, result, count) => {
					resolve({ err, result, count });
				});
			});
		});

		assert.isDefined(err, 'Searching for a deleted asset should throw an error');
		assert.equal(err, 'Asset not found', 'Error message does not match expected error for deleted asset');
		assert.isArray(result, 'Search result should be an array');
		assert.equal(result.length, 0, 'Search result should be empty for deleted asset');
		assert.equal(count, 0, 'Search count should be 0 for deleted asset');
	});

	it('Restoring an older version should restore assets to that version', async () => {
		await deleteAssetHelper(pageA, 'test.txt');

		const assetsBeforeRestore = await pageA.evaluate(() => window.webstrate.assets);

		// The image and ZIP files should still be there, the CSV and text files should be deleted
		assert.equal(assetsBeforeRestore.find(a => a.fileName === 'test.png').deletedAt, undefined, 'Image asset should not be deleted before restore');
		assert.equal(assetsBeforeRestore.find(a => a.fileName === 'test.zip').deletedAt, undefined, 'ZIP asset should not be deleted before restore');
		assert.isNumber(assetsBeforeRestore.find(a => a.fileName === 'test.csv').deletedAt, 'CSV asset should be deleted before restore');
		assert.isNumber(assetsBeforeRestore.find(a => a.fileName === 'test.txt').deletedAt, 'Text asset should be deleted before restore');

		// Restore to version 2 where only the text file was there
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(urlA + '?restore=2', { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 2);

		const versionAfterRestore = await pageA.evaluate(() => window.webstrate.version);
		const assetsAfterRestore = await pageA.evaluate(() => window.webstrate.assets);

		// The image and ZIP files should be deleted at the current version, the CSV file should still be deleted, the text file was restored
		assert.equal(assetsAfterRestore.find(a => a.fileName === 'test.png').deletedAt, versionAfterRestore, 'Image asset should be deleted after restore at current version');
		assert.equal(assetsAfterRestore.find(a => a.fileName === 'test.zip').deletedAt, versionAfterRestore, 'ZIP asset should be deleted after restore at current version');
		assert.equal(assetsAfterRestore.find(a => a.fileName === 'test.csv').deletedAt, assetsBeforeRestore.find(a => a.fileName === 'test.csv').deletedAt, 'CSV asset deletedAt should be unchanged after restore');
		assert.equal(assetsAfterRestore.find(a => a.fileName === 'test.txt' && a.v === versionAfterRestore).deletedAt, undefined, 'Text asset should not be deleted after restore');
		assert.equal(assetsAfterRestore.find(a => a.fileName === 'test.txt' && a.v === versionAfterRestore).restoredFrom, 2, 'Text asset should have a restoredFrom property pointing to version 2');
	});

	it('Deleting an asset should require write permissions', async function() {
		if (config.authType !== 'test') return this.skip();
		this.timeout(20000);

		// Log in so we can grant ourselves write access, while restricting anonymous users to
		// read-only access.
		await util.logInToTest(pageA);
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 3);
		const userObject = await pageA.evaluate(() => window.webstrate.user);

		await pageA.evaluate((user) => {
			document.documentElement.setAttribute('data-auth', JSON.stringify([
				{ username: user.username, provider: user.provider, permissions: 'rw' },
				{ username: 'anonymous', provider: '', permissions: 'r' }
			]));
		}, userObject);

		// pageB connects anonymously and only gets read permissions.
		await pageB.goto(urlA + '/', { waitUntil: 'networkidle2' });
		const gotReadOnlyPermissions = await util.waitForFunction(pageB,
			() => window.webstrate && window.webstrate.user.permissions === 'r', 5);
		assert.isTrue(gotReadOnlyPermissions, 'Anonymous client should only have read permissions');

		// A read-only client should not be able to delete assets, and the asset list should be
		// left unchanged.
		const fetchAssets = () => pageB.evaluate(async (assetsUrl) => {
			const response = await fetch(assetsUrl);
			return await response.json();
		}, urlA + '?assets');
		const assetsBefore = await fetchAssets();

		const deleteError = await pageB.evaluate(() => new Promise((resolve) =>
			window.webstrate.deleteAsset('test.txt', resolve)));
		assert.isDefined(deleteError, 'Read-only client should not be able to delete an asset');

		const assetsAfter = await fetchAssets();
		assert.deepEqual(assetsAfter, assetsBefore,
			'Read-only client should not be able to modify the asset list');

		// A client with write permissions can still delete the asset.
		const writeDeleteError = await pageA.evaluate(() => new Promise((resolve) =>
			window.webstrate.deleteAsset('test.txt', resolve)));
		assert.isUndefined(writeDeleteError,
			'Client with write permissions should be able to delete an asset');
	});
});

describe('Searchable asset cleanup', function () {
	this.timeout(30000);

	// Searchable rows are a cache of the file they were parsed from, keyed on the file's
	// identifier: files are deduplicated by content across webstrates, so every webstrate
	// referencing the same content shares the same rows. The cache is built lazily on the first
	// search, and it lives exactly as long as the file — until no webstrate references it
	// anymore. The CSV contents are unique per run, so caches left behind by an interrupted run
	// can never share identifiers with this run's uploads.
	const csvAContent = 'name,city\nAda,Aarhus\nBob,Boston\nrun,' + util.randomString(10) + '\n';
	const csvCContent = 'name,city\nDana,Drammen\nErik,Esbjerg\nrun,' + util.randomString(10) + '\n';

	const webstrateIdA = 'test-' + util.randomString();
	const webstrateIdB = 'test-' + util.randomString();
	const webstrateIdC = 'test-' + util.randomString();
	const webstrateIdD = 'test-' + util.randomString();
	const webstrateIdE = 'test-' + util.randomString();
	const webstrateIdF = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateIdA;
	const urlB = config.server_address + webstrateIdB;
	const urlC = config.server_address + webstrateIdC;
	const urlD = config.server_address + webstrateIdD;
	const urlE = config.server_address + webstrateIdE;
	const urlF = config.server_address + webstrateIdF;

	let browser, pageA, pageB, pageC, pageD;
	let mongo, dbAssetsCsv, dbAssetSearchCache;
	let testDir, csvFileA, csvFileC;
	let identifierA, identifierC;

	const uploadsPath = (identifier) => path.join(process.cwd(), 'uploads', identifier);

	// The number of cached search rows of an asset, by the identifier of its file on disk.
	const cacheRowCount = async (identifier) =>
		await dbAssetsCsv.countDocuments({ _fileName: identifier });

	// The identifier (the name of the file on disk) of a webstrate's asset.
	const identifierOf = async (url, fileName) => {
		const asset = (await (await fetch(url + '?assets')).json())
			.find(asset => asset.fileName === fileName);
		assert.isDefined(asset, `The webstrate at ${url} should have an asset ${fileName}`);
		return asset.identifier;
	};

	// The response is only sent once the webstrate's assets have been deleted.
	const deleteWebstrate = async (url) => {
		const response = await fetch(url + '?delete');
		assert(response.ok, `Deleting the webstrate at ${url} failed (${response.status})`);
	};

	const searchAsset = (page, fileName, name) => page.evaluate((fileName, name) => {
		return new Promise((resolve) => {
			window.webstrate.searchAsset(fileName, { query: { name } }, (err, result) => {
				resolve({ err, result });
			});
		});
	}, fileName, name);

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageB = await browser.newPage();
		pageC = await browser.newPage();
		pageD = await browser.newPage();
		await pageA.goto(urlA + '/', { waitUntil: 'networkidle2' });
		await pageB.goto(urlB + '/', { waitUntil: 'networkidle2' });
		await pageC.goto(urlC + '/', { waitUntil: 'networkidle2' });

		testDir = path.join(process.cwd(), 'tests', 'test-assets');
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}
		csvFileA = path.join(testDir, 'cleanup-a.csv');
		fs.writeFileSync(csvFileA, csvAContent);
		csvFileC = path.join(testDir, 'cleanup-c.csv');
		fs.writeFileSync(csvFileC, csvCContent);

		mongo = new MongoClient(config.server.db);
		await mongo.connect();
		dbAssetsCsv = mongo.db().collection('assetsCsv');
		dbAssetSearchCache = mongo.db().collection('assetSearchCache');
	});

	after(async () => {
		// The tests delete their webstrates as they go; delete any left behind by a failure so
		// no uploaded files outlive the run.
		await Promise.all([urlA, urlB, urlC, urlD, urlE, urlF].map(url =>
			fetch(url + '?delete').catch(() => {})));
		await browser.close();
		await mongo.close();

		[csvFileA, csvFileC].forEach(file => {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		});
		if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
	});

	it('uploading the same searchable asset twice should share the file and the cache',
		async () => {
			await uploadAssetHelper(pageA, csvFileA, true);
			await uploadAssetHelper(pageB, csvFileA, true);

			identifierA = await identifierOf(urlA, 'cleanup-a.csv');
			assert.equal(await identifierOf(urlB, 'cleanup-a.csv'), identifierA,
				'Uploading the same file to two webstrates should deduplicate to the same file');
			assert.isTrue(fs.existsSync(uploadsPath(identifierA)),
				'The shared file should exist on disk');

			// The cache is built lazily: uploading a searchable asset indexes nothing.
			assert.equal(await cacheRowCount(identifierA), 0,
				'Uploading a searchable asset should not build its search cache');

			// Searching from both webstrates at once builds the shared cache exactly once.
			const [searchA, searchB] = await Promise.all([
				searchAsset(pageA, 'cleanup-a.csv', 'Ada'),
				searchAsset(pageB, 'cleanup-a.csv', 'Bob')
			]);
			assert.isUndefined(searchA.err, 'The first webstrate\'s asset should be searchable');
			assert.isUndefined(searchB.err, 'The second webstrate\'s asset should be searchable');
			assert.deepEqual(searchA.result, [{ name: 'Ada', city: 'Aarhus' }],
				'The first webstrate should find its rows');
			assert.deepEqual(searchB.result, [{ name: 'Bob', city: 'Boston' }],
				'The second webstrate should find its rows');
			assert.equal(await cacheRowCount(identifierA), 3,
				'Both webstrates should share a single cache, not one each');
		});

	it('deleting one of the webstrates should keep the shared cache and file', async () => {
		await deleteWebstrate(urlB);

		assert.equal(await cacheRowCount(identifierA), 3,
			'The cache is still used by the surviving webstrate and should be kept');
		assert.isTrue(fs.existsSync(uploadsPath(identifierA)),
			'The file is still in use by the surviving webstrate and should not be deleted');

		const { err, result } = await searchAsset(pageA, 'cleanup-a.csv', 'Ada');
		assert.isUndefined(err, 'The surviving webstrate\'s asset should still be searchable');
		assert.deepEqual(result, [{ name: 'Ada', city: 'Aarhus' }],
			'The surviving webstrate should still find its rows');
	});

	it('deleting the last webstrate using an asset should delete its cache and file', async () => {
		await deleteWebstrate(urlA);

		assert.equal(await cacheRowCount(identifierA), 0,
			'No cached rows of the asset should remain');
		assert.isFalse(fs.existsSync(uploadsPath(identifierA)),
			'The file should be deleted once no webstrate uses it anymore');
	});

	it('a copied webstrate should search the original webstrate\'s cache', async () => {
		await uploadAssetHelper(pageC, csvFileC, true);

		identifierC = await identifierOf(urlC, 'cleanup-c.csv');
		assert.equal(await cacheRowCount(identifierC), 0,
			'The original webstrate\'s cache should only be built once it is searched');

		await pageD.goto(urlC + '?copy=' + webstrateIdD, { waitUntil: 'networkidle2' });
		assert.equal(await identifierOf(urlD, 'cleanup-c.csv'), identifierC,
			'The copy should reuse the original\'s file rather than duplicating it');

		const { err, result } = await searchAsset(pageD, 'cleanup-c.csv', 'Dana');
		assert.isUndefined(err, 'The copy should be able to search the original\'s cache');
		assert.deepEqual(result, [{ name: 'Dana', city: 'Drammen' }],
			'The copy should find the shared rows');
		assert.equal(await cacheRowCount(identifierC), 3,
			'The copy should use the original\'s cache rather than building its own');
	});

	it('a shared cache should survive deleting the original webstrate but not the copy',
		async () => {
			await deleteWebstrate(urlC);

			assert.equal(await cacheRowCount(identifierC), 3,
				'The cache still used by the copy should survive the deletion of the original');
			const search = await searchAsset(pageD, 'cleanup-c.csv', 'Dana');
			assert.isUndefined(search.err, 'The copy should still find the shared rows');
			assert.deepEqual(search.result, [{ name: 'Dana', city: 'Drammen' }],
				'The copy\'s search results should be unchanged');

			await deleteWebstrate(urlD);
			assert.equal(await cacheRowCount(identifierC), 0,
				'Deleting the last webstrate that uses the cache should delete it');
			assert.isFalse(fs.existsSync(uploadsPath(identifierC)),
				'The file should be deleted once no webstrate uses it anymore');
		});

	it('an asset deleted in a revision keeps its cache until the webstrate is deleted',
		async () => {
			const pageE = await browser.newPage();
			await pageE.goto(urlE + '/', { waitUntil: 'networkidle2' });

			// Upload the searchable asset (a fresh webstrate makes the upload version 2) and
			// build its cache by searching it once.
			await uploadAssetHelper(pageE, csvFileA, true);
			const identifierE = await identifierOf(urlE, 'cleanup-a.csv');
			const firstSearch = await searchAsset(pageE, 'cleanup-a.csv', 'Ada');
			assert.isUndefined(firstSearch.err, 'The uploaded asset should be searchable');
			assert.equal(await cacheRowCount(identifierE), 3, 'The search should build the cache');

			// Bump the version and wait for it to land, so the deletion below is marked at a
			// version strictly after the upload's — the asset is alive at version 2, deleted at 3.
			await pageE.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p></p>'));
			const serverVersion = await pageE.evaluate(
				async () => (await (await fetch('?v')).json()).version);
			assert.isTrue(await util.waitForFunction(pageE, (v) => window.webstrate.version >= v, 5,
				serverVersion), 'Timed out waiting for the version bump');

			// Deleting an asset in a revision only marks it deleted: the webstrate can still be
			// reverted to a version where the asset is alive, so its cache and file must survive.
			await deleteAssetHelper(pageE, 'cleanup-a.csv');
			assert.equal(await cacheRowCount(identifierE), 3,
				'Deleting an asset in a revision must not delete its cache');
			assert.isTrue(fs.existsSync(uploadsPath(identifierE)),
				'Deleting an asset in a revision must not delete its file');

			// Reverting the webstrate to the version where the asset was alive brings it back —
			// searchable, too, since its cache is keyed on the file rather than on the asset
			// record that the restore replaced.
			await pageE.setCacheEnabled(false);
			await pageE.goto(urlE + '?restore=2', { waitUntil: 'networkidle2' });
			assert.isTrue(await util.waitForFunction(pageE, () =>
				Array.isArray(window.webstrate.assets) &&
				window.webstrate.assets.some(asset => asset.fileName === 'cleanup-a.csv' &&
					!asset.deletedAt), 5), 'Timed out waiting for the restored asset to arrive');

			const restoredAsset = await pageE.evaluate(() => window.webstrate.assets
				.find(asset => asset.fileName === 'cleanup-a.csv' && !asset.deletedAt));
			assert.equal(restoredAsset.restoredFrom, 2, 'The asset should be restored from version 2');
			const restoredSearch = await searchAsset(pageE, 'cleanup-a.csv', 'Ada');
			assert.isUndefined(restoredSearch.err, 'The restored asset should still be searchable');
			assert.deepEqual(restoredSearch.result, [{ name: 'Ada', city: 'Aarhus' }],
				'The restored asset should find its rows');

			// Only deleting the webstrate itself — from where the asset can no longer be
			// restored — actually removes the cache and the file.
			await deleteWebstrate(urlE);
			assert.equal(await cacheRowCount(identifierE), 0,
				'The cache should only be deleted once the webstrate itself is deleted');
			assert.isFalse(fs.existsSync(uploadsPath(identifierE)),
				'The file should only be deleted once the webstrate itself is deleted');

			await pageE.close();
		});

	it('a cleared or half-built cache is rebuilt from the file on the next search', async () => {
		const pageF = await browser.newPage();
		await pageF.goto(urlF + '/', { waitUntil: 'networkidle2' });

		await uploadAssetHelper(pageF, csvFileA, true);
		const identifierF = await identifierOf(urlF, 'cleanup-a.csv');
		const firstSearch = await searchAsset(pageF, 'cleanup-a.csv', 'Ada');
		assert.isUndefined(firstSearch.err, 'The uploaded asset should be searchable');
		assert.equal(await cacheRowCount(identifierF), 3, 'The search should build the cache');

		// Clearing the cache (to reclaim space) drops the rows and the manifest alike; the next
		// search simply rebuilds them from the file.
		await dbAssetsCsv.deleteMany({ _fileName: identifierF });
		await dbAssetSearchCache.deleteOne({ _id: identifierF });
		const rebuiltSearch = await searchAsset(pageF, 'cleanup-a.csv', 'Bob');
		assert.isUndefined(rebuiltSearch.err, 'A cleared cache should be rebuilt on the next search');
		assert.deepEqual(rebuiltSearch.result, [{ name: 'Bob', city: 'Boston' }],
			'The rebuilt cache should find its rows');
		assert.equal(await cacheRowCount(identifierF), 3,
			'The rebuilt cache should hold exactly one copy of the rows');

		// A build abandoned half-way through (a crashed process) leaves rows behind but no
		// manifest; rebuilding on top of them must not duplicate anything.
		await dbAssetSearchCache.deleteOne({ _id: identifierF });
		const redoneSearch = await searchAsset(pageF, 'cleanup-a.csv', 'Ada');
		assert.isUndefined(redoneSearch.err, 'A half-built cache should be completed, not failed');
		assert.equal(await cacheRowCount(identifierF), 3,
			'Rebuilding on top of a half-built cache must not duplicate its rows');

		await pageF.close();
	});
});

// Creates a ZIP archive in memory from a list of [name, data] entries. Entries
// are deflated, so redundant data (e.g. a buffer of zeros) compresses extremely
// well — which is exactly what a zip bomb is.
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

// Uploads a ZIP file to /new, creating (or trying to create) webstrateId.
const importZip = (zip, webstrateId) => {
	const form = new FormData();
	form.append('file', new Blob([zip]), 'import.zip');
	return fetch(`${config.server_address}new?apiCall&id=${webstrateId}`, { method: 'POST', body: form });
};

describe('ZIP import', function () {
	this.timeout(30000);

	const createdWebstrateIds = [];

	after(async () => {
		// Delete webstrates created by the tests below.
		await Promise.all(createdWebstrateIds.map(webstrateId =>
			fetch(`${config.server_address}${webstrateId}?delete`)));
	});

	it('A webstrate should be creatable from a ZIP file', async () => {
		const webstrateId = 'test-' + util.randomString();
		const zip = await makeZip([
			['index.html', '<html><body>zip import test</body></html>'],
			['test.txt', 'This is a test file inside a zip.']
		]);

		const response = await importZip(zip, webstrateId);
		assert.equal(response.status, 200, 'Importing a valid ZIP file should succeed');
		createdWebstrateIds.push(webstrateId);

		const docResponse = await fetch(`${config.server_address}${webstrateId}/?json`);
		assert.equal(docResponse.status, 200, 'The imported webstrate should exist');
		assert.include(JSON.stringify(await docResponse.json()), 'zip import test',
			'The imported webstrate should contain the index.html document');
	});

	it('ZIP files expanding beyond the uncompressed size limit should be rejected (zip bombs)', async () => {
		const webstrateId = 'test-' + util.randomString();
		// 300 MB of zeros deflates to ~1.3 MB — a ~230:1 zip bomb in a small archive.
		const zip = await makeZip([
			['bomb.bin', Buffer.alloc(300 * 1024 * 1024)],
			['index.html', '<html><body>zip bomb test</body></html>']
		]);

		const response = await importZip(zip, webstrateId);
		assert.equal(response.status, 409, 'Importing a zip bomb should be rejected');
		assert.include((await response.json()).error, 'uncompressed size',
			'The rejection should explain the uncompressed size limit');

		const docResponse = await fetch(`${config.server_address}${webstrateId}/?json`);
		assert.equal(docResponse.status, 404, 'No webstrate should be created from a zip bomb');
	});

	it('ZIP files containing too many entries should be rejected', async () => {
		const webstrateId = 'test-' + util.randomString();
		// The entry limit is 1000 (maxZipEntries); 1001 files is one too many.
		const files = Array.from({ length: 1001 }, (_, i) => [`file${i}.txt`, 'x']);
		const zip = await makeZip(files.concat([
			['index.html', '<html><body>entry count test</body></html>']
		]));

		const response = await importZip(zip, webstrateId);
		assert.equal(response.status, 409, 'Importing an archive with too many entries should be rejected');
		assert.include((await response.json()).error, 'too many entries',
			'The rejection should explain the entry limit');

		const docResponse = await fetch(`${config.server_address}${webstrateId}/?json`);
		assert.equal(docResponse.status, 404, 'No webstrate should be created from an archive with too many entries');
	});
});