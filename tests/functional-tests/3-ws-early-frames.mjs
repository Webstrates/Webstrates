/* global describe before after it */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Early websocket frames', function() {
	this.timeout(60000);

	const webstrateId = 'test-' + util.randomString();

	// This suite's own fresh server instance (under the test runner): the first
	// cookie-authenticated connections after a cold boot pay the slowest session
	// deserialization, which is exactly the window a first frame can lose the race
	// against. A long-warm server tends to win against the localhost round trip.
	let ownServer = null;
	const baseServerAddress = config.server_address;

	before(async function() {
		if (process.env.WEBSTRATES_HARNESS_STATE) {
			const harness = await import('../lib/server-harness.mjs');
			ownServer = await harness.startServer({ label: 'earlyframes' });
			config.server_address = ownServer.address;
		}
	});

	after(async function() {
		if (ownServer) {
			await ownServer.stop();
			config.server_address = baseServerAddress;
		}
	});

	// Anonymous connections carry no session cookie, so their middleware chain runs
	// synchronously and never had the race — but they exercise the same connection
	// setup, and an immediate first frame must keep being processed.
	it('should process a first frame sent immediately on an anonymous connection', async function() {
		const reply = await new Promise((resolve) => {
			const socket = new WebSocket(config.server_address.replace(/^http/, 'ws') + webstrateId);
			const timeout = setTimeout(() => resolve(undefined), 5000);
			socket.on('error', () => {
				clearTimeout(timeout);
				resolve(undefined);
			});
			socket.on('open', () => socket.send(JSON.stringify({ a: 'hs' })));
			socket.on('message', (data) => {
				const reply = JSON.parse(data);
				if (reply.a === 'hs') {
					clearTimeout(timeout);
					socket.close();
					resolve(reply);
				}
			});
		});

		assert.isObject(reply, 'no reply: the first frame appears to have been dropped');
		assert.propertyVal(reply, 'a', 'hs', 'the reply should be the ShareDB handshake');
	});

	// The authenticated connections carry a session cookie, so the server must
	// deserialize the session (an async database query) before the app.ws() handler can
	// process anything. A frame sent the instant the connection is open lands in exactly
	// that window: before the fix it was silently dropped and no reply ever came.
	// Several connections are opened at once — their session deserializations contend,
	// widening the window — and every one of them must get its frames processed, in the
	// order they were sent (handshake, then a fetch).
	it('should process first frames sent immediately on authenticated connections', async function() {
		if (config.authType !== 'test') {
			this.skip();
		}

		const browser = await puppeteer.launch();
		try {
			const page = await browser.newPage();
			await util.logInToTest(page, 'testuser');

			const replies = await page.evaluate((wsUrl, docId) => new Promise((resolve) => {
				const sockets = [];
				const results = [];
				let done = 0;
				for (let i = 0; i < 5; i++) {
					const socket = new WebSocket(wsUrl);
					const mine = [];
					results.push(mine);
					sockets.push(socket);
					socket.onopen = () => {
						// Both frames go out immediately, in one burst: no settling delay.
						socket.send(JSON.stringify({ a: 'hs' }));
						socket.send(JSON.stringify({ a: 'f', c: 'webstrates', d: docId }));
					};
					socket.onmessage = (event) => {
						const reply = JSON.parse(event.data);
						if (reply.a === 'hs' || reply.a === 'f') {
							mine.push(reply.a);
							if (mine.length === 2) {
								socket.close();
								if (++done === sockets.length) resolve(results);
							}
						}
					};
					socket.onerror = () => {};
				}
				// Resolve whatever came back after a grace period; the assertions below
				// say precisely what should have arrived.
				setTimeout(() => resolve(results), 5000);
			}), config.server_address.replace(/^http/, 'ws') + webstrateId + '/', webstrateId);

			replies.forEach((mine, i) => {
				assert.deepEqual(mine, ['hs', 'f'],
					`connection ${i} must process both first frames, in the order they were sent`);
			});
		} finally {
			await browser.close();
		}
	});
});
