// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Client Events', function() {
	this.timeout(10000);
	//this.retries(3);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		// Close the observer sockets even if a test failed before its end, so a dangling
		// socket can't keep the test process alive.
		for (const socket of [observerSocket, signalObserverSocket, signalAttackerSocket]) {
			if (socket) {
				try { socket.close(); } catch { /* already closed */ }
			}
		}

		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	let firstClientId;
	it('client list should initially contain only the first client itself', async () => {
		// Wait for page to load.
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);

		firstClientId = await pageA.evaluate(() => window.webstrate.clientId);
		const clientList = await pageA.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId], clientList);
	});

	it('clientJoin event should get triggered when another client joins', async () => {
		pageA.evaluate(() => {
			window.webstrate.on('clientJoin', clientId => {
				window.__test_joiningClientId = clientId;
			});
		});

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		const clientJoined = await util.waitForFunction(pageA, () => window.__test_joiningClientId);
		assert.isTrue(clientJoined);
	});

	let secondClientId;
	it('joining clientId should match second client\'s clientId', async () => {
		const joiningClientId = await pageA.evaluate(() => window.__test_joiningClientId);

		// Wait for page to load.
		await util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded);

		secondClientId = await pageB.evaluate(() => window.webstrate.clientId);

		assert.equal(secondClientId, joiningClientId);
	});

	it('client list should contain both clients only after second client joins', async () => {
		const clientListA = await pageA.evaluate(() => window.webstrate.clients);
		const clientListB = await pageB.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId, secondClientId], clientListA);
		assert.deepEqual([firstClientId, secondClientId], clientListB);
	});

	it('clientPart event should get triggered when another client parts', async () => {
		await pageA.evaluate(() => {
			window.webstrate.on('clientPart', clientId => {
				window.__test_partingClientId = clientId;
			});
		});

		pageB.close();

		const clientParted = await util.waitForFunction(pageA, () => window.__test_partingClientId);
		assert.isTrue(clientParted);
	});

	it('parting clientId should match second client\'s clientId', async () => {
		const partingClientId = await pageA.evaluate(() => window.__test_partingClientId);
		assert.equal(secondClientId, partingClientId);
	});

	it('client list should contain only the first client\'s clientId once again', async () => {
		const clientList = await pageA.evaluate(() => window.webstrate.clients);

		assert.deepEqual([firstClientId], clientList);
	});

	let observerSocket;
	it('should not broadcast clientPart to anonymous clients in other webstrates', async () => {
		// All anonymous clients share the userId 'anonymous:', so the user-object part broadcast
		// (which carries no webstrate id) used to fan a clientPart out to every anonymous socket on
		// the server. The observer is an anonymous socket that never even joins its own webstrate,
		// so no clientPart should ever reach it.
		observerSocket = new WebSocket(config.server_address.replace(/^http/, 'ws') + webstrateId
			+ '-observer');
		const partFrames = [];
		observerSocket.on('message', data => {
			const msg = JSON.parse(data.toString());
			if (msg.wa === 'clientPart') partFrames.push(msg);
		});
		await new Promise((resolve, reject) => {
			observerSocket.on('error', reject);
			observerSocket.on('open', resolve);
		});

		const pageC = await browser.newPage();
		await pageC.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageC, () => window.webstrate && window.webstrate.loaded);
		const thirdClientId = await pageC.evaluate(() => window.webstrate.clientId);

		// Wait for pageC's join to register, so the part below is guaranteed to fire.
		await util.waitForFunction(pageA, clientId => window.webstrate.clients.includes(clientId), 3,
			thirdClientId);

		await pageA.evaluate(clientId => {
			window.webstrate.on('clientPart', partingClientId => {
				if (partingClientId === clientId) window.__test_thirdParted = true;
			});
		}, thirdClientId);

		await pageC.close();

		// Control: the same-webstrate client did get notified of the part, and the anonymous
		// fan-out (if any) is sent synchronously with that notification.
		assert.isTrue(await util.waitForFunction(pageA, () => window.__test_thirdParted));
		await util.sleep(.5);
		assert.lengthOf(partFrames, 0);

		observerSocket.close();
	});

	let signalObserverSocket, signalAttackerSocket;
	it('should not broadcast signalUserObject to anonymous clients in other webstrates', async () => {
		// The official client refuses to send the action anonymously, but a
		// raw websocket may not, hence the attacker socket below. The observer is an
		// anonymous socket in another webstrate that never even joins its own webstrate, so
		// no signalUserObject frame should ever reach it.
		const wsUrl = config.server_address.replace(/^http/, 'ws');
		const signalFrames = [];
		const openSocket = (docId) => new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl + docId);
			socket.on('error', reject);
			socket.on('open', () => resolve(socket));
		});

		// Probe a socket with a tokened fetchdoc and await the reply. A reply proves the
		// socket is registered server-side (its socketId is in the anonymous user's client
		// list): once both probes below have been answered, the observer is provably in the
		// anonymous fan-out set and the attacker's messages are provably being processed.
		const probeSocket = (socket, token) => new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('no reply to probe ' + token)), 5000);
			const onMessage = (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.wa === 'reply' && msg.token === token) {
					clearTimeout(timeout);
					socket.removeListener('message', onMessage);
					resolve(msg);
				}
			};
			socket.on('message', onMessage);
			socket.send(JSON.stringify({ wa: 'fetchdoc', d: webstrateId, token }));
		});

		signalObserverSocket = await openSocket(webstrateId + '-observer');
		signalObserverSocket.on('message', data => {
			const msg = JSON.parse(data.toString());
			if (msg.wa === 'signalUserObject') signalFrames.push(msg);
		});
		signalAttackerSocket = await openSocket(webstrateId);

		await probeSocket(signalObserverSocket, 'observer-registered');
		await probeSocket(signalAttackerSocket, 'attacker-registered');

		// An anonymous signalUserObject naming a webstrate the anonymous user can
		// read (the default permissions grant anonymous 'r').
		signalAttackerSocket.send(JSON.stringify({ wa: 'signalUserObject', d: webstrateId,
			m: { f2: 'user-object signal from an anonymous client' } }));

		// A reply to a message sent after the signal proves the signal has been processed:
		// messages on one socket are handled in order, and the broadcast (if any) goes out in
		// the same server tick as the signal's permission cache hit.
		await probeSocket(signalAttackerSocket, 'signal-processed');
		await util.sleep(.5);

		assert.lengthOf(signalFrames, 0);

		signalObserverSocket.close();
		signalAttackerSocket.close();
	});

});

