// Access tokens (P-203): token generation and user-scoped ?tokens listing.
//
// Access tokens grant the permissions of the user who generated them —
// including admin — so a token listing must never disclose another user's
// token. serveTokenList enforces this: users with admin permissions on the
// webstrate may list all of its tokens; everyone else (logged in or
// anonymous) only gets the tokens they created themselves, i.e. tokens with
// a matching username and provider.
//
// The two "only own tokens" tests fail on unfixed code, where ?tokens
// returns every token of the webstrate to any user with read permissions.

// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */

import fs from 'fs';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Access tokens', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	// Three identities with separate cookie jars: the document admin, a
	// read-only user, and an anonymous client (separate browser contexts).
	let browser, pageAdmin, pageReader, pageAnon;
	let adminToken, readerToken;

	// Puppeteer's bundled Chrome is unavailable in some container
	// environments. Point CHROME_PATH at a system Chromium to use it instead
	// (launched with --no-sandbox, required when running as root).
	const launchBrowser = () => {
		const chromePath = process.env.CHROME_PATH;
		const options = chromePath && fs.existsSync(chromePath)
			? {
				executablePath: chromePath,
				args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
			}
			: {};
		return puppeteer.launch(options);
	};

	// Generate an access token (POST with a `token` field of seconds,
	// default 300) as the user the page is logged in as.
	const generateToken = (page) => page.evaluate(async (docUrl) => {
		const response = await fetch(docUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'token=600'
		});
		return await response.json();
	}, url);

	// Fetch the access token listing (`?tokens`) as the user the page is
	// logged in as.
	const listTokens = (page) => page.evaluate(async (tokensUrl) => {
		const response = await fetch(tokensUrl);
		return await response.json();
	}, url + '?tokens');

	before(async () => {
		if (config.authType !== 'test') {
			util.warn('Skipping access token tests: they need multiple users and thus the "test" ' +
				'auth provider.');
			return;
		}

		browser = await launchBrowser();

		pageAdmin = await browser.newPage();
		const readerContext = await browser.createBrowserContext();
		pageReader = await readerContext.newPage();
		const anonContext = await browser.createBrowserContext();
		pageAnon = await anonContext.newPage();

		await util.logInToTest(pageAdmin, 'tokensadmin');
		await util.logInToTest(pageReader, 'tokensreader');
	});

	after(async () => {
		if (browser) {
			// Clean up after ourselves (requires write permissions, i.e. the admin).
			const response = await pageAdmin.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
			if (!response || response.status() !== 200) {
				util.warn('Unable to clean up after ourselves, left webstrate', webstrateId,
					'on server');
			}
			await browser.close();
		}
	});

	it('should be able to create a webstrate and restrict its permissions', async function() {
		if (config.authType !== 'test') return this.skip();

		await pageAdmin.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageAdmin, () => window.webstrate && window.webstrate.loaded, 5);

		await pageAdmin.evaluate(() => {
			window.permissionsChangedEvent = null;
			window.webstrate.on('permissionsChanged', (permissions) => {
				window.permissionsChangedEvent = permissions;
			});
		});

		await pageAdmin.evaluate((dataAuth) => {
			document.documentElement.setAttribute('data-auth', dataAuth);
		}, JSON.stringify([
			{ username: 'tokensadmin', provider: config.authType, permissions: 'arw' },
			{ username: 'tokensreader', provider: config.authType, permissions: 'r' },
			{ username: 'anonymous', provider: '', permissions: 'r' }
		]));

		// permissionsChanged fires (locally, too) once the data-auth op has
		// round-tripped through the server, i.e. the committed snapshot now
		// resolves these permissions.
		const changed = await util.waitForFunction(pageAdmin, () =>
			window.permissionsChangedEvent && window.permissionsChangedEvent.length === 3, 5);
		assert.isTrue(changed, 'data-auth permissions never round-tripped through the server');

		const user = await pageAdmin.evaluate(() => window.webstrate.user);
		assert.propertyVal(user, 'permissions', 'arw');
	});

	it('read-only users should be able to access the webstrate', async function() {
		if (config.authType !== 'test') return this.skip();

		const resReader = await pageReader.goto(url, { waitUntil: 'domcontentloaded' });
		assert.equal(resReader.status(), 200, 'read-only user could not access the webstrate');

		const resAnon = await pageAnon.goto(url, { waitUntil: 'domcontentloaded' });
		assert.equal(resAnon.status(), 200, 'anonymous user could not access the webstrate');
	});

	it('admin should be able to generate an access token', async function() {
		if (config.authType !== 'test') return this.skip();

		const tokenInfo = await generateToken(pageAdmin);
		assert.propertyVal(tokenInfo, 'webstrateId', webstrateId);
		assert.propertyVal(tokenInfo, 'username', 'tokensadmin');
		adminToken = tokenInfo.token;
		assert.isString(adminToken, 'no token in token generation response');
		assert.isAbove(tokenInfo.expiration, 0, 'no expiration in token generation response');
	});

	it('read-only user should be able to generate an access token', async function() {
		if (config.authType !== 'test') return this.skip();

		const tokenInfo = await generateToken(pageReader);
		assert.propertyVal(tokenInfo, 'webstrateId', webstrateId);
		assert.propertyVal(tokenInfo, 'username', 'tokensreader');
		readerToken = tokenInfo.token;
		assert.isString(readerToken, 'no token in token generation response');
	});

	it('?tokens should list all tokens for admins', async function() {
		if (config.authType !== 'test') return this.skip();

		const tokens = await listTokens(pageAdmin);

		// The admin's own token …
		assert.property(tokens, adminToken, 'admin could not list own token');
		assert.propertyVal(tokens[adminToken], 'username', 'tokensadmin');
		// … and, having admin permissions on the webstrate, everyone else's.
		assert.property(tokens, readerToken,
			'admin could not list the read-only user\'s token (admins must see all tokens)');
		assert.propertyVal(tokens[readerToken], 'username', 'tokensreader');
	});

	it('?tokens should only list own tokens for non-admins', async function() {
		if (config.authType !== 'test') return this.skip();

		const tokens = await listTokens(pageReader);

		// Positive control: the listing still works for regular users …
		assert.property(tokens, readerToken, 'user could not list own token');
		assert.propertyVal(tokens[readerToken], 'username', 'tokensreader');
		// … but must not disclose other users' tokens (P-203).
		assert.notProperty(tokens, adminToken, 'read-only user could see the admin\'s token. ' +
			'?tokens must only list tokens created by the requesting user (matching username ' +
			'and provider).');
	});

	it('?tokens should not list other users\' tokens for anonymous users', async function() {
		if (config.authType !== 'test') return this.skip();

		const tokens = await listTokens(pageAnon);

		assert.isObject(tokens, '?tokens did not return a JSON object');
		assert.notProperty(tokens, adminToken, 'anonymous user could see the admin\'s token');
		assert.notProperty(tokens, readerToken,
			'anonymous user could see the read-only user\'s token');
	});

	it('access tokens should still grant access', async function() {
		if (config.authType !== 'test') return this.skip();

		// The anonymous client accesses the document with the read-only
		// user's token — a token resolves to its creator's permissions.
		const status = await pageAnon.evaluate(async (tokenUrl) => {
			const response = await fetch(tokenUrl);
			return response.status;
		}, url + '?token=' + readerToken);

		assert.equal(status, 200, 'access with a valid token was denied');
	});

});
