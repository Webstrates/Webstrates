import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Copying', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });

		// The webstrate can still be mid-creation when
		// networkidle2 resolves; only a loaded page turns the body edit below into an
		// op at all.
		assert.isTrue(await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 20));

		await page.evaluate((b) => document.body.innerText = b, randomBody);
		// The copy below must find the body server-side, so wait for its commit
		// rather than sleeping.
		await page.evaluate(() => window.webstrate.dataSaved());
	});

	after(async () => {
		await page.setCacheEnabled(false);
		await util.deleteWebstrate(page, url);
		await browser.close();
	});

	let redirectedUrl;
	const randomBody = util.randomString();
	it('?copy should redirect user to new random webstrateId matching ' + util.webstrateIdRegex,
		async () => {
			await page.goto(url + '?copy', { waitUntil: 'networkidle2' });

			// networkidle2 can resolve while the ?copy redirect is still in flight on a busy
			// machine — poll until the URL has actually landed on the new webstrate.
			const regex = '^' + util.escapeRegExp(config.server_address) + util.webstrateIdRegex + '/$';
			await util.waitFor(() => new RegExp(regex).test(page.url()), 15);
			redirectedUrl = page.url();
			assert.match(redirectedUrl, new RegExp(regex));
		});
    
	it('body of new webstrate should match body of old webstrate', async () => {
		// The copy's body syncs through the server - wait for it 
		const bodyContainsString = await util.waitForFunction(page,
			(b) => document.body.innerText === b, 20, randomBody);

		await util.deleteWebstrate(page, redirectedUrl);
   
		assert.isTrue(bodyContainsString);     
	});

});