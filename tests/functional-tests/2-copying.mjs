// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Copying', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);

		await page.evaluate((b) => document.body.innerText = b, randomBody);
		await util.sleep(.5);
	});

	after(async () => {
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	let redirectedUrl;
	const randomBody = util.randomString();
	it('?copy should redirect user to new random webstrateId matching ' + util.webstrateIdRegex, async () => {
		await page.goto(url + '?copy', { waitUntil: 'networkidle2' });

		redirectedUrl = page.url();
		const regex = '^' + util.escapeRegExp(config.server_address) + util.webstrateIdRegex + '/$';
		assert.match(redirectedUrl, new RegExp(regex));
	});
    
	it('body of new webstrate should match body of old webstrate', async () => {
		const bodyContainsString = await util.waitForFunction(page,
			(b) => document.body.innerText === b, 2, randomBody);

		await page.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
   
		assert.isTrue(bodyContainsString);     
	});

});