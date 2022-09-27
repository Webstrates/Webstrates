// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

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
	});

	after(async () => {
		await Promise.all([
			pageA.goto(urlA + '?delete', { waitUntil: 'domcontentloaded' }),
			pageB.goto(urlB + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await browser.close();

		if (util.isLocalhost) {
			util.warn('Skipping dataSaved() tests as testing on local host doesn\'t provide sufficient' +
			' latency to get desired results.');
		}
	});

	it('DOM changes get saved when waiting for webstrate.dataSaved()', async function() {
		if (util.isLocalhost) {
			this.skip();
			return;
		}

		await pageA.evaluate(async () => {
			document.body.innerHTML = '';
			for (var i=0; i < 1000; i++) {
				document.body.innerHTML += 'X';
			}
			await window.webstrate.dataSaved();
			window.location.reload();
		});

		await pageA.waitForNavigation({ waitUntil: 'networkidle2' });

		const bodyLength = await pageA.evaluate(() => document.body.innerHTML.length);
		assert.equal(bodyLength, 1000);
	});

	// This is just a negative test and not actually desirable. However, it's good to have to verify
	// that `webstrate.dataSaved()` actually does make a difference.
	it('DOM changes don\'t get saved when not waiting for webstrate.dataSaved()', async function() {
		if (util.isLocalhost) {
			this.skip();
			return;
		}

		await pageB.evaluate(async () => {
			document.body.innerHTML = '';
			for (var i=0; i < 1000; i++) {
				document.body.innerHTML += 'X';
			}
			window.location.reload();
		});

		await pageB.waitForNavigation({ waitUntil: 'networkidle2' });

		const bodyLength = await pageB.evaluate(() => document.body.innerHTML.length);
		assert.isBelow(bodyLength, 1000);
	});

});