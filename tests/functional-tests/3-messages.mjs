// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { MongoClient } from 'mongodb';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Messages', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const otherWebstrateId = 'test-' + util.randomString();
	const urlA = config.server_address + webstrateId;
	const urlB = config.server_address + otherWebstrateId;
	let userId;

	const messageValue1 = util.randomString();
	const messageValue2 = util.randomString();

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

		let userObject = await pageA.evaluate(() => window.webstrate.user);
		userId = userObject.username +":" + config.authType;
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

	// A websocket message naming a webstrate the socket never joined (and holds no
	// access token for) used to crash the server middleware with an unhandled TypeError,
	// silently dropping the message, so the sender never got a reply. The server should
	// instead reply with a proper error.
	it('should get an error reply when sending a message naming a webstrate the socket never joined',
		async function() {
			// Send a document fetch over a raw websocket connected to webstrateId, naming
			// otherWebstrateId which the socket never joins (subscribes to).
			const reply = await pageC.evaluate((wsUrl, otherWebstrateId) => new Promise((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => resolve(undefined), 2000);
				ws.onopen = () => ws.send(JSON.stringify({ a: 'f', c: 'webstrates', d: otherWebstrateId }));
				ws.onmessage = (event) => {
					const msg = JSON.parse(event.data);
					if (msg.d === otherWebstrateId) {
						clearTimeout(timeout);
						ws.close();
						resolve(msg);
					}
				};
				ws.onerror = () => resolve(undefined);
			}), urlA.replace('http', 'ws') + '/', otherWebstrateId);

			assert.isObject(reply, 'message was silently dropped, no reply ever arrived');
			assert.isOk(reply.error, 'cross-document message should be rejected with an error');
		});

});

