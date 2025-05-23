// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Webstrate Object', function() {
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
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('webstrate object exists on window', async () => {
		const webstrateObjectExists = await util.waitForFunction(pageA, () => window.webstrate
			&& window.webstrate.loaded);
		assert.isTrue(webstrateObjectExists);
	});

	it('webstrate object exists on window with correct properties', async () => {
		const webstrate = await pageA.evaluate(() => window.webstrate);
		const webstrateId = await pageA.evaluate(() => window.webstrate.webstrateId);

		assert.equal(webstrate.webstrateId, webstrateId, 'webstrateId property matches actual ' +
			'webstrateId');
		assert.equal(webstrate.id, 'document', 'wid equals "document"');
		assert.isFalse(webstrate.isStatic, 'webstrate isn\'t static');
		// We could be more thorough in testing these properties, but it isn't entirely trivial as
		// we can't access the full webstrate object here. 'on', for instance, isn't actually a function
		// here, just an empty object.
		assert.containsAllKeys(webstrate, ['on', 'off', 'restore', 'user', 'tag', 'untag',
			'permissions']);
	});

	it('webstrate object exists on body with correct properties', async () => {
		const webstrate = await pageA.evaluate(() => document.body.webstrate);
		assert.containsAllKeys(webstrate, ['on', 'off']);
	});

	it('webstrate object exists on object created with document.createElement', async () => {
		const webstrate = await pageA.evaluate(() => document.createElement('div').webstrate);
		assert.containsAllKeys(webstrate, ['on', 'off']);
		// Elements should not have a wid attached until after they've been added to the DOM.
		assert.notProperty(webstrate, 'id');
	});

	it('webstrate object exists on object created with document.createElementNS', async () => {
		const webstrate = await pageA.evaluate(() =>
			document.createElementNS('http://www.w3.org/1999/xhtml', 'div').webstrate);
		assert.containsAllKeys(webstrate, ['on', 'off']);
		assert.notProperty(webstrate, 'id');
	});

	it('webstrate object exists on object created with document.cloneNode', async () => {
		const webstrate = await pageA.evaluate(() =>
			document.createElement('div').cloneNode(true).webstrate);
		assert.containsAllKeys(webstrate, ['on', 'off']);
		assert.notProperty(webstrate, 'id');
	});

	it('webstrate object on transient element does not contain id after insertion', async () => {
		await pageA.evaluate(() =>
			document.body.appendChild(document.createElement('transient')));

		const transientHasId = await util.waitForFunction(pageA, () =>
			document.body.querySelector('transient').webstrate.id,
		.1);

		assert.isFalse(transientHasId, 'webstrate.id does not exist on transient element');
	});

	it('webstrate objects on children of transient elements do not contain id after insertion',
		async () => {
			await pageA.evaluate(() =>
				document.body.querySelector('transient').appendChild(document.createElement('div')));

			const transientChildHasId = await util.waitForFunction(pageA, () =>
				document.body.querySelector('transient > div').webstrate.id,
			.1);

			assert.isFalse(transientChildHasId, 'webstrate.id does not exist on transient element child');
		});

	const randomElementId = util.randomString();
	it('webstrate object exists on other client after insertion with matching wid', async () => {
		await pageA.evaluate(randomElementId => {
			var div = document.createElement('div');
			div.setAttribute('id', randomElementId);
			document.body.appendChild(div);
		}, randomElementId);

		await util.waitForFunction(pageA, randomElementId =>
			document.getElementById(randomElementId),
		undefined, randomElementId);
		await util.waitForFunction(pageB, randomElementId =>
			document.getElementById(randomElementId),
		undefined, randomElementId);

		const webstrateA = await pageA.evaluate(randomElementId =>
			document.getElementById(randomElementId).webstrate, randomElementId);
		const webstrateB = await pageB.evaluate(randomElementId =>
			document.getElementById(randomElementId).webstrate, randomElementId);

		assert.equal(webstrateA.id, webstrateB.id, 'wid matches across browsers');
	});
});