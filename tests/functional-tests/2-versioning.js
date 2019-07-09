// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Versioning', function() {
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
	});

	after(async () => {
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('version should be 1 before we begin', async () => {
		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 1);
	});

	it('insertions should increase version', async () => {
		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', 'Hello, ');
			document.body.insertAdjacentHTML('beforeend', 'World!');
		});

		await util.sleep(.5);

		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', ' How are you?');
		});

		await util.sleep(.5);

		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 3);
	});

	it('should have one session tag to begin with', async () => {
		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.lengthOf(Object.values(tags), 1);
		assert.exists(tags[0]); // tags is an object, 0 is the key name.
	});

	// Tags can't begin with a number, so we prepend an x to ensure that it won't.
	const tagName = 'x' + util.randomString();
	it('should be possible to create tag', async () => {
		await page.evaluate((t) => window.webstrate.tag(t), tagName);

		await util.sleep(.5);

		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.lengthOf(Object.values(tags), 2);
		assert.equal(tags[3], tagName); // tags is an object, 3 is the key name.
	});

	it('should be possible to restore to previous version', async () => {
		await page.evaluate((t) => window.webstrate.restore(2));

		await util.sleep(1);

		const innerText = await page.evaluate(() => document.body.innerText);

		assert.equal(innerText, 'Hello, World!');
	});

	it('restoring should bump up version', async () => {
		const version = await page.evaluate(() => window.webstrate.version);

		// The empty document is version 1.
		// "Hello, World!" is version 2,
		// "Hello, World! How are you?" is version 3.
		// The noop op created by the restore is version 4.
		// Finally, the restored "Hello, World!" is version 5.
		assert.equal(version, 5);
	});

	it('should be possible to restore to previous tag', async () => {
		await page.evaluate((t) => window.webstrate.restore(t), tagName);

		await util.sleep(1);

		const innerText = await page.evaluate(() => document.body.innerText);

		assert.equal(innerText, 'Hello, World! How are you?');
	});

	it('restoring should bump up version again', async () => {
		const version = await page.evaluate(() => window.webstrate.version);

		// The noop op created by the restore is version 6.
		// The restored "Hello, World! How are you?" is version 7.
		assert.equal(version, 7);
	});
});