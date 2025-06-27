// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Permissions', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

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