describe('Messages', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const otherWebstrateId = 'test-' + util.randomString();
	const floodWebstrateId = 'test-' + util.randomString();
	const restrictedWebstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	const otherUrl = config.server_address + otherWebstrateId;
	const floodUrl = config.server_address + floodWebstrateId;
	const restrictedUrl = config.server_address + restrictedWebstrateId;

	const userId = 'testuser:' + config.authType;
	const intruderId = 'intruder:' + config.authType;
	const floodUserId = 'flooduser:' + config.authType;

	// The marker messages are unique per run, so only this suite's own messages are counted.
	const legitMarker = 'legit-' + util.randomString();
	const anonymousMarker = 'anonymous-' + util.randomString();
	const noReadMarker = 'no-read-' + util.randomString();
	const crossMarker = 'cross-' + util.randomString();

	const messageRateLimit = config.server.messageRateLimit;

	let browserA, browserB, browserC, pageA, pageD, pageE;
	const sockets = [];

	// Send a webstrates action on a raw websocket opened from within the page, carrying the
	// page's login session. The server accepts websocket connections without any permission
	// check, which is exactly the surface the pre-fix sendMessage handler was exposed on.
	const sendOnRawSocket = (page, webstrateId, action) => page.evaluate((id, action) => {
		const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
		socket.onopen = () => socket.send(JSON.stringify(action));
		socket.onerror = () => {};
		setTimeout(() => socket.close(), 2000);
	}, webstrateId, action);

	// Send a webstrates action on a raw websocket from the test process, i.e. anonymously (no
	// session cookies).
	const sendAnonymously = (webstrateId, action) => new Promise((resolve, reject) => {
		const socket = new WebSocket(config.server_address.replace(/^http/, 'ws') + webstrateId);
		sockets.push(socket);
		socket.on('error', reject);
		socket.on('open', () => {
			socket.send(JSON.stringify(action));
			setTimeout(resolve, 200);
		});
	});

	// Whether a message with the given value arrives on the page within the timeout (default
	// 0.5s). Returns false if it never does, which is what the rejection tests assert.
	const messageArrived = (page, message, timeout = .5) =>
		util.waitForFunction(page, message =>
			window.webstrate.messages.some(m => m.message === message), timeout, message);

	// Whether an async predicate turns true within the given number of seconds.
	const eventually = async (seconds, predicate) => {
		const endAt = Date.now() + seconds * 1000;
		do {
			await util.sleep(2);
			if (await predicate()) return true;
		} while (Date.now() < endAt);
		return false;
	};

	before(async function() {
		if (config.authType !== 'test') {
			return this.skip();
		}

		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();
		browserC = await puppeteer.launch();

		// pageA: testuser, observing its own inbox. pageD: intruder, a second account.
		// pageE: flooduser, the sender for the rate limit test.
		pageA = await browserA.newPage();
		await util.logInToTest(pageA, 'testuser');
		pageD = await browserB.newPage();
		await util.logInToTest(pageD, 'intruder');
		pageE = await browserC.newPage();
		await util.logInToTest(pageE, 'flooduser');

		await Promise.all([
			(pageA.goto(url, { waitUntil: 'networkidle2' })),
			(pageD.goto(otherUrl, { waitUntil: 'networkidle2' })),
			(pageE.goto(floodUrl, { waitUntil: 'networkidle2' }))
		]);

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageD, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageE, () => window.webstrate && window.webstrate.loaded)
		]);

		// Create a webstrate that only testuser has access to.
		await pageA.goto(restrictedUrl, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		const version = await pageA.evaluate(() => window.webstrate.version);
		await pageA.evaluate(() => {
			document.documentElement.setAttribute('data-auth', JSON.stringify([{
				username: window.webstrate.user.username,
				provider: window.webstrate.user.provider,
				permissions: 'rw'
			}]));
		});
		await util.waitForFunction(pageA, v => window.webstrate.version > v, 5, version);
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
	});

	after(async function() {
		if (config.authType !== 'test') {
			return util.warn('Skipping messages security tests as they need the test auth ' +
				'provider (multiple accounts).');
		}

		sockets.forEach(socket => socket.close());

		// Deletes have to be sequential per page, so delete testuser's two webstrates one
		// after the other.
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await pageA.goto(restrictedUrl + '?delete', { waitUntil: 'domcontentloaded' });

		await Promise.all([
			pageD.goto(otherUrl + '?delete', { waitUntil: 'domcontentloaded' }),
			pageE.goto(floodUrl + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await Promise.all([
			browserA.close(),
			browserB.close(),
			browserC.close()
		]);

		if (!messageRateLimit) {
			util.warn('Skipping the message rate limit test as no messageRateLimit block is ' +
				'configured for the server.');
		}
	});

	// Sending from a webstrate the sender can read must still work (here to the sender
	// themself, an obviously entitled recipient).
	it('should deliver messages sent from a readable webstrate', async function() {
		await sendOnRawSocket(pageA, restrictedWebstrateId,
			{ wa: 'sendMessage', m: legitMarker, recipients: userId });

		assert.isTrue(await messageArrived(pageA, legitMarker, 5),
			'message to a user with access should be delivered');
	});

	it('should not deliver messages from anonymous clients', async function() {
		// Anonymous has read access to webstrateId (default permissions), so it is the missing
		// authentication, not the missing document access, that must stop this message.
		await sendAnonymously(webstrateId,
			{ wa: 'sendMessage', m: anonymousMarker, recipients: userId });

		assert.isFalse(await messageArrived(pageA, anonymousMarker),
			'message from anonymous client should not be delivered');
	});

	it('should not deliver messages from users without read permission', async function() {
		// intruder has no access at all to the restricted webstrate.
		await sendOnRawSocket(pageD, restrictedWebstrateId,
			{ wa: 'sendMessage', m: noReadMarker, recipients: userId });

		assert.isFalse(await messageArrived(pageA, noReadMarker),
			'message from a user without read permission should not be delivered');
	});

	it('should deliver messages to recipients regardless of webstrate access', async function() {
		// Messaging crosses webstrates: intruder has no access to the restricted webstrate, but
		// testuser may still message them through it.
		await sendOnRawSocket(pageA, restrictedWebstrateId,
			{ wa: 'sendMessage', m: crossMarker, recipients: intruderId });

		assert.isTrue(await messageArrived(pageD, crossMarker, 5),
			'message should cross webstrates to any recipient');
	});

	it('should rate limit sendMessage per sender', async function() {
		// A limit too high to flood within one interval can't be tested here, and a burst
		// spanning more than one interval can't be counted on precisely.
		if (!messageRateLimit || !Number.isFinite(messageRateLimit.messagesPerInterval)
			|| !Number.isFinite(messageRateLimit.intervalLength)
			|| messageRateLimit.intervalLength < 5000) {
			return this.skip();
		}

		const limit = messageRateLimit.messagesPerInterval;
		// The flood marker is unique per run: delivered messages are persisted to the
		// recipient's inbox for 30 days, so a reused prefix would count earlier runs' floods.
		const floodPrefix = 'flood-' + util.randomString() + '-';
		// Send three times the limit in one fast burst. Wherever the interval boundary falls,
		// at most two intervals can contribute, so at most 2 * limit messages are delivered —
		// and the first `limit` always are.
		await pageE.evaluate((id, recipient, count, prefix) => {
			const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
			socket.onopen = () => {
				for (let i = 0; i < count; i++) {
					socket.send(JSON.stringify(
						{ wa: 'sendMessage', m: prefix + i, recipients: recipient }));
				}
			};
			socket.onerror = () => {};
			setTimeout(() => socket.close(), 5000);
		}, floodWebstrateId, floodUserId, 3 * limit, floodPrefix);

		assert.isTrue(await util.waitForFunction(pageE, (prefix, count) =>
			window.webstrate.messages.filter(m => m.message &&
				m.message.startsWith(prefix)).length >= count, 10, floodPrefix, limit),
		'messages up to the limit should be delivered');

		await util.sleep(1);

		const delivered = await pageE.evaluate(prefix =>
			window.webstrate.messages.filter(m => m.message && m.message.startsWith(prefix)).length,
		floodPrefix);

		assert.isAtLeast(delivered, limit, 'messages up to the rate limit are delivered');
		assert.isAtMost(delivered, 2 * limit, 'messages beyond the rate limit are dropped');
	});

	it('should expire messages through a TTL index', async function() {
		this.timeout(200000);

		const client = new MongoClient(config.server.db);
		await client.connect();
		const messages = client.db().collection('messages');
		try {
			// A TTL index is single-field with expireAfterSeconds as an option. Pre-fix
			// releases misplaced expireAfterSeconds into the key spec, creating a plain
			// compound index, so nothing ever expired.
			const ttlIndexes = (await messages.indexes()).filter(index => index.expireAfterSeconds);
			const messageTtl = ttlIndexes.find(index =>
				JSON.stringify(index.key) === JSON.stringify({ createdAt: 1 }));
			assert.exists(messageTtl, 'messages has a TTL index on createdAt');
			assert.strictEqual(messageTtl.expireAfterSeconds, 60 * 60 * 24 * 30,
				'messages expire after 30 days');
			assert.isUndefined(ttlIndexes.find(index => 'expireAfterSeconds' in index.key),
				'no pre-fix compound index with expireAfterSeconds as a key remains');

			// MongoDB's TTL monitor (runs about once a minute) should delete a 31-day-old
			// message, but keep a fresh one.
			const staleMarker = 'stale-' + util.randomString();
			const freshMarker = 'fresh-' + util.randomString();
			await messages.insertMany([
				{ userId: 'ttl-probe:' + config.authType, messageId: staleMarker,
					message: staleMarker, senderId: userId,
					createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
				{ userId: 'ttl-probe:' + config.authType, messageId: freshMarker,
					message: freshMarker, senderId: userId, createdAt: new Date() }
			]);

			assert.isTrue(await eventually(170, async () =>
				await messages.countDocuments({ messageId: staleMarker }) === 0),
			'31-day-old message should be deleted by the TTL monitor');
			assert.equal(await messages.countDocuments({ messageId: freshMarker }), 1,
				'fresh message should survive');
		} finally {
			await client.close();
		}
	});

	it('should carry a TTL index on sessions', async function() {
		const client = new MongoClient(config.server.db);
		await client.connect();
		try {
			const sessions = client.db().collection('sessions');
			const ttlIndex = (await sessions.indexes()).find(index =>
				JSON.stringify(index.key) === JSON.stringify({ createdAt: 1 }));
			assert.exists(ttlIndex, 'sessions has a TTL index on createdAt');
			assert.strictEqual(ttlIndex.expireAfterSeconds, 60 * 60 * 24 * 365,
				'sessions expire 365 days after the last login');
		} finally {
			await client.close();
		}
	});

});