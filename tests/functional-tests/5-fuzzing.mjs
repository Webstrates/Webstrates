/* global describe after it */

import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// ShareDB validates the collection field `c` of an incoming message only when
// the field is present, so document actions that must name a collection — a
// subscribe {a:'s', d:<id>} without `c` — used to pass right through to the
// backend. The backend computes its pubsub channel from the collection
// ("undefined.<id>"), and the database lookup on that channel dies reading
// properties of undefined, taking the entire server process with it: any
// unauthenticated client could kill the server with one tiny message.
describe('Fuzzing', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const sockets = [];
	let ownServer;
	let serverAddress;

	before(async function() {
		if (process.env.WEBSTRATES_HARNESS_STATE) {
			const harness = await import('../lib/server-harness.mjs');
			ownServer = await harness.startServer({ label: 'fuzzing' });
			serverAddress = ownServer.address;
		} else {
			serverAddress = config.server_address;
		}
	});

	after(async function() {
		sockets.forEach(({ ws }) => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
		if (ownServer) await ownServer.stop();
	});

	// Open a websocket to the webstrate and buffer its messages.
	const connect = () => new Promise((resolve, reject) => {
		const ws = new WebSocket(serverAddress.replace(/^http/, 'ws') + webstrateId);
		const socket = { ws, messages: [] };
		ws.on('close', closeCode => { socket.closeCode = closeCode; });
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

	it('replies with an error to a document action that names no collection', async function() {
		const socket = await connect();

		// A subscribe without its collection field. Both a first and a repeated
		// collectionless subscribe could be process-killing, so send
		// the message twice and expect an error reply each time.
		send(socket, { a: 's', d: webstrateId });
		const first = await nextMessage(socket, message =>
			message.a === 's' && message.d === webstrateId);
		assert.isOk(first.error, 'the collectionless subscribe should be rejected with an error');

		send(socket, { a: 's', d: webstrateId });
		const second = await nextMessage(socket, message =>
			message.a === 's' && message.d === webstrateId);
		assert.isOk(second.error, 'the repeated collectionless subscribe should be rejected, too');
	});

	it('keeps serving well-formed clients afterwards', async function() {
		// On unfixed code the process died on the first message above.
		if (ownServer) {
			assert.isNull(ownServer.child.exitCode, 'the server process should still be running');
		}

		// A well-formed subscribe (with a collection) still gets its normal reply.
		const socket = await connect();
		send(socket, { a: 's', c: 'webstrates', d: webstrateId });
		const reply = await nextMessage(socket, message =>
			message.a === 's' && message.d === webstrateId);
		assert.isNotOk(reply.error, 'a well-formed subscribe should still be served');
	});
});
