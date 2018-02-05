const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Transient Tags', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await browser.close();
	});

	it('body should initially be empty', async () => {
		const bodyContents = await pageA.evaluate(() => {
			return document.body.innerHTML;
		});
		assert.equal(bodyContents, '');
	});

	it('can insert transient tag into body', async () => {
		await pageA.evaluate(() => {
			const t = document.createElement('transient');
			document.body.appendChild(t);
		});

		const containsTransientTag = await util.waitForFunction(pageA,
			() => document.body.innerHTML === '<transient></transient>');

		assert.isTrue(containsTransientTag);
	});

	it('transient tag should not be visible to other clients', async () => {
		const containsTransientTag = await util.waitForFunction(pageB,
			() => document.body.innerHTML === '<transient></transient>');

		assert.isFalse(containsTransientTag);
	});

	it('can insert div into transient tag', async () => {
		await pageA.evaluate(() => {
			const t = document.querySelector('transient');
			const d = document.createElement('div');
			t.appendChild(d);
		});

		const containsTransientTag = await util.waitForFunction(pageA,
			() => document.body.innerHTML === '<transient><div></div></transient>');

		assert.isTrue(containsTransientTag);
	});

	it('transient tag should still not be visible to other clients', async () => {
		const containsTransientTag = await util.waitForFunction(pageB,
			() => document.body.innerHTML === '<transient></transient>');

		assert.isFalse(containsTransientTag);
	});

});