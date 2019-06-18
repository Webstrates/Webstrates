// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Client Events', function() {
	this.timeout(10000);
	//this.retries(3);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	let firstClientId;
	it('client list should initially contain only the first client itself', async () => {
		// Wait for page to load.
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);

		firstClientId = await pageA.evaluate(() => window.webstrate.clientId);
		const clientList = await pageA.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId], clientList);
	});

	it('clientJoin event should get triggered when another client joins', async () => {
		pageA.evaluate(() => {
			window.webstrate.on('clientJoin', clientId => {
				window.__test_joiningClientId = clientId;
			});
		});

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		const clientJoined = await util.waitForFunction(pageA, () => window.__test_joiningClientId);
		assert.isTrue(clientJoined);
	});

	let secondClientId;
	it('joining clientId should match second client\'s clientId', async () => {
		const joiningClientId = await pageA.evaluate(() => window.__test_joiningClientId);

		// Wait for page to load.
		await util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded);

		secondClientId = await pageB.evaluate(() => window.webstrate.clientId);

		assert.equal(secondClientId, joiningClientId);
	});

	it('client list should contain both clients only after second client joins', async () => {
		const clientListA = await pageA.evaluate(() => window.webstrate.clients);
		const clientListB = await pageB.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId, secondClientId], clientListA);
		assert.deepEqual([firstClientId, secondClientId], clientListB);
	});

	it('clientPart event should get triggered when another client parts', async () => {
		await pageA.evaluate(() => {
			window.webstrate.on('clientPart', clientId => {
				window.__test_partingClientId = clientId;
			});
		});

		pageB.close();

		const clientParted = await util.waitForFunction(pageA, () => window.__test_partingClientId);
		assert.isTrue(clientParted);
	});

	it('parting clientId should match second client\'s clientId', async () => {
		const partingClientId = await pageA.evaluate(() => window.__test_partingClientId);
		assert.equal(secondClientId, partingClientId);
	});

	it('client list should contain only the first client\'s clientId once again', async () => {
		const clientList = await pageA.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId], clientList);
	});

});