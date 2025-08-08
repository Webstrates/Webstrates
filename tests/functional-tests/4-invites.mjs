// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Invites', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browserA, browserB, pageA, pageB;

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
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded),
		]);
	});

	after(async () => {
		if (!util.credentialsProvided) {
			util.warn('Skipping most permission tests as no GitHub credentials were provided.');
			return;
		}

		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' }),

		await Promise.all([
			browserA.close(),
			browserB.close()
		]);
	});

	it('Invite API should be available for logged-in users only', async function() {
		if (!util.credentialsProvided) return this.skip();

		let a = await pageA.evaluate(() => {return webstrate.user.invites});
		let b = await pageB.evaluate(() => {return webstrate.user.invites});

		assert.equal(b, undefined, "Invites should not be defined for anonymous users");
		assert.notEqual(b, undefined, "Invites are not available for a logged-in user");
	});

	let currentInvitation;
	it('Creating an invitation with a time limit of 2 seconds should be available immediately: invites.create', async function() {
		if (!util.credentialsProvided) return this.skip();

		currentInvitation = await pageA.evaluate(async () => {return await window.webstrate.invites.create({
			permissions: "r",
			maxAge: "2"
		})});

		assert.exists(currentInvitation, "No invitation generated");
		assert.exists(currentInvitation.key, "Invitation is missin a key");
	});

	it('Valid invitation should be in list of currently active invitations: invites.get()', async function() {
		if (!util.credentialsProvided) return this.skip();
		const invitations = await pageA.evaluate(() => window.webstrate.user.invitations.get());

		assert.exists(invitations.find(m=>m.key===currentInvitation.key), "Invitation not in invites.get() list");
	});

	it('Valid invitation should be pass validity check and return data: invites.check()', async function() {
		if (!util.credentialsProvided) return this.skip();
		const checkedInvitation = await pageA.evaluate(() => window.webstrate.user.invitations.check(a), currentInvitation.key);

		assert.exists(checkedInvitation, "A valid invitation did not pass check(...)");
	});

	it('Valid invitation should be in list of currently active invitations for creator: invites.get()', async function() {
		if (!util.credentialsProvided) return this.skip();
		const invitations = await pageA.evaluate(() => window.webstrate.user.invitations.get());

		assert.exists(invitations.find(m=>m.key===currentInvitation.key), "Invitation not in invites.get() list");
	});

	it('Expired invitation should not be in list of currently active invitations: invites.get()', async function() {
		if (!util.credentialsProvided) return this.skip();

		// Expire the invitation and try again
		await new Promise((resolve)=>{setTimeout(resolve, 2000)});		
		const invitations = await pageA.evaluate(() => window.webstrate.user.invitations.get());

		assert.notExists(invitations.find(m=>m.key===currentInvitation.key), "Invitation expired but still in invites.get() list");
	});

	it('Expired invitation should be fail validity check: invites.check()', async function() {
		if (!util.credentialsProvided) return this.skip();
		const checkedInvitation = await pageA.evaluate(() => window.webstrate.user.invitations.check(a), currentInvitation.key);

		assert.notExists(checkedInvitation, "An expired invitation still got validated by check(...)");
	});

	// TODO: Accepting an invitation correctly merges permissions with existing ones
	// TODO: An invite sent by a user which now has lost admin permission becomes invalid

});
