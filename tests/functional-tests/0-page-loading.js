// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Page Loading', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

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

	const webstrateIdRegex = (config.server && config.server.niceWebstrateIds)
		? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,2})'
		: '([A-z0-9-]{8,10})';

	it('/new redirects to random webstrateId matching ' + webstrateIdRegex, async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address + 'new', { waitUntil: 'networkidle2' });

		const redirectedUrl = pageB.url();
		const regex = '^' + util.escapeRegExp(config.server_address) + webstrateIdRegex + '/$';
		assert.match(redirectedUrl, new RegExp(regex));
	});

	it('root (/) redirects to /frontpage/', async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address, { waitUntil: 'networkidle2' });

		const redirectedUrl = pageB.url();
		assert.equal(redirectedUrl, config.server_address + 'frontpage/');
	});

});