// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Page Loading', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	after(async () => {
		await browser.close();
	});

	it('should connect and create a webstrate using /'+webstrateId+" within 1 sec", async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		let gotoSuccess = true;
		try {
			await pageA.goto(url, { waitUntil: 'domcontentloaded' });
		} catch (err){
			gotoSuccess = false;
		}

		assert.isTrue(gotoSuccess);
	});	

	it('webstrate object becomes available', async () => {
		const webstrateObjectAvailable = await util.waitForFunction(pageA, () => {
			if (!window.webstrate) return false;

			window.webstrate.on('loaded', webstrateId => {
				window.__test_pageLoaded = true;
				window.__test_webstrateId = webstrateId;
			});
			return true;
		});
		assert.isTrue(webstrateObjectAvailable);
	});

	it('loaded event gets triggered', async () => {
		const pageLoadedVariableSet = await util.waitForFunction(pageA, () => window.__test_pageLoaded);
		assert.isTrue(pageLoadedVariableSet);
	});

	it('webstrateId from loaded event matches requested webstrateId', async () => {
		const loadedEventWebstrateId = await pageA.evaluate(() => window.__test_webstrateId);
		assert.equal(loadedEventWebstrateId, webstrateId);
	});

	it('webstrate.loaded gets set to true', async () => {
		const loadedIsTruthy = await util.waitForFunction(pageA, () => window.webstrate.loaded);
		assert.isTrue(loadedIsTruthy);
	});

	it('webstrate.webstrateId matches requested webstrateId', async () => {
		const webstrateObjectWebstrateId = await pageA.evaluate(() => window.webstrate.webstrateId);
		assert.equal(webstrateObjectWebstrateId, webstrateId);
	});

	it('the webstrate has an initial revision history of 1', async ()=>{
		// The document's creation commits asynchronously; the ?v snapshot page can be
		// served before that commit lands and show an earlier state. Poll until the
		// version settles, with the browser cache disabled so every poll refetches.
		let version = 0;
		for (let tries = 0; tries < 20 && version !== 1; tries++) {
			await pageA.setCacheEnabled(false);
			await pageA.goto(url + '?v', { waitUntil: 'domcontentloaded' });
			try {
				version = (await pageA.evaluate(() =>
					JSON.parse(document.querySelector('body').innerText))).version;
			} catch (err) {
				// An error body instead of the version snapshot — retry.
				version = 0;
			}
			if (version !== 1) await util.sleep(0.25);
		}

		assert.equal(version, 1, 'Version should be 1 after creation');
	});

	it('should be able to delete a webstrate', async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await pageA.goto(url + '?v', { waitUntil: 'domcontentloaded' });

		const innerText = await pageA.evaluate(() =>
			JSON.parse(document.querySelector('body').innerText));

		if (innerText.version !== 0) {
			util.warn('Unable to clean up after ourselves, left webstrate', webstrateId, 'on server');
		}

		assert.equal(innerText.version, 0, 'Version should be 0');
	});	
});