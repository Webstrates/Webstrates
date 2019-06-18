// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Permissions', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browserA, browserB, pageA, pageB, pageC;

	before(async () => {
		if (!util.credentialsProvided) return;

		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		[ pageA, pageB, pageC ] = await Promise.all([
			browserA.newPage(),
			browserA.newPage(),
			browserB.newPage()
		]);

		await util.logInToGithub(pageA);

		await pageA.goto(url, { waitUntil: 'networkidle2' });

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageC, () => window.webstrate && window.webstrate.loaded)
		]);
	});

	after(async () => {
		if (!util.credentialsProvided) {
			util.warn('Skipping all permission tests as no GitHub credentials were provided.');
			return;
		}

		// await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' }),

		await Promise.all([
			browserA.close(),
			browserB.close()
		]);
	});

	it('should be able to set permissions on logged in client', async function() {
		if (!util.credentialsProvided) return this.skip();

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: window.webstrate.user.username,
						provider: window.webstrate.user.provider,
						permissions: 'rw'
					}
				])
			);
		});
	});

	it('webstrate.permissions should match what we set on logged in client', async function() {
		if (!util.credentialsProvided) return this.skip();

		const permissions = await pageA.evaluate(() => window.webstrate.permissions);
		assert.deepEqual(permissions, [
			{
				username: config.username,
				provider: 'github',
				permissions: 'rw'
			}
		]);
	});

	it('webstrate.user.permissions should match what we set on logged in client', async function() {
		if (!util.credentialsProvided) return this.skip();

		const permissions = await pageA.evaluate(() => window.webstrate.user.permissions);
		assert.equal(permissions, 'rw');
	});

	// pageA and pageB: same browser, same page, logged in.
	it('should be able to access webstrate ops from other logged in client', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageB.goto(url + '?ops', { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 200);
	});

	it('should be able to access webstrate assets list from other logged in client',
		async function() {
			if (!util.credentialsProvided) return this.skip();

			const res = await pageB.goto(url + '?assets', { waitUntil: 'networkidle2' });
			assert.equal(res.status(), 200);
		});

	it('should be able to access webstrate from other logged in client', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 200);
	});

	// pageC: another browser, same page, not logged in.
	it('should not be able to access webstrate ops with no permissions',
		async function() {
			if (!util.credentialsProvided) return this.skip();

			const res = await pageC.goto(url + '?ops', { waitUntil: 'networkidle2' });
			assert.equal(res.status(), 403);
		});

	it('should not be able to access webstrate assets list with no permissions',
		async function() {
			if (!util.credentialsProvided) return this.skip();

			const res = await pageC.goto(url + '?assets', { waitUntil: 'networkidle2' });
			assert.equal(res.status(), 403);
		});

	it('should not be able to access webstrate with no permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 403);
	});

	it('should not be able to delete webstrate with no permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url + '?delete', { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 403);
	});

	it('should be able to update permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: window.webstrate.user.username,
						provider: window.webstrate.user.provider,
						permissions: 'rw'
					},
					{
						username: 'anonymous',
						provider: '',
						permissions: 'r'
					}
				])
			);
		});
	});

	it('webstrate.permissions should match updated permissions',
		async function() {
			if (!util.credentialsProvided) return this.skip();

			const permissions = await pageA.evaluate(() => window.webstrate.permissions);
			assert.deepEqual(permissions, [
				{
					username: config.username,
					provider: 'github',
					permissions: 'rw'
				},
				{
					username: 'anonymous',
					provider: '',
					permissions: 'r'
				}
			]);
		});

	it('webstrate.user.permissions should remain unchanged for user', async function() {
		if (!util.credentialsProvided) return this.skip();

		const permissions = await pageA.evaluate(() => window.webstrate.user.permissions);
		assert.equal(permissions, 'rw');
	});

	it('should be able to access webstrate with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 200);

		const pageLoaded = await util.waitForFunction(pageC, () =>
			window.webstrate && window.webstrate.loaded, 3);
		assert.isTrue(pageLoaded);
	});

	it('should not be able to edit webstrate with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const randomString = util.randomString();
		await pageC.evaluate((s) => document.body.innerText = s, randomString);

		const pageAChanged = await util.waitForFunction(pageA, (s) =>
			document.body.innerText === s, 2, randomString);
		assert.isFalse(pageAChanged);

		const pageBChanged = await util.waitForFunction(pageB, (s) =>
			document.body.innerText === s, .2, randomString);
		assert.isFalse(pageBChanged);

		// We deliberately do pageC last, because we need to wait a little before reading the
		// document.body.innerText that we just set, or it may not have been reverted yet.
		const pageCChanged = await util.waitForFunction(pageC, (s) =>
			document.body.innerText === s, .2, randomString);
		assert.isFalse(pageCChanged);
	});

	it('should be able to access webstrate ops with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url + '?ops', { waitUntil: 'networkidle2' });
		assert.equal(res.status(), 200);
	});

	it('should not be able to delete webstrate with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url + '?delete', { waitUntil: 'networkidle2' });

		assert.equal(res.status(), 403);
	});

	it('should be able to update permissions again', async function() {
		if (!util.credentialsProvided) return this.skip();

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: window.webstrate.user.username,
						provider: window.webstrate.user.provider,
						permissions: 'rw'
					},
					{
						username: 'anonymous',
						provider: '',
						permissions: 'rw'
					}
				])
			);
		});
	});

	it('should be able to edit webstrate with write permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		await pageC.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageC, () => window.webstrate.loaded);

		const randomString = util.randomString();
		await pageC.evaluate((s) => document.body.innerText = s, randomString);

		const pageAChanged = await util.waitForFunction(pageA, (s) =>
			document.body.innerText === s, 2, randomString);
		assert.isTrue(pageAChanged);

		const pageBChanged = await util.waitForFunction(pageB, (s) =>
			document.body.innerText === s, .2, randomString);
		assert.isTrue(pageBChanged);

		const pageCChanged = await util.waitForFunction(pageC, (s) =>
			document.body.innerText === s, .2, randomString);
		assert.isTrue(pageCChanged);
	});

	it('should be able to delete webstrate with write permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url + '?delete', { waitUntil: 'networkidle2' });

		if (res.status() !== 200) {
			util.warn('Unable to clean up after ourselves, left webstrate', webstrateId, 'on server');
		}
		assert.equal(res.status(), 200);
	});

});
