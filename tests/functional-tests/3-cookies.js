// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Cookies', function() {
	this.timeout(10000);

	const webstrateIdA = 'test-' + util.randomString();
	const WebstrateIdB = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateIdA;
	const urlB = config.server_address + WebstrateIdB;

	const cookieValue1 = util.randomString();
	const cookieValue2 = util.randomString();
	const cookieValue3 = util.randomString();

	let browserA, browserB, pageA, pageB, pageC;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		[ pageA, pageB, pageC ] = await Promise.all([
			browserA.newPage(),
			browserA.newPage(),
			browserB.newPage()
		]);

		if (util.credentialsProvided) {
			await util.logInToGithub(pageA);
		}

		await Promise.all([
			pageA.goto(urlA, { waitUntil: 'networkidle2' }),
			pageB.goto(urlA, { waitUntil: 'networkidle2' }),
			pageC.goto(urlA, { waitUntil: 'networkidle2' })
		]);

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageC, () => window.webstrate && window.webstrate.loaded)
		]);

	});

	after(async () => {
		await Promise.all([
			pageA.goto(urlA + '?delete', { waitUntil: 'domcontentloaded' }),
			pageB.goto(urlB + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await Promise.all([
			browserA.close(),
			browserB.close()
		]);

		if (!util.credentialsProvided) {
			util.warn('Skipping most cookie tests as no GitHub credentials were provided.');
		}
	});

	// pageA and pageB: same browser, same page, logged in.
	it('cookie object should exist on logged in clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const cookieObjectsExistsA = await util.waitForFunction(pageA, () =>
			window.webstrate.user.cookies && window.webstrate.user.cookies.here
			&& window.webstrate.user.cookies.anywhere);

		const cookieObjectsExistsB = await util.waitForFunction(pageB, () =>
			window.webstrate.user.cookies && window.webstrate.user.cookies.here
			&& window.webstrate.user.cookies.anywhere);

		assert.isTrue(cookieObjectsExistsA);
		assert.isTrue(cookieObjectsExistsB);
	});

	// pageC: another browser, same page, not logged in.
	it('cookie object should not exist on not-logged in clients', async function() {
		const hereCookies = await pageC.evaluate(() => window.webstrate.user.cookies);
		assert.isUndefined(hereCookies);
	});

	it('should be no here cookies on logged in clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const hereCookiesA = await pageA.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.isEmpty(hereCookiesA);

		const hereCookiesB = await pageB.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.isEmpty(hereCookiesB);
	});

	it('should be able to set and read here cookie from client setting cookie', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.evaluate((cookieValue1) =>
			window.webstrate.user.cookies.here.set('__test_1', cookieValue1), cookieValue1);

		await util.waitForFunction(pageA, () => window.webstrate.user.cookies.here.get('__test_1'));

		const hereCookies = await pageA.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.deepEqual(hereCookies, { __test_1: cookieValue1 });
	});

	it('should be able to read here cookie from other tab/page', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await util.waitForFunction(pageB, () => window.webstrate.user.cookies.here.get('__test_1'));

		const hereCookies = await pageB.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.deepEqual(hereCookies, { __test_1: cookieValue1 });
	});

	it('should be able to set cookieUpdateHere event listener on all clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.evaluate(() => {
			window.__test_cookie = false;
			window.webstrate.on('cookieUpdateHere', (key, value) =>  window.__test_cookie = [key, value]);
		});
		await pageB.evaluate(() => {
			window.__test_cookie = false;
			window.webstrate.on('cookieUpdateHere', (key, value) =>  window.__test_cookie = [key, value]);
		});
		await pageC.evaluate(() => {
			window.__test_cookie = false;
			window.webstrate.on('cookieUpdateHere', (key, value) =>  window.__test_cookie = [key, value]);
		});
	});

	it('setting cookie should trigger cookieUpdateHere event on client setting cookie',
		async function() {
			if (!util.credentialsProvided) {
				return this.skip();
			}

			await pageA.evaluate((cookieValue2) =>
				window.webstrate.user.cookies.here.set('__test_2', cookieValue2), cookieValue2);

			const cookieSet = await util.waitForFunction(pageA, () => window.__test_cookie);
			assert.isTrue(cookieSet);
		});

	it('cookieUpdateHere should trigger with correct values on client setting cookie',
		async function() {
			if (!util.credentialsProvided) {
				return this.skip();
			}

			const [cookieKey, cookieValue] = await pageA.evaluate(() => window.__test_cookie);

			assert.equal(cookieKey, '__test_2');
			assert.equal(cookieValue, cookieValue2);
		});

	it('setting cookie should trigger cookieUpdateHere event on other client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const cookieSet = await util.waitForFunction(pageB, () => window.__test_cookie);
		assert.isTrue(cookieSet);
	});

	it('cookieUpdateHere should trigger with correct values on other client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const [cookieKey, cookieValue] = await pageB.evaluate(() => window.__test_cookie);

		assert.equal(cookieKey, '__test_2');
		assert.equal(cookieValue, cookieValue2);
	});

	it('cookieUpdateHere should not trigger on foreign client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const cookieSet = await util.waitForFunction(pageC, () => window.__test_cookie);
		assert.isFalse(cookieSet);
	});

	it('here cookies should persist after reload', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.goto(urlA, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);

		const hereCookies = await pageA.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.deepEqual(hereCookies, {
			__test_1: cookieValue1,
			__test_2: cookieValue2
		});
	});

	// pageC: another browser, same page, logged in.
	it('here cookies should be accessible on other client after login', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await util.logInToGithub(pageC);
		await pageC.goto(urlA, { waitUntil: 'networkidle2' });

		const hereCookies = await pageC.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.deepEqual(hereCookies, {
			__test_1: cookieValue1,
			__test_2: cookieValue2
		});
	});

	// pageA: now on another window.webstrate.
	// pageB, pageC: still on initial window.webstrate.
	//
	// We can't test for 'no anywhere cookies', as the user account we're using might be using
	// anywhere cookies.
	it('should be no here cookies on other window.webstrate', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.goto(urlB, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		const hereCookies = await pageA.evaluate(() => window.webstrate.user.cookies.here.get());
		assert.isEmpty(hereCookies);
	});

	it('should be able to set cookieUpdateAnywhere event listener on all clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await Promise.all([
			pageA.evaluate(() => {
				window.__test_cookie = false;
				window.webstrate.on('cookieUpdateAnywhere', (key, value) =>
					window.__test_cookie = [key, value]);
			}),
			pageB.evaluate(() => {
				window.__test_cookie = false;
				window.webstrate.on('cookieUpdateAnywhere', (key, value) =>
					window.__test_cookie = [key, value]);
			}),
			pageC.evaluate(() => {
				window.__test_cookie = false;
				window.webstrate.on('cookieUpdateAnywhere', (key, value) =>
					window.__test_cookie = [key, value]);
			})
		]);
	});

	it('should be able to set and read anywhere cookie from client setting cookie', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.evaluate((cookieValue3) =>
			window.webstrate.user.cookies.anywhere.set('__test_3', cookieValue3), cookieValue3);

		const cookieSet = await util.waitForFunction(pageA, () =>
			window.webstrate.user.cookies.anywhere.get('__test_3'));
		assert.isTrue(cookieSet);
	});

	it('should be able to set and read anywhere cookie from other client/browser', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageC.evaluate((cookieValue3) =>
			window.webstrate.user.cookies.anywhere.set('__test_3', cookieValue3), cookieValue3);

		const cookieSet = await util.waitForFunction(pageC, () =>
			window.webstrate.user.cookies.anywhere.get('__test_3'));
		assert.isTrue(cookieSet);
	});

	it('setting cookie should trigger cookieUpdateAnywhere event on client setting cookie',
		async function() {
			if (!util.credentialsProvided) {
				return this.skip();
			}

			await pageA.evaluate((cookieValue3) =>
				window.webstrate.user.cookies.anywhere.set('__test_3', cookieValue3), cookieValue3);

			const cookieSet = await util.waitForFunction(pageA, () => window.__test_cookie);
			assert.isTrue(cookieSet);
		});

	it('cookieUpdateAnywhere should trigger with correct values on client setting cookie',
		async function() {
			if (!util.credentialsProvided) {
				return this.skip();
			}

			const [cookieKey, cookieValue] = await pageA.evaluate(() => window.__test_cookie);

			assert.equal(cookieKey, '__test_3');
			assert.equal(cookieValue, cookieValue3);
		});

	it('setting cookie should trigger cookieUpdateAnywhere event on other client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const cookieSet = await util.waitForFunction(pageC, () => window.__test_cookie);
		assert.isTrue(cookieSet);
	});

	it('cookieUpdateAnywhere should trigger with correct values on other client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const [cookieKey, cookieValue] = await pageC.evaluate(() => window.__test_cookie);

		assert.equal(cookieKey, '__test_3');
		assert.equal(cookieValue, cookieValue3);
	});
});
