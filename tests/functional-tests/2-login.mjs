// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Authentication and Login', function() {
	this.timeout(100000);

	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
	});

	after(async () => {
		await browser.close();

		if (!util.credentialsProvided) {
			util.warn('Skipping most GitHub tests as no credentials were provided.');
		}
	});

	it('user object should be anonymous before logging in', async () => {
		await pageA.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle2' });

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.propertyVal(userObject, 'userId', 'anonymous:');
		assert.propertyVal(userObject, 'username', 'anonymous');
		assert.propertyVal(userObject, 'provider', '');
		assert.property(userObject, 'permissions');
	});

	let authTargetPrefix = {
		github: 'https://github.com/login?',
		au: 'https://login.projects.cavi.au.dk',
		test: config.server_address + 'auth/test'
	}
	it(`/auth/${config.authType} redirects to ${authTargetPrefix[config.authType]}...`, async function () {
		if (!util.credentialsProvided) return this.skip();

		await pageA.goto(config.server_address + 'auth/' + config.authType, { waitUntil: 'networkidle2' });
		const url = pageA.url();
		assert.isTrue(url.startsWith(authTargetPrefix[config.authType]), 'Was the auth correctly set up in config.json?');
	});

	it('should log in via auth', async function () {
		if (!util.credentialsProvided) return this.skip();

		const result = await util.logInToAuth(pageA);
		assert.isTrue(result, 'Login failed (invalid credentials?)');
	});

	it('should redirect to Webstrates frontpage', async function () {
		if (!util.credentialsProvided) {
			// We won't get redirected when we're not logging in, so we redirect manually to be in the
			// right state for the next tests.
			await pageA.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle2' });
			this.skip();
			return;
		}

		const url = await pageA.url();
		// config.server_address may start something like http://web:strate@..., but the page URL
		// won't include the login basic auth credentials, so we use util.cleanServerAddress, which
		// has those parts removed.
		assert.equal(url, util.cleanServerAddress + 'frontpage/');
	});

	let userObject;
	it('user object should exist', async function () {
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.exists(userObject);
	});

	it('user object should contain all required keys', async function () {
		if (!util.credentialsProvided) {
			assert.containsAllKeys(userObject, ['permissions', 'provider', 'userId', 'username']);
			return;
		}

		// avatarUrl is optional
		assert.containsAllKeys(userObject, ['cookies', 'displayName', 'permissions',
			'provider', 'userId', 'userUrl', 'username']);
	});

	it('user object should have correct userId, username and provider', async function () {
		if (!util.credentialsProvided) return this.skip();


		assert.equal(userObject.userId, userObject.username + ':' + config.authType);
		assert.isTrue(userObject.username != 'anonymous', 'User cannot be called anonymous');
		assert.propertyVal(userObject, 'provider', config.authType);
	});

	it('should also log in on other pages/tabs', async function () {
		if (!util.credentialsProvided) return this.skip();

		pageB = await browser.newPage();
		await pageB.goto(config.server_address);

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.exists(userObject);
		assert.notEqual(userObject.userId, 'anonymous:');
		assert.notEqual(userObject.username, 'anonymous');
		assert.equal(userObject.provider, config.authType);
	});

	it('after logout user should be redirected to the frontpage and be logged out', async function () {
		if (!util.credentialsProvided) return this.skip();

		await pageA.goto(config.server_address + 'auth/logout', { waitUntil: 'networkidle2' });

		const url = await pageA.url();
		assert.equal(url, util.cleanServerAddress + 'frontpage/');

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.propertyVal(userObject, 'userId', 'anonymous:');
		assert.propertyVal(userObject, 'username', 'anonymous');
		assert.propertyVal(userObject, 'provider', '');
		assert.property(userObject, 'permissions');
	});
});