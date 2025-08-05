// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('HTTP API', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async ()=>{
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageB = await browser.newPage();
	})

	after(async () => {
		await browser.close();
	});


	const webstrateIdRegex = (config.server && config.server.niceWebstrateIds)
		? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,3})'
		: '([A-z0-9-]{8,10})';

	it('/new redirects to random webstrateId matching ' + webstrateIdRegex, async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address + 'new', { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		const regex = '^' + util.escapeRegExp(config.server_address) + webstrateIdRegex + '/$';
		assert.match(redirectedUrl, new RegExp(regex));
	});

	it('root (/) redirects to /frontpage/', async () => {
		pageA = await browser.newPage();
		await pageA.goto(config.server_address, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageA.url();
		assert.equal(redirectedUrl, config.server_address + 'frontpage/');
	});

	it('/new?prototypeUrl=htmlfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.html";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl="+testURL, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds (default is requestAnimationFrame or 100ms)
		});
	});

	it('/new?prototypeUrl=zipfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.zip";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl=" + testURL, { waitUntil: 'domcontentloaded' });

		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds (default is requestAnimationFrame or 100ms)
		});

		let testAsset = await pageB.evaluate(() => {
			return webstrate.assets[0];
		});

		assert.include(testAsset, {
			fileName: 'test-asset.ico', fileSize: 15086, mimeType: 'image/vnd.microsoft.icon'
		})
	});

	it('ZIP files serve their content (base)', async () => {
		let assetURL = pageB.url()+"test.zip/test_json.json";
		console.log(assetURL);

		pageA = await browser.newPage();
		await pageA.goto(assetURL, { waitUntil: 'domcontentloaded' });
		const pageContent = await pageA.evaluate(() => {
			return document.body.innerText;
		});

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'success', true, 'Could not find the success property in test zip json');
	});

	it('ZIP files serve their content (subdir)', async () => {
		let assetURL = pageB.url() + "test.zip/directory/json_test2.json";

		pageA = await browser.newPage();
		await pageA.goto(assetURL, { waitUntil: 'domcontentloaded' });
		const pageContent = await pageA.evaluate(() => {
			return document.body.innerText;
		});

		// Cleanup
		const redirectedUrl = pageB.url();
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'subdirectory', true, 'Could not find the subdirectory property in test zip json in a subdir');
	});

});