// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert, expect } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Invites', function () {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';

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

		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
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

		await pageB.goto(config.server_address + 'frontpage/', { waitUntil: 'networkidle2' });

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
		await pageC.goto(config.server_address + 'frontpage/', { waitUntil: 'networkidle2' });

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

	// The client library always fills in permissions and maxAge with defaults before
	// sending, but the invite actions are a websocket protocol of their own: any client
	// can send a createInvite action with no options field at all, or with an empty one.
	// The tests below speak that raw protocol from a logged-in admin page, to pin down
	// what the server does on its own, without the client library smoothing over the gaps.
	const rawInviteRequest = (page, action, options) => {
		const token = 'invite-' + action + '-' + util.randomString();
		return page.evaluate((id, action, options, token) => new Promise((resolve) => {
			// options === null means "send no options field at all".
			const message = { wa: action, d: id, token };
			if (options !== null) message.options = options;

			const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
			const finish = (reply) => {
				try { socket.close(); } catch (err) {}
				resolve(reply);
			};
			setTimeout(() => finish({ error: 'timeout waiting for ' + action + ' reply' }), 5000);
			socket.onerror = () => finish({ error: 'websocket error' });
			socket.onopen = () => {
				// ShareDB expects a handshake before the connection settles into anything
				// usable, so open with one we don't rely on before sending the actual action.
				socket.send(JSON.stringify({ a: 'hs', id: null, protocol: 1, protocolMinor: 2 }));
				setTimeout(() => socket.send(JSON.stringify(message)), 200);
			};
			socket.onmessage = (event) => {
				const reply = JSON.parse(event.data);
				if (reply.wa === 'reply' && reply.token === token) finish(reply);
			};
		}), webstrateId, action, options, token);
	};

	// The data-auth write below is an operation like any other: poll until the server
	// actually enforces the admin permissions it grants before the tests below rely on them.
	const awaitAdminPermissions = async (page) => {
		const deadline = Date.now() + 5000;
		while (true) {
			const reply = await rawInviteRequest(page, 'getInvites', null);
			if (!reply.error) return;
			if (Date.now() > deadline) {
				throw new Error('admin permissions did not take effect in time: ' + reply.error);
			}
			await util.sleep(0.2);
		}
	};

	it('User A regains admin permissions over the webstrate', async function () {
		if (config.authType !== 'test') return this.skip();

		// The previous test case ended with user A losing admin permissions; grant them
		// back for the invite tests below, keeping the read permissions user B earned.
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
						permissions: 'r'
					}
				])
			);
		});

		await awaitAdminPermissions(pageA);
	});

	it('Creating an invite without an options field yields a working invite with the default lifetime and permissions', async function () {
		if (config.authType !== 'test') return this.skip();

		const reply = await rawInviteRequest(pageA, 'createInvite', null);

		assert.isUndefined(reply.error, 'createInvite without an options field failed: ' + reply.error);
		assert.match(reply.reply.key, /^[0-9a-f]{64}$/, 'invite is missing its key');
		assert.equal(reply.reply.permissions, 'r', 'invite without options should default to read permissions');

		// The default lifetime is the one-week default the client library applies, too.
		assert.isNotNull(reply.reply.expiresAt, 'invite without options has no expiry');
		assert.closeTo(new Date(reply.reply.expiresAt).getTime(),
			Date.now() + 7 * 24 * 3600 * 1000, 60 * 1000, 'default expiry should be one week out');

		const check = await rawInviteRequest(pageA, 'checkInvite', { key: reply.reply.key });
		assert.isUndefined(check.error, 'invite created without options is not usable: ' + check.error);
	});

	it('Creating an invite with an empty options object yields a usable invite instead of a dead one', async function () {
		if (config.authType !== 'test') return this.skip();

		const reply = await rawInviteRequest(pageA, 'createInvite', {});

		assert.isUndefined(reply.error, 'createInvite with empty options failed: ' + reply.error);
		assert.equal(reply.reply.permissions, 'r', 'invite with empty options should default to read permissions');
		assert.isNotNull(reply.reply.expiresAt, 'invite with empty options has no expiry');
		assert.closeTo(new Date(reply.reply.expiresAt).getTime(),
			Date.now() + 7 * 24 * 3600 * 1000, 60 * 1000, 'default expiry should be one week out');

		// The expired-invite sweep runs before every invite action, so an invite whose
		// expiry was not a real date is born already swept away. Its key must survive one
		// more API call to prove the invite was actually usable.
		const check = await rawInviteRequest(pageA, 'checkInvite', { key: reply.reply.key });
		assert.isUndefined(check.error, 'invite created with empty options is dead on arrival: ' + check.error);
		assert.equal(check.reply.key, reply.reply.key);
	});

	it('maxAge values that are not positive numbers fall back to the default lifetime', async function () {
		if (config.authType !== 'test') return this.skip();

		for (const maxAge of ['not-a-number', 0, -3600, null]) {
			const reply = await rawInviteRequest(pageA, 'createInvite', { maxAge, permissions: 'r' });
			assert.isUndefined(reply.error,
				'createInvite with maxAge ' + JSON.stringify(maxAge) + ' failed: ' + reply.error);
			assert.isNotNull(reply.reply.expiresAt,
				'maxAge ' + JSON.stringify(maxAge) + ' produced no expiry');
			assert.closeTo(new Date(reply.reply.expiresAt).getTime(),
				Date.now() + 7 * 24 * 3600 * 1000, 60 * 1000,
				'maxAge ' + JSON.stringify(maxAge) + ' should fall back to the one-week default');
		}
	});

	it('maxAge above the one-month limit is clamped to it', async function () {
		if (config.authType !== 'test') return this.skip();

		const reply = await rawInviteRequest(pageA, 'createInvite', { maxAge: 3600 * 24 * 365, permissions: 'r' });

		assert.isUndefined(reply.error, 'createInvite with a years-long maxAge failed: ' + reply.error);
		assert.closeTo(new Date(reply.reply.expiresAt).getTime(),
			Date.now() + 30 * 24 * 3600 * 1000, 60 * 1000,
			'a years-long maxAge should be clamped to the one-month limit');
	});
});
