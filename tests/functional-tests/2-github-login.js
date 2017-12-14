const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('GitHub Login', function() {
	this.timeout(100000);

	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
	});

	after(async () => {
		await browser.close();
	});

	it('user object should be anonymous before logging in', async () => {
		await pageA.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle' });

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.propertyVal(userObject, 'userId',   'anonymous:');
		assert.propertyVal(userObject, 'username', 'anonymous');
		assert.propertyVal(userObject, 'provider', '');
		assert.property(userObject,    'permissions');
	});

	it('/auth/github redirects to github.com/login?...', async () => {
		await pageA.goto(config.server_address + 'auth/github', { waitUntil: 'networkidle' });
		const url = pageA.url();
		assert.match(url, /^https:\/\/github.com\/login?/);
	});

	it('should log in to GitHub', async () => {
		await util.logInToGithub(pageA);
		const url = await pageA.url();
		assert.notEqual(url, 'https://github.com/session', 'Login failed (invalid credentials?)');
	});

	it('should redirect to Webstrates frontpage', async () => {
		const url = await pageA.url();
		// config.server_address may start something like http://web:strate@..., but the page URL
		// won't include the login basic auth credentials, so we use util.cleanServerAddress, which
		// has those parts removed.
		assert.equal(url, util.cleanServerAddress + 'frontpage/');
	});

	let userObject;
	it('user object should exist', async () => {
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.exists(userObject);
	});

	it('user object should contain all required keys', async () => {
		assert.containsAllKeys(userObject, ['avatarUrl', 'cookies', 'displayName', 'permissions',
			'provider', 'userId', 'userUrl', 'username']);
	});

	it('user object should have correct userId, username and provider', async () => {
		assert.propertyVal(userObject, 'userId',   `${config.username}:github`);
		assert.propertyVal(userObject, 'username', config.username);
		assert.propertyVal(userObject, 'provider', 'github');
	});

	it('should also log in on other pages/tabs', async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address);

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.exists(userObject);
	});
});