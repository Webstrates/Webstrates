// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Rate limiting counts and bans per remote address, and every other test in this suite connects
// from 127.0.0.1, so the flood below presents a fake X-Forwarded-For address (the server
// resolves remoteAddress from that header first, as it does for clients behind a proxy). The
// flood thereby gets a budget and a ban of its own: it can neither spend the shared budget of
// the other test cases nor ban their address, and a still active ban from a previous run
// cannot leak in either.
describe('Rate limiting', function() {
	this.timeout(60000);

	const rateLimit = config.server.rateLimit;
	const webstrateId = 'test-' + util.randomString();
	const nodeId = 'node-' + util.randomString();
	const address = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
	const webstrateUrl = config.server_address.replace(/^http/, 'ws') + webstrateId;

	const sockets = [];

	after(async () => {
		sockets.forEach(({ ws }) => { if (ws.readyState === WebSocket.OPEN) ws.close(); });

		if (!rateLimit) {
			util.warn('Skipping rate limiting tests as no rateLimit block is configured for the ' +
				'server. See the _rateLimit example in config-sample.json.');
		}
	});

	// Open a websocket to the webstrate, presenting `address` when given.
	const connect = (presentedAddress) => new Promise((resolve, reject) => {
		const ws = new WebSocket(webstrateUrl,
			{ headers: presentedAddress ? { 'x-forwarded-for': presentedAddress } : {} });
		const socket = { ws, messages: [] };
		socket.closed = new Promise(resolveClose => ws.on('close',
			closeCode => { socket.closeCode = closeCode; resolveClose(closeCode); }));
		ws.on('message', data => socket.messages.push(JSON.parse(data)));
		ws.on('error', reject);
		ws.on('open', () => {
			ws.removeListener('error', reject);
			ws.on('error', () => {}); // after open, the close code carries the outcome
			resolve(socket);
		});
		sockets.push(socket);
	});

	const send = (socket, message) => socket.ws.send(JSON.stringify(message));

	// Wait up to `timeout` seconds for a message that matches, i.e. one the server processed.
	const nextMessage = (socket, matches, timeout = 5) => new Promise((resolve, reject) => {
		const start = socket.messages.length;
		const endAt = Date.now() + timeout * 1000;
		(function check() {
			const message = socket.messages.slice(start).find(matches);
			if (message) return resolve(message);
			if (socket.closeCode !== undefined) {
				return reject(new Error(`connection closed (${socket.closeCode}) while waiting`));
			}
			if (Date.now() > endAt) return reject(new Error('timed out waiting for a message'));
			setTimeout(check, 50);
		})();
	});

	// Resolves with the close code if the server disconnects the socket within `seconds`.
	const closedWithin = (socket, seconds) => Promise.race([
		socket.closed,
		util.sleep(seconds).then(() => { throw new Error('server did not disconnect the client'); })
	]);

	// Join the webstrate, subscribe to signals on the node and publish a signal that the server
	// echoes back: a full client → server → client round trip.
	const signalRoundTrip = async (socket, marker) => {
		send(socket, { a: 's', c: 'webstrates', d: webstrateId });
		await nextMessage(socket, message => message.a === 's');
		send(socket, { wa: 'subscribe', d: webstrateId, id: nodeId });
		send(socket, { wa: 'publish', d: webstrateId, id: nodeId, m: marker });
		return await nextMessage(socket, message =>
			message.wa === 'publish' && message.m === marker);
	};

	it('processes signals well below the limit', async function() {
		if (!rateLimit) return this.skip();

		const client = await connect(address);
		assert.equal((await signalRoundTrip(client, 'below-the-limit')).m, 'below-the-limit');
	});

	it('disconnects and bans a client flooding signals over the limit', async function() {
		if (!rateLimit) return this.skip();
		// A limit too high to flood within one interval can't be tested here.
		if (rateLimit.signalsPerInterval > 20000) return this.skip();

		const flooder = await connect(address);
		send(flooder, { a: 's', c: 'webstrates', d: webstrateId });
		await nextMessage(flooder, message => message.a === 's');
		send(flooder, { wa: 'subscribe', d: webstrateId, id: nodeId });

		// Publish until the server cuts the connection. The burst is sent in well under one
		// intervalLength and overshoots the limit up to 3x, so it crosses the limit no matter
		// where the interval boundary falls (or how many signals the tests above already spent).
		for (let i = 0; i < rateLimit.signalsPerInterval * 3
			&& flooder.ws.readyState === WebSocket.OPEN; i++) {
			send(flooder, { wa: 'publish', d: webstrateId, id: nodeId, m: i });
		}

		assert.equal(await closedWithin(flooder, 10), 1013,
			'flooder should be disconnected with close code 1013 ("try again later")');
		assert.isAbove(flooder.messages.filter(message => message.wa === 'publish').length, 0,
			'signals below the limit should have been processed (echoed) before the disconnect');
	});

	it('rejects new connections from the banned address', async function() {
		if (!rateLimit) return this.skip();

		// The connection is torn down — either right after the upgrade completes, or reset
		// before it even opens. Both prove the ban; either way nothing is processed.
		const banned = await connect(address).catch(() => null);
		if (banned) {
			await closedWithin(banned, 2);
			assert.lengthOf(banned.messages, 0, 'banned connection should not receive any messages');
		}
	});

	it('does not throttle other addresses', async function() {
		if (!rateLimit) return this.skip();

		const neighbor = await connect();
		assert.equal((await signalRoundTrip(neighbor, 'neighbor')).m, 'neighbor');
	});

	it('lifts the ban after the ban duration', async function() {
		if (!rateLimit) return this.skip();

		// The ban sweep (banDuration / 10) can pass between the ban expiring and being removed.
		await util.sleep(rateLimit.banDuration / 1000 + rateLimit.banDuration / 10000 + 1);

		const client = await connect(address);
		assert.equal((await signalRoundTrip(client, 'unbanned')).m, 'unbanned');
	});
});
