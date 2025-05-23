// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Attribute Manipulation', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		util.showLogs(pageA);

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	const tests = [
		{
			title: 'regular attribute',
			key: 'some-attr',
			value: util.randomString()
		},
		{
			title: 'attribute with periods',
			key: 'some.attr.with.periods',
			value: util.randomString()
		},
		{
			title: 'attribute with quotes in value',
			key: 'quotesInAttribute',
			value: util.randomString(3) + '"' + util.randomString(3)  + '\''
		},
		{
			title: 'attribute with ampersand in value',
			key: 'AMPERSAND_ATTRIBUTE',
			value: util.randomString(3) + '&' + util.randomString(4)
		},
	];

	tests.forEach(({ title, key, value }) => {
		it('should be possible to set ' + title, async () => {
			await pageA.evaluate((key, value) => document.body.setAttribute(key, value),
				key, value);

			const attributeGetsSetA = await util.waitForFunction(pageA, (key, value) =>
				document.body.getAttribute(key) === value,
			undefined, key, value);

			const attributeGetsSetB = await util.waitForFunction(pageB, (key, value) =>
				document.body.getAttribute(key) === value,
			undefined, key, value);

			assert.isTrue(attributeGetsSetA);
			assert.isTrue(attributeGetsSetB);
		});
	});

});