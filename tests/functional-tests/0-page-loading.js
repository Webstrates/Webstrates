const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Page Loading', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB, pageC;

	after(async () => {
		await browser.close();
	});

	it('should connect to Webstrates server', async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();

		let gotoSuccess = true;
		try {
			await pageA.goto(url);
		} catch (e) {
			gotoSuccess = false;
		}
		assert.isTrue(gotoSuccess);
	});

	it('webstrate object becomes available', async () => {
		const webstrateObjectAvailable = await util.waitForFunction(pageA, () => {
			if (!window.webstrate) return false;

			webstrate.on('loaded', webstrateId => {
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

	it('/new redirects to random webstrateId matching /[A-z0-9-]{8,10}/', async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address + 'new', { waitUntil: 'networkidle' });

		const redirectedUrl = pageB.url();
		const regex = "^" + util.escapeRegExp(config.server_address) + "([A-z0-9-_]{8,10})\/$";
		assert.match(redirectedUrl, new RegExp(regex));
	});

	it('root (/) redirects to /frontpage/', async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address, { waitUntil: 'networkidle' });

		const redirectedUrl = pageB.url();
		assert.equal(redirectedUrl, config.server_address + 'frontpage/');
	});

});