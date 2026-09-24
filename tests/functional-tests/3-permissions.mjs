// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// The webstrates client only connects to the webstrate it was loaded from, so to talk to
// another webstrate id we open a raw websocket to that id ourselves. In the native protocol
// opening the socket IS the subscribe: the server sends the hello (document id + head
// revision) as soon as the join passes the read check, and sends nothing at all when it
// doesn't. Resolves with null when the hello arrived (subscribe succeeded), or a description
// of the failure otherwise (no hello within 2s = subscribe denied).
const subscribeOnRawSocket = (page, webstrateId) => page.evaluate((id) => new Promise((resolve) => {
	const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
	const finish = (error) => {
		try { socket.close(); } catch (e) {}
		resolve(error || null);
	};
	setTimeout(() => finish('no hello: subscribe denied'), 2000);
	socket.onerror = () => finish('websocket error');
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.wa === 'hello' && message.d === id) finish(null);
	};
}), webstrateId);

// Create a webstrate that carries its permissions in the create commit itself, so that no
// permission-changing op follows: a base-0 wire commit growing the empty mirror, with the
// data-auth attribute applied to the html element in the same transaction. The webstrate is
// restricted to the given user. (No handshake prelude is needed anymore — the server buffers
// early frames until the connection is set up.)
const createWebstrateOnRawSocket = (page, webstrateId, username, provider) =>
page.evaluate((id, username, provider) => new Promise((resolve) => {
	const ops = [
		{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
		{ k: 'aa', e: 1, i: 0, n: 'data-auth', v: JSON.stringify([{
			username: username,
			provider: provider,
			permissions: 'rw'
		}]) },
		{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
		{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' }
	];
	const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
	const finish = (error) => {
		try { socket.close(); } catch (e) {}
		resolve(error || null);
	};
	setTimeout(() => finish('timeout'), 5000);
	socket.onopen = () => socket.send(JSON.stringify({
		wa: 'commit', d: id, base: 0, token: 'create', ops
	}));
	socket.onerror = () => finish('websocket error');
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.wa === 'reply' && message.token === 'create') {
			finish(message.error ? 'Create failed: ' + JSON.stringify(message.error) : null);
		}
	};
}), webstrateId, username, provider);

describe('Permissions', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';

	let browserA, browserB, pageA, pageB, pageC;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		pageA = await browserA.newPage();
		if (util.credentialsProvided) {
			console.log("Logging in...");
			await util.logInToAuth(pageA);
			console.log("Logged in...");
		}
		pageB = await browserA.newPage();
		pageC = await browserB.newPage();

		await pageA.goto(url, { waitUntil: 'networkidle2' });

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageC, () => window.webstrate && window.webstrate.loaded)
		]);
	});

	after(async () => {
		if (!util.credentialsProvided) {
			util.warn('Skipping most permission tests as no GitHub credentials were provided.');
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
		const userObject = await pageA.evaluate(() => window.webstrate.user);

		assert.deepEqual(permissions, [
			{
				username: userObject.username,
				provider: config.authType,
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

	it('webstrate.permissions should match updated permissions (locally)',
		async function() {
			if (!util.credentialsProvided) return this.skip();

			const userObject = await pageA.evaluate(() => window.webstrate.user);
			const permissions = await pageA.evaluate(() => window.webstrate.permissions);
			assert.deepEqual(permissions, [
				{
					username: userObject.username,
					provider: config.authType,
					permissions: 'rw'
				},
				{
					username: 'anonymous',
					provider: '',
					permissions: 'r'
				}
			]);
		});

	it('webstrate.permissions should match updated permissions (remotely)',
		async function() {
			await pageB.goto(url, { waitUntil: 'networkidle2' });
			await pageC.goto(url, { waitUntil: 'networkidle2' });
	
			if (!util.credentialsProvided) return this.skip();

			const tabUser = await pageB.evaluate(() => window.webstrate.user);			
			const tabPermissions = await pageB.evaluate(() => window.webstrate.permissions);
			const remoteUser = await pageC.evaluate(() => window.webstrate.user);			
			const remotePermissions = await pageC.evaluate(() => window.webstrate.permissions);

			assert.deepEqual(tabPermissions, [
				{
					username: tabUser.username,
					provider: config.authType,
					permissions: 'rw'
				},
				{
					username: 'anonymous',
					provider: '',
					permissions: 'r'
				}
			], "User in another tab in the same browser did not match");
			assert.deepEqual(remotePermissions, [
				{
					username: tabUser.username,
					provider: config.authType,
					permissions: 'rw'
				},
				{
					username: 'anonymous',
					provider: '',
					permissions: 'r'
				}
			], "Anonymous in another browser did not match");			
	});

	it('webstrate.user.permissions should remain unchanged for user', async function() {
		if (!util.credentialsProvided) return this.skip();

		const permissions = await pageA.evaluate(() => window.webstrate.user.permissions);
		assert.equal(permissions, 'rw');
	});

	it('should be able to access webstrate with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();

		const res = await pageC.goto(url, { waitUntil: 'networkidle2' });
		// The document page carries an ETag keyed to its revision with
		// must-revalidate caching, so reloading an unchanged document is
		// answered with a 304 and the browser serves its cached copy — a
		// fully working load of the same fresh page, not a denial.
		assert.oneOf(res.status(), [200, 304],
			'the webstrate page should be served (200) or revalidated (304)');

		const pageLoaded = await util.waitForFunction(pageC, () =>
			window.webstrate && window.webstrate.loaded, 3);
		assert.isTrue(pageLoaded);
	});

	it('should not be able to edit webstrate with only read permissions', async function() {
		if (!util.credentialsProvided) return this.skip();
		// The read-only client's edit needs an element id from the server
		// before it can even be committed; the allocids call is denied, so
		// the client must roll the optimistically applied edit back. That
		// rollback is a round trip — poll for it, bounded, rather than
		// asserting the text was never visible at all.
		this.timeout(30000);

		const randomString = util.randomString();
		await pageC.evaluate((s) => document.body.innerText = s, randomString);

		const pageAChanged = await util.waitForFunction(pageA, (s) =>
			document.body.innerText === s, 2, randomString);
		assert.isFalse(pageAChanged);

		const pageBChanged = await util.waitForFunction(pageB, (s) =>
			document.body.innerText === s, .2, randomString);
		assert.isFalse(pageBChanged);

		let pageCReverted = false;
		const revertDeadline = Date.now() + 20000;
		while (Date.now() < revertDeadline) {
			const currentText = await pageC.evaluate(() => document.body.innerText);
			if (currentText !== randomString) {
				pageCReverted = true;
				break;
			}
			await util.sleep(0.25);
		}
		assert.isTrue(pageCReverted,
			'the rejected edit should be reverted on the read-only client');
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

	// A client subscribing to a webstrate that doesn't exist yet is served the default
	// permissions. Those permissions must not stick to the webstrate id once the webstrate is
	// later created with more restrictive permissions of its own.
	it('should not give anonymous access to a webstrate that was created with permissions ' +
		'after anonymous subscribed to the not-yet-existing webstrate', async function() {
		if (!util.credentialsProvided) return this.skip();

		const newWebstrateId = 'test-' + util.randomString();
		const newUrl = config.server_address + newWebstrateId;
		const userObject = await pageA.evaluate(() => window.webstrate.user);

		// Subscribe to the webstrate id as an anonymous client while the webstrate doesn't
		// exist yet. We can't use the webstrates client for this, as it would create the
		// webstrate.
		const subscribeError = await subscribeOnRawSocket(pageC, newWebstrateId);
		assert.isNotOk(subscribeError, 'Anonymous could not subscribe to the webstrate.');

		// Create the webstrate restricted to the logged in user, with the permissions carried
		// by the create operation, so that no permission-changing operation follows.
		const createError = await createWebstrateOnRawSocket(pageA, newWebstrateId,
			userObject.username, userObject.provider);
		assert.isNotOk(createError, 'The webstrate could not be created.');

		// Anonymous must not be able to subscribe to the webstrate. Serving the stale default
		// permissions that were cached while the webstrate didn't exist yet would let them.
		const leakError = await subscribeOnRawSocket(pageC, newWebstrateId);
		assert.isOk(leakError, 'Anonymous could subscribe to the restricted webstrate.');

		// The restricted user can still delete the webstrate, cleaning up after the test.
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		const deleteRes = await pageA.goto(newUrl + '?delete', { waitUntil: 'networkidle2' });
		assert.equal(deleteRes.status(), 200);

		// Go back to the shared webstrate for the tests that follow.
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
	});

	it('should not give anonymous access to a webstrate that was created with permissions ' +
		'when nobody subscribed to the webstrate id before its creation', async function() {
		if (!util.credentialsProvided) return this.skip();

		const newWebstrateId = 'test-' + util.randomString();
		const newUrl = config.server_address + newWebstrateId;
		const userObject = await pageA.evaluate(() => window.webstrate.user);

		// Create the webstrate restricted to the logged in user, with no client having
		// subscribed to the webstrate id before.
		const createError = await createWebstrateOnRawSocket(pageA, newWebstrateId,
			userObject.username, userObject.provider);
		assert.isNotOk(createError, 'The webstrate could not be created.');

		// Anonymous must not be able to subscribe to the webstrate.
		const leakError = await subscribeOnRawSocket(pageC, newWebstrateId);
		assert.isOk(leakError, 'Anonymous could subscribe to the restricted webstrate.');

		// The restricted user can still delete the webstrate, cleaning up after the test.
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		const deleteRes = await pageA.goto(newUrl + '?delete', { waitUntil: 'networkidle2' });
		assert.equal(deleteRes.status(), 200);

		// Go back to the shared webstrate for the tests that follow.
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
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

	it('should fire permissionsChanged event locally and remotely', async function() {
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await pageB.goto(url, { waitUntil: 'networkidle2' });
		await pageC.goto(url, { waitUntil: 'networkidle2' });

		let fakePermissions = [
			{
				username: "anonymous",
				provider: "",
				permissions: 'rw'
			}, 
			{
				username: "eventuser",
				provider: "fake",
				permissions: 'rw'
			}, 
		];
		await pageC.evaluate(()=>{webstrate.on("permissionsChanged", (e)=>{window.lastChange = e});});
		await pageA.evaluate(()=>{webstrate.on("permissionsChanged", (e)=>{window.lastChange = e});});
		await pageC.evaluate((s) => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify(s)
			);
		}, fakePermissions);
		await util.waitForFunction(pageA, () => window.lastChange, 2);  		
		await util.waitForFunction(pageC, () => window.lastChange, 2);  		

		let aPerm = await pageA.evaluate(() => {return window.lastChange});
		let cPerm = await pageC.evaluate(() => {return window.lastChange});
		assert.deepEqual(cPerm, fakePermissions, 'Event is missing or wrong on local client');
		assert.deepEqual(aPerm, fakePermissions, 'Event is missing or wrong on remote client');
	});		

	it('anonymous should have access when data-auth is invalid', async function() {
		// Set data-auth to something invalid  
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate.loaded);
		await pageA.evaluate(() => {  
			document.documentElement.setAttribute('data-auth', 'this-is-not-json');  
		});  
		
		// Not-logged-in can access the webstrate  
		const resC = await pageC.goto(url, { waitUntil: 'networkidle2' });  
		assert.equal(resC.status(), 200);  
		
		const testString = util.randomString();  
		await pageC.evaluate((s) => document.body.innerText = s, testString);  
		const propagated = await util.waitForFunction(pageA, (s) =>  
			document.body.innerText === s, 2, testString);  
		assert.isTrue(propagated);  		
	});	

	it('logged in users should have access when data-auth is invalid', async function() {
		// ...continues from last testcase
		if (!util.credentialsProvided) return this.skip();
		
		// logged-in can access the webstrate  
		const resB = await pageB.goto(url, { waitUntil: 'networkidle2' });  
		assert.equal(resB.status(), 200);  
		
		const testString = util.randomString();  
		await pageB.evaluate((s) => document.body.innerText = s, testString);  
		const propagated = await util.waitForFunction(pageA, (s) =>  
			document.body.innerText === s, 2, testString);  
		assert.isTrue(propagated);  		
	});

	it('permission changes made via data-auth on A should propagate and match data-auth on client B', async function() {
		// Ensure both clients are on the correct page and loaded.  
		await pageA.goto(url, { waitUntil: 'networkidle2' });  
		await util.waitForFunction(pageA, () => window.webstrate.loaded);
	
		// Set permissions directly via data-auth attribute on pageA  
		const newPermissions = [  
			{  
				username: 'anonymous',  
				provider: '',  
				permissions: 'rw'  
			},  
			{  
				username: 'testuser',  
				provider: '',  
				permissions: 'r'  
			}  
		];  
		
		const newDataAuth = JSON.stringify(newPermissions);  
		
		await pageA.evaluate(dataAuth => {  
			document.documentElement.setAttribute('data-auth', dataAuth);  
		}, newDataAuth);  
		
		// Wait for the data-auth attribute to propagate to pageB  
		const propagated = await util.waitForFunction(pageB, expected =>  
			document.documentElement.getAttribute('data-auth') === expected, 2, newDataAuth);  
		const resultB = await pageB.evaluate(()=>{
			return document.documentElement.getAttribute('data-auth');
		})
		const resultA = await pageA.evaluate(()=>{
			return document.documentElement.getAttribute('data-auth');
		})
		
		assert.deepEqual(resultA, newDataAuth, 'data-auth attribute did apply on A');  
		assert.deepEqual(resultB, newDataAuth, 'data-auth attribute did not propagate to client B');  
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
