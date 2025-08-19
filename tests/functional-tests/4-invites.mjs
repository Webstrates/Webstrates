// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert, expect } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Invites', function () {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browserA, browserB, browserC, pageA, pageB, pageC;
	let currentInvitation;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();
		browserC = await puppeteer.launch();

		pageA = await browserA.newPage();
		pageB = await browserB.newPage();
		pageC = await browserC.newPage();

		if (config.authType === 'test') {
			console.log('Logging in testuserA...');
			await util.logInToTest(pageA, 'testuserA');
			console.log('Logged in testuserA...');

			console.log('Logging in testuserB...');
			await util.logInToTest(pageB, 'testuserB');
			console.log('Logged in testuserB...');
		}
	});

	after(async () => {
		if (config.authType !== 'test') {
			util.warn('Skipping most permission tests as no test auth provider was used');
			return;
		}

		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await Promise.all([
			browserA.close(),
			browserB.close(),
			browserC.close()
		]);
	});

	it('User A should be able to set permissions', async function () {
		if (config.authType !== 'test') return this.skip();

		await pageA.goto(url, { waitUntil: 'networkidle2' });

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([{
					username: 'testuserA',
					provider: 'test',
					permissions: 'awr'
				}])
			);
		});
	});

	it('User B should not have access to the webstrate', async function () {
		if (config.authType !== 'test') return this.skip();

		const result = await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(result.status(), 403);
	});

	it('Creating an invitation with a time limit of 2 seconds should be available immediately', async function () {
		if (config.authType !== 'test') return this.skip();

		currentInvitation = await pageA.evaluate(async () => {
			return await window.webstrate.user.invites.create({
				permissions: 'r',
				maxAge: '2'
			});
		});

		assert.exists(currentInvitation, 'No invitation generated');
		assert.exists(currentInvitation.key, 'Invitation is missing a key');
	});

	it('Valid invitation should be in list of currently active invitations', async function () {
		if (config.authType !== 'test') return this.skip();

		const invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());
		assert.exists(invitations.find(i => i.key === currentInvitation.key), 'Invitation not in invites.get() list');
	});

	it('Valid invitation should pass the validity check and return data', async function () {
		if (config.authType !== 'test') return this.skip();

		const checkedInvitation = await pageA.evaluate((key) => window.webstrate.user.invites.check(key), currentInvitation.key);
		assert.exists(checkedInvitation, 'Valid invitation did not pass check(...)');
	});

	it('User B should be able to use the invitation to access the webstrate', async function () {
		if (config.authType !== 'test') return this.skip();

		await pageB.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle2' });

		const invitePermission = await pageB.evaluate(async (key, webstrateId) => {
			return await window.webstrate.user.invites.accept(key, webstrateId);
		}, currentInvitation.key, webstrateId);

		assert.equal(invitePermission, 'r', 'Invitation was not accepted or returned unexpected permissions');

		const result = await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(result.status(), 200, 'User B could not access the webstrate after accepting the invitation');
	});

	it('Expired invitation should not be in list of currently active invitations', async function () {
		if (config.authType !== 'test') return this.skip();

		// Expire the invitation
		await new Promise((resolve) => { setTimeout(resolve, 2000) });

		const invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());
		assert.notExists(invitations.find(i => i.key === currentInvitation.key), 'Invitation expired but still in invites.get() list');
	});

	it('Expired invitation should fail validity check', async function () {
		if (config.authType !== 'test') return this.skip();

		let error;
		try {
			value = await pageA.evaluate((key) => window.webstrate.user.invites.check(key), currentInvitation.key);
		} catch (ex) {
			error = ex;
		}
		expect(error).to.be.an('Error');
	});

	it('Accepting an invitation correctly merges permissions with existing ones', async function () {
		if (config.authType !== 'test') return this.skip();

		currentInvitation = await pageA.evaluate(async () => {
			return await window.webstrate.user.invites.create({ permissions: 'w' });
		});

		const mergedPermissions = await pageB.evaluate(async (key) => {
			return await window.webstrate.user.invites.accept(key);
		}, currentInvitation.key);

		assert.equal(mergedPermissions, 'rw', 'User B should have both read and write permissions after accepting the invitation');
	});

	it('User A should be able to remove an invitation', async function () {
		if (config.authType !== 'test') return this.skip();

		let invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());
		assert.exists(invitations.find(i => i.key === currentInvitation.key), 'Created invitation not found in list');

		const removeResult = await pageA.evaluate(async (key) => {
			return await window.webstrate.user.invites.remove(key);
		}, currentInvitation.key);
		assert.equal(removeResult.deletedCount, 1, 'Remove operation should return a result');

		invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());
		assert.notExists(invitations.find(i => i.key === currentInvitation.key), 'Removed invitation still appears in list');

		let error;
		try {
			await pageA.evaluate((key) => window.webstrate.user.invites.check(key), currentInvitation.key);
		} catch (ex) {
			error = ex;
		}
		expect(error).to.be.an('Error');
		expect(error.message).to.include('Invalid invitation key');
	});

	it('Users should be able to accept invites using the HTTP API', async function () {
		if (config.authType !== 'test') return this.skip();

		const invite = await pageA.evaluate(async () => {
			return await window.webstrate.user.invites.create({ permissions: 'r' });
		});

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: 'testuserA',
						provider: 'test',
						permissions: 'awr'
					}
				])
			);
		});

		const result = await pageB.goto(`${url}?acceptInvite=${invite.key}`, { waitUntil: 'networkidle2' });
		assert.equal(result.status(), 200, 'User B could not access the webstrate after accepting the invite via HTTP API');

		const permissions = await pageA.evaluate(() => {
			return document.documentElement.getAttribute('data-auth');
		});

		const userBAuth = JSON.parse(permissions).find(user => user.username === 'testuserB' && user.provider === 'test');
		assert.exists(userBAuth, 'User B should be in the data-auth attribute after accepting the invite');
		assert.equal(userBAuth.permissions, 'r', 'User B should have read permissions after accepting the invite');

	});

	it('User should not be able to remove invitations created by other users', async function () {
		if (config.authType !== 'test') return this.skip();

		currentInvitation = await pageA.evaluate(async () => {
			return await window.webstrate.user.invites.create({ permissions: 'w' });
		});

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: 'testuserA',
						provider: 'test',
						permissions: 'awr'
					},
					{
						username: 'testuserB',
						provider: 'test',
						permissions: 'awr'
					}
				])
			);
		});

		await pageB.goto(url, { waitUntil: 'networkidle2' });

		let error;
		try {
			await pageB.evaluate(async (key) => {
				return await window.webstrate.user.invites.remove(key);
			}, currentInvitation.key);
		} catch (ex) {
			error = ex;
		}

		expect(error).to.be.an('Error');
		expect(error.message).to.include('Unable to delete invite');

		// Verify the invitation still exists
		const invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());
		assert.exists(invitations.find(i => i.key === currentInvitation.key), 'Invitation should still exist after failed removal attempt');
	});

	it('An invite sent by a user which now has lost admin permission becomes invalid', async function () {
		if (config.authType !== 'test') return this.skip();

		// Remove admin permissions from User A
		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: 'testuserA',
						provider: 'test',
						permissions: 'wr'
					},
					{
						username: 'testuserB',
						provider: 'test',
						permissions: 'r'
					}
				])
			);
		});

		await pageB.goto(url, { waitUntil: 'networkidle2' });

		let error;
		try {
			await pageB.evaluate(async (key) => {
				return await window.webstrate.user.invites.accept(key);
			}, currentInvitation.key);
		} catch (ex) {
			error = ex;
		}

		expect(error).to.be.an('Error');
		expect(error.message).to.include('Inviter is no longer admin on the webstrate, invitation invalid');

		// Check that no new permissions were granted by getting the data-auth attribute
		const permissions = await pageB.evaluate(() => {
			return document.documentElement.getAttribute('data-auth');
		});

		const userBAuth = JSON.parse(permissions).find(user => user.username === 'testuserB' && user.provider === 'test');
		assert.exists(userBAuth, 'User B should still be in the data-auth attribute');
		assert.equal(userBAuth.permissions, 'r', 'User B should not have gained any new permissions after the invite was accepted');
	});

	it('Invite API should be available for logged-in users only', async function () {
		await pageC.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle2' });

		// Try to create an invitation without being logged in - should fail
		let error;
		try {
			await pageC.evaluate(async () => {
				return await window.webstrate.user.invites.create();
			});
		} catch (ex) {
			error = ex;
		}
		expect(error).to.be.an('Error');
		expect(error.message).to.include('Must be logged in to handle invites');
	});
});
