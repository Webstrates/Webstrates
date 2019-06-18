// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Messages', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const otherWebstrateId = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateId;
	const urlB = config.server_address + otherWebstrateId;
	const userId = config.username + ':github';

	const messageValue1 = util.randomString();
	const messageValue2 = util.randomString();

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
			pageB.goto(urlB, { waitUntil: 'networkidle2' }),
			pageC.goto(urlB, { waitUntil: 'networkidle2' })
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
			util.warn('Skipping most messages tests as no GitHub credentials were provided.');
		}
	});

	// pageA and pageB: same browser, same page, logged in.
	it('message object should exist on logged in clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messageObjectsExistsA = await util.waitForFunction(pageA, () =>
			Array.isArray(window.webstrate.messages) && typeof window.webstrate.message === 'function');

		const messageObjectsExistsB = await util.waitForFunction(pageB, () =>
			Array.isArray(window.webstrate.messages) && typeof window.webstrate.message === 'function');

		assert.isTrue(messageObjectsExistsA);
		assert.isTrue(messageObjectsExistsB);
	});

	// pageC: another browser, same page, not logged in.
	it('message object should not exist on not-logged in clients', async function() {
		const messageObjectsExistsC = await util.waitForFunction(pageC, () =>
			typeof window.webstrate.messages !== 'undefined' &&
			typeof window.webstrate.message !== 'undefined',
		.1 /* 100 ms. There shouldn't be any reason to wait all, but let's be safe. */);
		assert.isFalse(messageObjectsExistsC);
	});

	// pageA sends message to itself, verifies the message's existence and contents and sender.
	it('should be able to send and receive message from logged-in client to itself using clientId',
		async function() {

			if (!util.credentialsProvided) {
				return this.skip();
			}

			await pageA.evaluate(messageValue1 =>
				window.webstrate.message(messageValue1, window.webstrate.clientId),
			messageValue1);

			const messageExists = await util.waitForFunction(pageA, messageValue1 =>
				window.webstrate.messages.some(message => message.message === messageValue1),
			undefined, messageValue1);

			assert.isTrue(messageExists);

			const message = await pageA.evaluate(messageValue1 =>
				window.webstrate.messages.find(message => message.message === messageValue1),
			messageValue1);

			assert.propertyVal(message, 'message', messageValue1);
			assert.propertyVal(message, 'senderId', userId);
		});

	// pageB verifies its ability to receive message sent from pageA to itself. pageA and pageB are
	// logged in as the same user, so both should receive the message, even though it was addressed to
	// a clientId (e.g. "HJz8bmVbf"), not a userId (e.g. "kbadk:github").
	it('should be able to receive message from other client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messageExists = await util.waitForFunction(pageB, messageValue1 =>
			window.webstrate.messages.some(message => message.message === messageValue1),
		undefined, messageValue1);

		assert.isTrue(messageExists);

		const message = await pageB.evaluate(messageValue1 =>
			window.webstrate.messages.find(message => message.message === messageValue1),
		messageValue1);

		assert.propertyVal(message, 'message', messageValue1);
		assert.propertyVal(message, 'senderId', userId);
	});

	// pageC verifies that it has not received the message sent from pageA. pageC is not logged in as
	// the same user as pageA/pageB and thus shouldn't receive anything. In fact, pageC isn't logged
	// in at all.
	it('should not be able to receive message from not-logged in client', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messageExists = await util.waitForFunction(pageC, messageValue1 =>
			window.webstrate.messages && window.webstrate.messages.some(message =>
				message.message === messageValue1),
		undefined, messageValue1);

		assert.isFalse(messageExists);
	});

	// Even though pageC's messageReceived event listener can never get triggered -- because you can't
	// send messages to a not-logged in client --  we still allow the listener to get added to make
	// the API easier to use.
	it('should be able to set messageReceived event listener on all clients', async function() {
		await Promise.all([pageA.evaluate(() => {
			window.__test_messageReceived = false;
			window.webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		}),
		pageB.evaluate(() => {
			window.__test_messageReceived = false;
			window.webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		}),
		pageC.evaluate(() => {
			window.__test_messageReceived = false;
			window.webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		})]);
	});

	// Not-logged in clients can't receive messages, so the event should never trigger.
	it('sending message should trigger messageReceived event listener on logged in clients only',
		async function() {

			if (!util.credentialsProvided) {
				return this.skip();
			}

			await pageA.evaluate(messageValue2 =>
				window.webstrate.message(messageValue2, window.webstrate.user.userId),
			messageValue2);

			const messageReceivedTriggeredA = await util.waitForFunction(pageA, () =>
				window.__test_messageReceived);
			const messageReceivedTriggeredB = await util.waitForFunction(pageB, () =>
				window.__test_messageReceived);
			const messageReceivedTriggeredC = await util.waitForFunction(pageC, () =>
				window.__test_messageReceived,
			.1 /* 100 ms. There shouldn't be any reason to wait all, but let's be safe. */);

			assert.isTrue(messageReceivedTriggeredA);
			assert.isTrue(messageReceivedTriggeredB);
			assert.isFalse(messageReceivedTriggeredC);
		});

	// Well, duh.
	it('messageReceived should trigger with correct values on logged-in clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messageA = await pageA.evaluate(() => window.__test_messageReceived);
		const messageB = await pageB.evaluate(() => window.__test_messageReceived);

		assert.equal(messageValue2, messageA);
		assert.equal(messageValue2, messageB);
	});

	let message1, message2;
	// Make sure the messages are also what we expect on pageB (could be pageA as well).
	it('messages should exist in window.webstrate.messages', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messages = await pageB.evaluate(() => window.webstrate.messages);

		message1 = messages.find(message => message.message === messageValue1);
		message2 = messages.find(message => message.message === messageValue2);

		assert.exists(message1);
		assert.exists(message2);
	});

	// The messages list should be identical on pageA and pageB as they are logged into the same
	// GitHub account and therefore share userId.
	it('window.webstrate.messages should be identical on clients logged in to same account',
		async function() {

			if (!util.credentialsProvided) {
				return this.skip();
			}

			const messagesA = await pageA.evaluate(() => window.webstrate.messages);
			const messagesB = await pageB.evaluate(() => window.webstrate.messages);

			assert.deepEqual(messagesA, messagesB);
		});

	// Deleting a message on pageA should be reflected on pageB.
	it('should be possible delete message by messageId', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await pageA.evaluate(messageId1 =>
			window.webstrate.deleteMessage(messageId1), message1.messageId);

		const messageId1DeletedA = await util.waitForFunction(pageA, messageId1 =>
			window.webstrate.messages.every(message => message.messageId !== messageId1),
		undefined, message1.messageId);
		const messageId1DeletedB = await util.waitForFunction(pageB, messageId1 =>
			window.webstrate.messages.every(message => message.messageId !== messageId1),
		undefined, message1.messageId);

		assert.isTrue(messageId1DeletedA, 'deleted on page A');
		assert.isTrue(messageId1DeletedB, 'deleted on page B');
	});

	// Verify messages on pageA and pageB match. This test is somewhat redundant before we have the
	// one above, but let's just be sure that we didn't accidentally delete all messages on pageB or
	// something.
	it('webstrate.messages should still be identical on logged-in clients after messagedeletion',
		async function() {

			if (!util.credentialsProvided) {
				return this.skip();
			}

			const messagesA = await pageA.evaluate(() => window.webstrate.messages);
			const messagesB = await pageB.evaluate(() => window.webstrate.messages);

			assert.deepEqual(messagesA, messagesB);
		});

	// Even though pageC's messageDeleted event listener can never get triggered -- because you can't
	// send messages to a not-logged in client --  we still allow the listener to get added to make
	// the API easier to use.
	it('should be able to set messageDeleted event listener on all clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		await Promise.all([pageA.evaluate(() => {
			window.__test_messageDeleted = false;
			window.webstrate.on('messageDeleted', messageId => window.__test_messageDeleted = messageId);
		}),
		pageB.evaluate(() => {
			window.__test_messageDeleted = false;
			window.webstrate.on('messageDeleted', messageId =>  window.__test_messageDeleted = messageId);
		}),
		pageC.evaluate(() => {
			window.__test_messageDeleted = false;
			window.webstrate.on('messageDeleted', messageId =>  window.__test_messageDeleted = messageId);
		})]);
	});

	// Not-logged in clients can't receive messages, so there can't be anything to delete, thus the
	// deletion event should never trigger. Furthermore, the event certainly shouldn't trigger when
	// messages are deleted on an unrelated client.
	it('deleting message should trigger messageDeleted event listener on logged in clients only',
		async function() {
			if (!util.credentialsProvided) {
				return this.skip();
			}

			await pageB.evaluate(messageId2 =>
				window.webstrate.deleteMessage(messageId2), message2.messageId);

			const messageDeletedTriggeredA = await util.waitForFunction(pageA, () =>
				window.__test_messageDeleted);
			const messageDeletedTriggeredB = await util.waitForFunction(pageB, () =>
				window.__test_messageDeleted);
			const messageDeletedTriggeredC = await util.waitForFunction(pageC, () =>
				window.__test_messageDeleted,
			.1 /* 100 ms. There shouldn't be any reason to wait all, but let's be safe. */);

			assert.isTrue(messageDeletedTriggeredA, 'triggered on page A');
			assert.isTrue(messageDeletedTriggeredB, 'triggered on page B');
			assert.isFalse(messageDeletedTriggeredC, 'not triggered on page C');
		});

	// Duh.
	it('messageReceived should trigger with correct values on logged-in clients', async function() {
		if (!util.credentialsProvided) {
			return this.skip();
		}

		const messageId2A = await pageA.evaluate(() => window.__test_messageDeleted);
		const messageId2B = await pageB.evaluate(() => window.__test_messageDeleted);

		assert.equal(message2.messageId, messageId2A);
		assert.equal(message2.messageId, messageId2B);
	});

});