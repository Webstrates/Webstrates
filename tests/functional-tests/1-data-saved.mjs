// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('DOM Manipulation with dataSaved', function() {
	this.timeout(10000);

	const webstrateIdA = 'test-' + util.randomString();
	const webstrateIdB = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateIdA;
	const urlB = config.server_address + webstrateIdB;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		await pageA.goto(urlA, { waitUntil: 'networkidle2' });
		pageB = await browser.newPage();
		await pageB.goto(urlB, { waitUntil: 'networkidle2' });

		if (util.isLocalhost) {
			util.warn('dataSaved() testing on localhost uses emulated ' +
			'latency which may not be enough to catch all issues...');

            // --- Simulate Network Latency and Throttling ---
            const clientA = await pageA.createCDPSession();
            const clientB = await pageB.createCDPSession();
            await clientA.send('Network.enable');
            await clientB.send('Network.enable');
            const networkConditions = {
                offline: false,
                downloadThroughput: 500 * 1024 / 8, 
                uploadThroughput: 250 * 1024 / 8,
                latency: 200, 
            };
            await clientA.send('Network.emulateNetworkConditions', networkConditions);
            await clientB.send('Network.emulateNetworkConditions', networkConditions);

            util.warn(`Emulating network conditions for pageA and pageB:
                       Latency: ${networkConditions.latency}ms
                       Download: ${networkConditions.downloadThroughput * 8 / 1024} Kbps
                       Upload: ${networkConditions.uploadThroughput * 8 / 1024} Kbps`);

		}		
	});

	after(async () => {
		await Promise.all([
			pageA.goto(urlA + '?delete', { waitUntil: 'domcontentloaded' }),
			pageB.goto(urlB + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await browser.close();
	});

	it('DOM changes get saved when waiting for webstrate.dataSaved()', async function() {
		await pageA.evaluate(async () => {
			document.body.innerHTML = '';
			for (var i=0; i < 200; i++) {
				document.body.innerHTML += 'X';
			}
			await window.webstrate.dataSaved();
			window.location.reload();
		});

		await pageA.waitForNavigation({ waitUntil: 'networkidle2' });

		const bodyLength = await pageA.evaluate(() => document.body.innerHTML.length);
		assert.equal(bodyLength, 200);
	});

	// This is just a negative test and not actually desirable. However, it's good to have to verify
	// that `webstrate.dataSaved()` actually does make a difference.
	it('DOM changes don\'t get saved when not waiting for webstrate.dataSaved()', async function() {
		await pageB.evaluate(async () => {
			document.body.innerHTML = '';
			for (var i=0; i < 200; i++) {
				document.body.innerHTML += 'X';
			}
			window.location.reload();
		});

		await pageB.waitForNavigation({ waitUntil: 'networkidle2' });

		const bodyLength = await pageB.evaluate(() => document.body.innerHTML.length);
		assert.isBelow(bodyLength, 200);
	});

});