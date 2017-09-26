const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Messages', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const otherWebstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	const otherUrl = config.server_address + otherWebstrateId;
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

		await util.logInToGithub(pageA);
		await Promise.all([
			pageA.goto(url, { waitUntil: 'networkidle' }),
			pageB.goto(otherUrl, { waitUntil: 'networkidle' }),
			pageC.goto(otherUrl, { waitUntil: 'networkidle' })
		]);

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageC, () => window.webstrate && window.webstrate.loaded)
		]);

	});

	after(async () => {
		await Promise.all([ browserA.close(), browserB.close() ]);
	});

	// pageA and pageB: same browser, same page, logged in.
	it('message object should exist on logged in clients', async () => {
		const messageObjectsExistsA = await util.waitForFunction(pageA, () =>
			Array.isArray(window.webstrate.messages) && typeof window.webstrate.message === 'function');

		const messageObjectsExistsB = await util.waitForFunction(pageB, () =>
			Array.isArray(window.webstrate.messages) && typeof window.webstrate.message === 'function');

		assert.isTrue(messageObjectsExistsA);
		assert.isTrue(messageObjectsExistsB);
	});

	// pageC: another browser, same page, not logged in.
	it('message object should not exist on not-logged in clients', async () => {
		const messageObjectsExistsC = await util.waitForFunction(pageC, () =>
			typeof window.webstrate.messages !== 'undefined' &&
			typeof window.webstrate.message !== 'undefined',
			.1 /* 100 ms. There shouldn't be any reason to wait all, but let's be safe. */);
		assert.isFalse(messageObjectsExistsC);
	});

	it('should be able to send and receive message from client sending message using clientId',
		async () => {
		await pageA.evaluate(messageValue1 =>
			webstrate.message(messageValue1, webstrate.clientId),
		messageValue1);

		const messageExists = await util.waitForFunction(pageA, messageValue1 =>
			webstrate.messages.some(message => message.message === messageValue1),
		undefined, messageValue1);

		assert.isTrue(messageExists);

		const message = await pageA.evaluate(messageValue1 =>
			webstrate.messages.find(message => message.message === messageValue1),
		messageValue1);

		assert.propertyVal(message, 'message', messageValue1);
		assert.propertyVal(message, 'senderId', userId);
	});

	it('should be able to receive message from other client', async () => {
		const messageExists = await util.waitForFunction(pageB, messageValue1 =>
			webstrate.messages.some(message => message.message === messageValue1),
		undefined, messageValue1);

		assert.isTrue(messageExists);

		const message = await pageB.evaluate(messageValue1 =>
			webstrate.messages.find(message => message.message === messageValue1),
		messageValue1);

		assert.propertyVal(message, 'message', messageValue1);
		assert.propertyVal(message, 'senderId', userId);
	});

	it('should not be able to receive message from not-logged in client', async () => {
		const messageExists = await util.waitForFunction(pageC, messageValue1 =>
			webstrate.messages.some(message => message.message === messageValue1),
		undefined, messageValue1);

		assert.isFalse(messageExists);
	});

	it('should be able to set messageReceied event listener on all clients', async () => {
		await Promise.all([pageA.evaluate(() => {
			window.__test_messageReceived = false;
			webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		}),
		pageB.evaluate(() => {
			window.__test_messageReceived = false;
			webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		}),
		pageC.evaluate(() => {
			window.__test_messageReceived = false;
			webstrate.on('messageReceived', message =>  window.__test_messageReceived = message);
		})]);
	});

	it('sending message should trigger messageReceived event listener on logged in clients only',
		async () => {
		await pageA.evaluate(messageValue2 =>
			webstrate.message(messageValue2, webstrate.user.userId),
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

	it('messageReceived should trigger with correct values on logged-in clients', async () => {
		const messageA = await pageA.evaluate(() => window.__test_messageReceived);
		const messageB = await pageB.evaluate(() => window.__test_messageReceived);

		assert.equal(messageValue2, messageA);
		assert.equal(messageValue2, messageB);
	});

	it('webstrate.messages should be identical on logged-in clients', async () => {
		const messagesA = await pageA.evaluate(() => webstrate.messages);
		const messagesB = await pageB.evaluate(() => webstrate.messages);

		assert.deepEqual(messagesA, messagesB);
	});

	let message1, message2;
	it('messages should exist in webstrate.messages', async () => {
		const messages = await pageB.evaluate(() => webstrate.messages);

		message1 = messages.find(message => message.message === messageValue1);
		message2 = messages.find(message => message.message === messageValue2);

		assert.exists(message1);
		assert.exists(message2);
	});

	it('can delete message by messageId', async () => {
		await pageA.evaluate(messageId1 => webstrate.deleteMessage(messageId1), message1.messageId);

		const messageId1DeletedA = await util.waitForFunction(pageA, messageId1 =>
			webstrate.messages.every(message => message.messageId !== messageId1),
		undefined, message1.messageId);
		const messageId1DeletedB = await util.waitForFunction(pageB, messageId1 =>
			webstrate.messages.every(message => message.messageId !== messageId1),
		undefined, message1.messageId);

		assert.isTrue(messageId1DeletedA, 'deleted on page A');
		assert.isTrue(messageId1DeletedB, 'deleted on page B');
	});

	it('webstrate.messages should still be identical on logged-in clients', async () => {
		const messagesA = await pageA.evaluate(() => webstrate.messages);
		const messagesB = await pageB.evaluate(() => webstrate.messages);

		assert.deepEqual(messagesA, messagesB);
	});

	it('should be able to set messageDeleted event listener on all clients', async () => {
		await Promise.all([pageA.evaluate(() => {
			window.__test_messageDeleted = false;
			webstrate.on('messageDeleted', messageId => window.__test_messageDeleted = messageId)
		}),
		pageB.evaluate(() => {
			window.__test_messageDeleted = false;
			webstrate.on('messageDeleted', messageId =>  window.__test_messageDeleted = messageId);
		}),
		pageC.evaluate(() => {
			window.__test_messageDeleted = false;
			webstrate.on('messageDeleted', messageId =>  window.__test_messageDeleted = messageId);
		})]);
	});

	it('deleting message should trigger messageDeleted event listener on logged in clients only',
		async () => {
		await pageB.evaluate(messageId2 => webstrate.deleteMessage(messageId2), message2.messageId);

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

	it('messageReceived should trigger with correct values on logged-in clients', async () => {
		const messageId2A = await pageA.evaluate(() => window.__test_messageDeleted);
		const messageId2B = await pageB.evaluate(() => window.__test_messageDeleted);

		assert.equal(message2.messageId, messageId2A);
		assert.equal(message2.messageId, messageId2B);
	});

});