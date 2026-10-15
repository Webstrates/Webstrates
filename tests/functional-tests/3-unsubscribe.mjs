// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// The ShareDB type every webstrate document is created with: the JSON0 type the server
// itself announces on the handshake (see also client/webstrates/corePopulator.js).
const JSON0_TYPE = 'http://sharejs.org/types/JSONv0';

// An unsubscribe message, addressed in the webstrates collection (the permission
// middleware rejects any other collection). The version the client is at is optional —
// ShareDB neither needs nor echoes it.
const sendUnsubscribe = (socket, webstrateId, version) =>
	socket.send(JSON.stringify({ a: 'u', c: 'webstrates', d: webstrateId, v: version }));

describe('Websocket unsubscribe', function() {
	this.timeout(20000);

	const webstrateId = 'test-' + util.randomString();
	const restrictedWebstrateId = 'test-' + util.randomString();

	// A submitter is identified on the wire by this src, so its op acks (and the op frames
	// fanned out to subscribers) can be picked out of a socket's messages.
	const SUBMITTER_SRC = 'submitter-' + util.randomString();

	after(async () => {
		// The restricted webstrate's data-auth excludes anonymous, so it cannot be deleted
		// over HTTP; the test runner drops the whole test database after a run, and it is
		// only left behind when mocha runs directly against an external server.
		try {
			await fetch(config.server_address + webstrateId + '/?delete', { redirect: 'manual' });
		} catch (err) {
			console.error('Could not delete test webstrate', webstrateId, err.message);
		}
	});

	// Open a raw websocket against the given webstrate (an anonymous connection; the base
	// config grants anonymous 'arw', so the client may create, subscribe and submit). Every
	// parsed message is buffered on the socket, so waiting for a reply can never race the
	// socket's own 'message' events.
	const connect = async (id) => {
		const socket = new WebSocket(config.server_address.replace(/^http/, 'ws') + id);
		socket.received = [];
		socket.on('message', (data) => socket.received.push(JSON.parse(data)));
		await new Promise((resolve, reject) => {
			socket.on('error', reject);
			socket.on('open', () => resolve());
		});
		// Keep an error listener attached after the open as well, so a connection error
		// during the test does not crash the runner as an unhandled 'error' event.
		socket.on('error', () => {});
		return socket;
	};

	// Resolve with the first message satisfying the predicate: one that has already been
	// buffered, or the first to arrive within the timeout. Resolves undefined if none
	// arrives, so the assertions below can say exactly what did (not) come back.
	const waitFor = (socket, predicate, timeoutMs = 5000) => new Promise((resolve) => {
		const already = socket.received.find(predicate);
		if (already) return resolve(already);

		const listener = (data) => {
			const message = JSON.parse(data);
			if (predicate(message)) {
				clearTimeout(timer);
				socket.removeListener('message', listener);
				resolve(message);
			}
		};
		const timer = setTimeout(() => {
			socket.removeListener('message', listener);
			resolve(undefined);
		}, timeoutMs);
		socket.on('message', listener);
	});

	// Submit an op over the raw websocket and resolve with the server's ack for it.
	const submitOp = async (socket, message) => {
		socket.send(JSON.stringify(message));
		const ack = await waitFor(socket, (m) => m.a === 'op' && m.src === message.src &&
			m.seq === message.seq);
		assert.isObject(ack, `no reply to the submitted op (seq ${message.seq})`);
		assert.notProperty(ack, 'error', `the submitted op (seq ${message.seq}) was rejected`);
		return ack;
	};

	// The permission middleware used to swallow unsubscribe frames: ShareDB never saw
	// them, the server-side subscription (and with it the op stream to the
	// "unsubscribed" client) lived on until the socket closed, and the client never got
	// a reply. All three symptoms are asserted here.
	it('should stop streaming ops to a client that unsubscribes', async function() {
		const subscriber = await connect(webstrateId);
		const submitter = await connect(webstrateId);

		try {
			// The submitter creates the document (v0 -> v1), so the subscriber subscribes to
			// an existing document, like the browser client does. An op's ack echoes the
			// version the op applied on top of.
			const createAck = await submitOp(submitter, {
				a: 'op', c: 'webstrates', d: webstrateId, v: 0,
				src: SUBMITTER_SRC, seq: 1,
				create: { type: JSON0_TYPE, data: {} }
			});
			assert.propertyVal(createAck, 'v', 0);

			// The subscriber subscribes (s) and must be told the current snapshot.
			subscriber.send(JSON.stringify({ a: 's', c: 'webstrates', d: webstrateId }));
			const subscribeAck = await waitFor(subscriber, (m) => m.a === 's' && m.d === webstrateId);
			assert.isObject(subscribeAck, 'no reply to the subscribe');

			// Before unsubscribing: an op submitted by the other client must reach the
			// subscriber.
			const op1Ack = await submitOp(submitter, {
				a: 'op', c: 'webstrates', d: webstrateId, v: 1,
				src: SUBMITTER_SRC, seq: 2,
				op: [{ p: ['first'], oi: 'op' }]
			});
			assert.propertyVal(op1Ack, 'v', 1);
			const op1Delivered = await waitFor(subscriber,
				(m) => m.a === 'op' && m.src === SUBMITTER_SRC && m.seq === 2);
			assert.isObject(op1Delivered,
				'the subscribed client must receive ops submitted by another client');

			// Everything the subscriber receives from here on must have been caused by the
			// unsubscribe itself: the ShareDB reply, and nothing else.
			const receivedBeforeUnsubscribe = subscriber.received.length;
			sendUnsubscribe(subscriber, webstrateId, 2);

			const unsubscribeAck = await waitFor(subscriber,
				(m) => m.a === 'u' && m.d === webstrateId);
			assert.isObject(unsubscribeAck,
				'no reply to the unsubscribe: ShareDB never saw it, the subscription lives on');
			assert.notProperty(unsubscribeAck, 'error', 'the unsubscribe was rejected');

			// After unsubscribing: another op must still be committed (and published), but
			// it must not reach the unsubscribed client anymore.
			const op2Ack = await submitOp(submitter, {
				a: 'op', c: 'webstrates', d: webstrateId, v: 2,
				src: SUBMITTER_SRC, seq: 3,
				op: [{ p: ['second'], oi: 'op' }]
			});
			assert.propertyVal(op2Ack, 'v', 2);

			// Op delivery happens in-process, so anything on its way arrives within a
			// second.
			await util.sleep(1);

			const opFramesAfter = subscriber.received.slice(receivedBeforeUnsubscribe)
				.filter((m) => m.a === 'op');
			assert.lengthOf(opFramesAfter, 0,
				`the unsubscribed client received ${opFramesAfter.length} op frame(s) after ` +
				'unsubscribing, so its document subscription was never torn down');
		} finally {
			subscriber.close();
			submitter.close();
		}
	});

	// Unsubscribing gives up access to the document, so it must not require the permission
	// being given up: a client whose permissions were revoked (or never granted) has to be
	// able to stop the ops streaming to it, and ShareDB only tears the subscription down if
	// the frame is passed on to it.
	it('should let a client without permissions unsubscribe', async function() {
		const socket = await connect(restrictedWebstrateId);
		const creator = await connect(restrictedWebstrateId);

		try {
			// A webstrate whose data-auth does not include anonymous: this client has no
			// permissions on it at all.
			const dataAuth = JSON.stringify([
				{ username: 'someone-else', provider: '', permissions: 'rw' }
			]);
			await submitOp(creator, {
				a: 'op', c: 'webstrates', d: restrictedWebstrateId, v: 0,
				src: SUBMITTER_SRC, seq: 1,
				create: { type: JSON0_TYPE, data: ['html', { 'data-auth': dataAuth }] }
			});

			sendUnsubscribe(socket, restrictedWebstrateId);
			const reply = await waitFor(socket, (m) => m.a === 'u' && m.d === restrictedWebstrateId);
			assert.isObject(reply, 'no reply to the unsubscribe');
			assert.notProperty(reply, 'error',
				'the unsubscribe must not require the permissions it gives up');
		} finally {
			socket.close();
			creator.close();
		}
	});
});