describe('User Object Signaling', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const otherWebstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	const otherUrl = config.server_address + otherWebstrateId + '/';
	const signalPayload = { marker: 'user-object-signal-' + util.randomString() };

	let browser, pageA, pageB;

	before(async function() {
		// Signaling on the user object is a logged-in feature — the server rejects the
		// anonymous case (see the client events above) and the official client refuses to
		// send it anonymously — so this suite needs an account. With the test provider (the
		// harness default) logInToAuth logs in as 'testuser'.
		if (!util.credentialsProvided) {
			return this.skip();
		}

		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		await util.logInToAuth(pageA);

		// pageB is another page in the same browser, i.e. the same user connected to a
		// different webstrate.
		pageB = await browser.newPage();

		await Promise.all([
			pageA.goto(url, { waitUntil: 'networkidle2' }),
			pageB.goto(otherUrl, { waitUntil: 'networkidle2' })
		]);

		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded)
		]);
	});

	after(async function() {
		if (!browser) {
			return;
		}

		await Promise.all([pageA.setCacheEnabled(false), pageB.setCacheEnabled(false)]);
		await Promise.all([
			pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' }),
			pageB.goto(otherUrl + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await browser.close();
	});

	// The anonymous gate must not stop the feature it protects: a logged-in user's signal
	// still has to reach that user's clients — including ones in other webstrates, as the
	// user object crosses webstrates by design.
	it('signal on the user object should reach the user\'s client in another webstrate', async () => {
		await pageA.evaluate(() => {
			window.webstrate.user.on('signal', (message, senderId, senderWebstrateId) => {
				window.__test_userSignal = [message, senderId, senderWebstrateId];
			});
		});

		const senderClientId = await pageB.evaluate(() => window.webstrate.clientId);
		await pageB.evaluate(payload => window.webstrate.user.signal(payload), signalPayload);

		const signalArrived = await util.waitForFunction(pageA, () => window.__test_userSignal);
		assert.isTrue(signalArrived);

		const [message, senderId, senderWebstrateId] = await pageA.evaluate(
			() => window.__test_userSignal);

		assert.deepEqual(message, signalPayload);
		assert.equal(senderId, senderClientId);
		assert.equal(senderWebstrateId, otherWebstrateId);
	});
});