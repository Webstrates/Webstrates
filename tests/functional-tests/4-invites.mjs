// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert, expect } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe.only('Invites', function () {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browserA, browserB, pageA, pageB;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		pageA = await browserA.newPage();
		pageB = await browserB.newPage();

		console.log('Logging in testuserA...');
		await util.logInToTest(pageA, 'testuserA');
		console.log('Logged in testuserA...');

		console.log('Logging in testuserB...');
		await util.logInToTest(pageB, 'testuserB');
		console.log('Logged in testuserB...');

		await pageA.goto(url, { waitUntil: 'networkidle2' });

		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' }),

			await Promise.all([
				browserA.close(),
				browserB.close()
			]);
	});

	it('User A should be able to set permissions', async function () {
		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth',
				JSON.stringify([
					{
						username: window.webstrate.user.username,
						provider: window.webstrate.user.provider,
						permissions: 'awr'
					}
				])
			);
		});
	});

	it('User B should not have access to the webstrate', async function () {
		const result = await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(result.status(), 403);
	});

	let currentInvitation;
	it('Creating an invitation with a time limit of 2 seconds should be available immediately: invites.create', async function () {

		currentInvitation = await pageA.evaluate(async () => {
			return await window.webstrate.user.invites.create({
				permissions: 'r',
				maxAge: '2'
			});
		});

		assert.exists(currentInvitation, 'No invitation generated');
		assert.exists(currentInvitation.key, 'Invitation is missing a key');
	});

	it('Valid invitation should be in list of currently active invitations: invites.get()', async function () {
		const invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());

		assert.exists(invitations.find(m => m.key === currentInvitation.key), 'Invitation not in invites.get() list');
	});

	it('Valid invitation should be pass validity check and return data: invites.check()', async function () {
		const checkedInvitation = await pageA.evaluate((key) => window.webstrate.user.invites.check(key), currentInvitation.key, url);

		assert.exists(checkedInvitation, 'A valid invitation did not pass check(...)');
	});

	it('User B should be able to use the invitation to access the webstrate', async function () {
		await pageB.goto(config.server_address + 'frontpage', { waitUntil: 'networkidle2' });
		
		const result = await pageB.evaluate(async (key, webstrateId) => {
			return await window.webstrate.user.invites.accept(key, webstrateId);
		}, currentInvitation.key, webstrateId);
		
		assert.equal(result, 'r', 'Invitation was not accepted or returned unexpected permissions');
	});
	
	it('User B should now have access to the webstrate', async function () {
		const result = await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.equal(result.status(), 200, 'User B could not access the webstrate after accepting the invitation');
	});

	it('Expired invitation should not be in list of currently active invitations: invites.get()', async function () {

		// Expire the invitation and try again
		await new Promise((resolve) => { setTimeout(resolve, 2000) });
		const invitations = await pageA.evaluate(() => window.webstrate.user.invites.get());

		assert.notExists(invitations.find(m => m.key === currentInvitation.key), 'Invitation expired but still in invites.get() list');
	});

	it('Expired invitation should be fail validity check: invites.check()', async function () {
		let error;
		try {
			value = await pageA.evaluate((key) => window.webstrate.user.invites.check(key), currentInvitation.key);
		} catch (ex) {
			error = ex;
		}
		expect(error).to.be.an('Error');
	});
	
	

	// TODO: Accepting an invitation correctly merges permissions with existing ones
	// TODO: An invite sent by a user which now has lost admin permission becomes invalid
	// TODO: Invite API should be available for logged-in users only
});
