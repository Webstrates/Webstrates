const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Basic DOM Manipulation', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		//pageA.on('console', (...args) => console.log(...args));
		await pageA.goto(url, { waitUntil: 'networkidle' });

		pageB = await browser.newPage()
		//pageB.on('console', (...args) => console.log(...args));
		await pageB.goto(url, { waitUntil: 'networkidle' });
	});

	after(async () => {
		await browser.close();
	});

	it('body shouldn\'t initially contain "Hello, world!"', async () => {
		const innerHTML = await pageA.evaluate(() => {
			return document.body.innerHTML;
		});
		assert.notEqual(innerHTML, "Hello, world!");
	});

	it('body should eventually contain "Hello, world!"', async () => {
		// Wait for page to load.
		await util.waitForFunction(pageB,
			() => window.webstrate && window.webstrate.loaded);

		// Then set body to "Hello, world!".
		await pageB.evaluate(() => {
			document.body.innerHTML = "Hello, world!";
		});

		const bodyContainsHelloWorld = await util.waitForFunction(pageA,
			() => document.body.innerHTML === 'Hello, world!');
		assert.isTrue(bodyContainsHelloWorld);

		return true;
	});

});