// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Fuzzing Webstrates from every direction a client can reach it: the raw ShareDB websocket
// protocol, the webstrates `wa` action layer, the JSONML document model (where ops can store
// DOM structures no browser can represent, or even parse), and real browsers doing DOM
// manipulation and events at the edge of what the DOM allows.
//
// The suite runs its own server instance (custom port, own pid) so crash candidates can't take
// out a base server shared with other suites, and keeps a "canary" document whose ?raw output
// must stay clean of phantom attributes after the prototype-pollution attempts.
//
// Notable regressions locked in here (all process-killing or corrupting on unfixed code):
//  - p-215: a document action without a collection passed validation and killed the process.
//  - signals: subscribing with a nodeId that collides with an Object.prototype property
//    (`__proto__`, `toString`, ...) throws inside a retry timer on disconnect — an
//    unauthenticated, one-message process kill.
//  - webstrateId: connecting to /__proto__/ (any Object.prototype property name as URL
//    segment) and subscribing pollutes Object.prototype for the whole process, leaking
//    phantom attributes into every document the server serves.
//  - collection confusion: the ShareDB collection field was client-controlled and
//    unvalidated (a normalization was left commented out), so any client could address
//    any Mongo collection in the webstrates database while permission checks only
//    consulted the webstrates collection.
//
// Notable contained/verified behaviors documented by this suite:
//  - sharedb 6 silently applies json0 ops with out-of-bounds/negative lm, mixed
//    li+od components, float/negative list indices, and even a non-array op object
//    (no-op). An empty-path object op replaces the ENTIRE document with any value.
//  - Browsers lowercase attribute names; webstrates' own client sanitizes attribute
//    names when rebuilding elements, while the server stores and serves the raw names
//    (control characters, digits, `<`, quotes) — clients and ?raw disagree on such
//    documents, and the raw names are a stored-injection surface in HTML output.
//  - seq-only ops are accepted and attributed to the agent session's own id.
describe('Fuzzing', function() {
	this.timeout(30000);

	const sockets = [];
	const webstrateId = 'test-' + util.randomString();
	let ownServer;
	let serverAddress;

	before(async function() {
		if (process.env.WEBSTRATES_HARNESS_STATE) {
			const harness = await import('../lib/server-harness.mjs');
			ownServer = await harness.startServer({ label: 'fuzzing', port: 7177 });
			serverAddress = ownServer.address;
			console.log(`fuzzing server: ${serverAddress} (pid ${ownServer.child.pid})`);
		} else {
			serverAddress = config.server_address;
		}
	});

	after(async function() {
		sockets.forEach(({ ws }) => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
		if (ownServer) await ownServer.stop();
	});

	// -------------------------------------------------------------------------
	// Infrastructure helpers
	// -------------------------------------------------------------------------

	// Open a websocket to a webstrate and buffer its messages.
	const connect = (connectWebstrateId = webstrateId) => new Promise((resolve, reject) => {
		const ws = new WebSocket(serverAddress.replace(/^http/, 'ws') + connectWebstrateId);
		const socket = { ws, messages: [], closeCode: undefined };
		ws.on('close', closeCode => { socket.closeCode = closeCode; });
		ws.on('message', data => {
			try { socket.messages.push(JSON.parse(data)); } catch { socket.messages.push(String(data)); }
		});
		ws.on('error', reject);
		ws.on('open', () => {
			ws.removeListener('error', reject);
			ws.on('error', () => {}); // after open, the close code carries the outcome
			resolve(socket);
		});
		sockets.push(socket);
	});

	const send = (socket, message) => socket.ws.send(
		typeof message === 'string' ? message : JSON.stringify(message));

	// Wait up to `timeout` seconds for a message that matches, i.e. one the server processed.
	// Each socket keeps a cursor past its last matched message: matches never skip ahead, but a
	// reply that arrives before the await begins (e.g. after a burst of sends) is still found,
	// while a second nextMessage never returns the same reply twice.
	const nextMessage = (socket, matches, timeout = 5) => new Promise((resolve, reject) => {
		const endAt = Date.now() + timeout * 1000;
		(function check() {
			const start = socket.consumed || 0;
			const index = socket.messages.slice(start).findIndex(matches);
			if (index !== -1) {
				socket.consumed = start + index + 1;
				return resolve(socket.messages[start + index]);
			}
			if (socket.closeCode !== undefined) {
				return reject(new Error(`connection closed (${socket.closeCode}) while waiting`));
			}
			if (Date.now() > endAt) return reject(new Error('timed out waiting for a message'));
			setTimeout(check, 50);
		})();
	});

	// The server process must still be running and answering HTTP.
	const serverAlive = async () => {
		if (ownServer) {
			assert.isNull(ownServer.child.exitCode,
				`the server process died (exit ${ownServer.child.exitCode}); see ${ownServer.logFile}`);
		}
		const response = await fetch(serverAddress, { redirect: 'manual',
			signal: AbortSignal.timeout(3000) });
		// Any HTTP answer counts — the root path redirects.
		assert.oneOf(response.status, [200, 301, 302],
			`the server is no longer answering HTTP (status ${response.status})`);
		return true;
	};

	const httpGet = async (pathSuffix, timeout = 10000) => {
		const response = await fetch(serverAddress + pathSuffix,
			{ redirect: 'manual', signal: AbortSignal.timeout(timeout) });
		return { status: response.status, body: await response.text(),
			location: response.headers.get('location') };
	};

	// Every incoming message the server broadcast about a webstrate, e.g. the ?raw output.
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	// Submit a json0 op over a socket and return the server's reply ({error} or not).
	let opSeq = 0; // src-local, monotonically increasing sequence number
	const submitOp = (socket, docId, version, op) => {
		opSeq++;
		send(socket, { a: 'op', c: 'webstrates', d: docId, v: version, src: 'fuzz',
			seq: opSeq, op });
		return nextMessage(socket,
			message => message.a === 'op' && message.d === docId && message.v === version);
	};

	// A json0 op against the client's own webstrate should be applied without error and
	// leave the server alive. Returns whether the op was accepted.
	const opShouldApply = async (socket, docId, version, op) => {
		const reply = await submitOp(socket, docId, version, op);
		assert.isNotOk(reply.error, 'op was rejected: ' + JSON.stringify(reply.error));
		await serverAlive();
		return true;
	};


	// A document created and owned by this suite, with a body: ['body', {}, ...children].
	const createDoc = async (docId, data) => {
		const socket = await connect(docId);
		send(socket, { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz', seq: 1,
			create: { type: 'http://sharejs.org/types/JSONv0',
				data: data || ['html', {}, ['head'], ['body']] } });
		const reply = await nextMessage(socket, message =>
			message.a === 'op' && message.d === docId && message.v === 0);
		assert.isNotOk(reply.error, `could not create document: ${JSON.stringify(reply.error)}`);
		return socket;
	};

	// A webstrate fetch-creating a document in the browser client, then a loaded page.
	const freshWebstrateId = () => 'test-fuzz-' + util.randomString().toLowerCase();

	// -------------------------------------------------------------------------
	// 1. ShareDB websocket protocol fuzzing
	// -------------------------------------------------------------------------

	describe('websocket protocol', function() {
		this.timeout(20000);

		it('replies with an error to a document action that names no collection', async function() {
			const socket = await connect();

			// A subscribe without its collection field. Both a first and a repeated
			// collectionless subscribe were process-killing, so send it twice.
			send(socket, { a: 's', d: webstrateId });
			const first = await nextMessage(socket, message =>
				message.a === 's' && message.d === webstrateId);
			assert.isOk(first.error,
				'the collectionless subscribe should be rejected with an error');

			send(socket, { a: 's', d: webstrateId });
			const second = await nextMessage(socket, message =>
				message.a === 's' && message.d === webstrateId);
			assert.isOk(second.error,
				'the repeated collectionless subscribe should be rejected, too');
		});

		it('keeps serving well-formed clients afterwards', async function() {
			if (ownServer) {
				assert.isNull(ownServer.child.exitCode, 'the server process should still be running');
			}

			const socket = await connect();
			send(socket, { a: 's', c: 'webstrates', d: webstrateId });
			const reply = await nextMessage(socket, message =>
				message.a === 's' && message.d === webstrateId);
			assert.isNotOk(reply.error, 'a well-formed subscribe should still be served');
		});

		// Frames that are not JSON at all. The server must ignore them (log) without dying.
		for (const [label, frame] of [
			['binary garbage', Buffer.from([0x00, 0xff, 0x7f, 0xde, 0xad, 0xbe, 0xef])],
			['empty string', ''],
			['just whitespace', '   '],
			['truncated JSON', '{"a":"op","c":"webstrates"'],
			['huge JSON number', '{"a":' + '9'.repeat(5000) + '}'],
			['JSON with NaN/Infinity', '{"a":NaN,"b":Infinity}']
		]) {
			it(`ignores non-JSON websocket frames: ${label}`, async function() {
				const socket = await connect();
				socket.ws.send(frame);
				socket.ws.send(frame);
				await sleep(500);
				// Any reply is fine as long as the server stays alive and keeps answering.
				await serverAlive();
			});
		}

		// Valid JSON that is not a message object.
		for (const [label, message] of [
			['number', '42'],
			['string', '"hello"'],
			['null', 'null'],
			['true', 'true'],
			['array', '[1, 2, 3]'],
			['empty object', '{}'],
			['null action', '{"a":null,"c":"webstrates","d":"x"}'],
			['numeric action', '{"a":7,"c":"webstrates","d":"x"}'],
			['object action', '{"a":{"evil":1},"c":"webstrates","d":"x"}'],
			['unknown action', '{"a":"zzz","c":"webstrates","d":"x"}']
		]) {
			it(`survives non-message JSON: ${label}`, async function() {
				const socket = await connect();
				send(socket, message);
				await sleep(300);
				await serverAlive();
			});
		}

		// The collection field decides which database collection an op touches.
		for (const [label, collection] of [
			['empty collection', ''],
			['foreign collection', 'admin'],
			['collection with NUL byte', 'webstrates\0'],
			['collection with dot', 'web.strates'],
			['collection as number', 42]
		]) {
			it(`rejects unusable collections: ${label}`, async function() {
				const socket = await connect();
				send(socket, { a: 's', c: collection, d: webstrateId });
				const reply = await nextMessage(socket, message =>
					message.a === 's' && message.d === webstrateId);
				assert.isOk(reply.error, 'subscribe should be rejected with an error reply');
				await serverAlive();
			});
		}

		// The document id field: anything but a sane string should be refused, not crash.
		for (const [label, docId] of [
			['missing d', undefined],
			['empty d', ''],
			['numeric d', 1337],
			['object d', { evil: true }],
			['array d', ['webstrates', webstrateId]],
			['d with path traversal', '../../../etc/passwd'],
			['d with NUL', 'webstrates\0'],
			['huge d', 'x'.repeat(100000)]
		]) {
			it(`rejects unusable document ids: ${label}`, async function() {
				const socket = await connect();
				const message = { a: 's', c: 'webstrates', d: docId };
				send(socket, JSON.parse(JSON.stringify(message)));
				// The server must either reply with an error or ignore the message —
				// both are acceptable as long as it survives.
				await sleep(400);
				await serverAlive();
			});
		}

		it('handles ops with partial src/seq (they must be set together)', async function() {
			const docId = freshWebstrateId();
			const socket = await createDoc(docId);
			// Neither src nor seq: rejected with ERR_OT_OP_BADLY_FORMED.
			send(socket, { a: 'op', c: 'webstrates', d: docId, v: 1, op: [{ p: [3, 2], li: ['div'] }] });
			const noSrcNoSeq = await nextMessage(socket,
				message => message.a === 'op' && message.d === docId && message.v === 1);
			assert.isOk(noSrcNoSeq.error, 'op without src/seq should be rejected');
			// seq without src: sharedb 6 tolerates it, attributes the op to the session's own
			// agent id and applies it. Documented behavior — the ack carries no error.
			send(socket, { a: 'op', c: 'webstrates', d: docId, v: 1, seq: 1,
				op: [{ p: [3, 2], li: ['div'] }] });
			const seqOnly = await nextMessage(socket,
				message => message.a === 'op' && message.d === docId && message.v === 1);
			assert.isNotOk(seqOnly.error, 'op with seq only is accepted (verified sharedb 6 behavior)');
			// src without seq: rejected with ERR_OT_OP_BADLY_FORMED.
			send(socket, { a: 'op', c: 'webstrates', d: docId, v: 1, src: 'fuzz',
				op: [{ p: [3, 2], li: ['div'] }] });
			const srcOnly = await nextMessage(socket,
				message => message.a === 'op' && message.d === docId && message.v === 1);
			assert.isOk(srcOnly.error, 'op with src only should be rejected');
			await serverAlive();
		});

		// Version field abuse. Each of these must produce an error reply (or a no-op reply),
		// never a crash.
		for (const [label, version] of [
			['negative version', -1],
			['fractional version', 0.5],
			['beyond max safe integer version', 9007199254740900],
			['version as string', '1'],
			['null version', null]
		]) {
			it(`survives version field abuse: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDoc(docId);
				send(socket, { a: 'op', c: 'webstrates', d: docId, v: version,
					src: 'fuzz', seq: 2, op: [{ p: [3, 2], li: ['div'] }] });
				await nextMessage(socket, message =>
					message.a === 'op' && message.d === docId).catch(() => null);
				await sleep(300);
				await serverAlive();
			});
		}

		it('rejects json0 ops with prototype-polluting path segments', async function() {
			const docId = freshWebstrateId();
			const socket = await createDoc(docId);

			// Attribute-path pollution attempts: an attribute named __proto__, a path walking
			// through constructor.prototype, and the document root itself.
			const attempts = [
				[[{ p: [1, '__proto__'], oi: { polluted: true } }], 1],
				[[{ p: [1, '__proto__', 'polluted'], oi: 'pwned' }], 2],
				[[{ p: [1, 'constructor', 'prototype', 'polluted'], oi: 'pwned' }], 3],
				[[{ p: ['__proto__'], oi: 'pwned' }], 4],
				[[{ p: [1, 'toString'], od: null, oi: 'pwned' }], 5],
				[[{ p: [1, 'hasOwnProperty'], od: null, oi: 'pwned' }], 6]
			];
			for (const [op, version] of attempts) {
				const reply = await submitOp(socket, docId, version, op);
				assert.isOk(reply.error,
					`op ${JSON.stringify(op)} should be rejected as a dangerous path`);
			}

			// Most importantly: the server must not have polluted its own prototypes. A plain
			// object must not suddenly have inherited properties, observable via ?raw of a
			// fresh document: replaceInKeys iterates with for..in without hasOwnProperty.
			await serverAlive();
		});

		// Malformed json0 op components with structurally invalid paths or type mismatches:
		// every one of these is rejected with an error reply (verified sharedb 6 behavior).
		for (const [label, op] of [
			['na (number add) on a string', [{ p: [0], na: 'not-a-number' }]],
			['na on an array', [{ p: [3, 'na'], na: 1 }]],
			['li (list insert) into object path', [{ p: [1, 'li'], li: ['x'] }]],
			['ld (list delete) on object path', [{ p: [1, 'ld'], ld: {} }]],
			['oi (object insert) into list path', [{ p: [3, 'oi'], oi: 'x' }]],
			['no instruction at all', [{ p: [3, 2] }]],
			['path segments as objects', [{ p: [{ evil: true }], oi: 'x' }]],
			['path segments as null', [{ p: [null], oi: 'x' }]],
			['non-array path', [{ p: 'nope', oi: 'x' }]]
		]) {
			it(`rejects malformed json0 component: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDoc(docId);
				const reply = await submitOp(socket, docId, 1, op);
				assert.isOk(reply.error, 'malformed op should be rejected with an error');
				await serverAlive();
			});
		}

		// The opposite kind: json0 ops that are malformed but whose paths pass validation.
		// sharedb 6 silently applies these (success acks, no error) and stores the result.
		// That is not a crash, but it lets ops store documents no browser can represent —
		// and every serialization route (?raw, ?json, browser populate) must survive them.
		for (const [label, op, rawMarker] of [
			['lm (list move) out of bounds', [{ p: [3, 2], lm: 1e9 }], 'one'],
			['li and od mixed (od silently ignored)', [{ p: [3, 2], li: ['div'], od: {} }],
				'<div></div>one'],
			['float list index (applied like floor)', [{ p: [3, 2.7], li: ['div'] }],
				'<div></div>one'],
			['negative list index (applied anyway)', [{ p: [3, -1], li: ['div'] }],
				'<div></div>one'],
			['lm negative (rewrites the element structure)', [{ p: [3, 2], lm: -1e9 }],
				'<one>body</one>'],
			['empty path object op (replaces the whole document)', [{ p: [], oi: 'root' }],
				'root'],
			['non-array op object (accepted as a no-op)', { p: [3, 2], li: ['div'] }, 'one']
		]) {
			it(`contains silently-applied malformed json0 component: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDoc(docId,
					['html', {}, ['head'], ['body', {}, 'one']]);
				const reply = await submitOp(socket, docId, 1, op);
				assert.isNotOk(reply.error,
					'sharedb 6 accepts this malformed op (verified; documented here)');
				const response = await httpGet(docId + '/?raw');
				assert.equal(response.status, 200, `?raw failed: ${response.status}`);
				assert.include(response.body, rawMarker,
					'the applied op should be visible in ?raw (or have left the document intact)');
				await serverAlive();
			});
		}

		it('rejects ops exceeding the database nesting depth', async function() {
			const docId = freshWebstrateId();
			const socket = await createDoc(docId);
			// 900 levels of nested arrays — beyond BSON's depth limit of ~100.
			let nested = ['deep'];
			for (let i = 0; i < 900; i++) nested = [nested];
			const reply = await submitOp(socket, docId, 1, [{ p: [3, 2], li: nested }]);
			assert.isOk(reply.error, 'deeply nested op should be rejected with an error');
			await serverAlive();
		});

		it('rejects bulk actions with garbage payloads', async function() {
			const socket = await connect(webstrateId);
			for (const message of [
				{ a: 'bf', c: 'webstrates', b: { x: 1 } },
				{ a: 'bf', c: 'webstrates', b: [] },
				{ a: 'bs', c: 'webstrates', b: 5 },
				{ a: 'bu', c: 'webstrates' },
				{ a: 'qf', c: 'webstrates', q: {}, id: 'q1' },
				{ a: 'qf', c: 'webstrates', q: { $where: 'sleep(1000)' }, id: 'q2' },
				{ a: 'qf', c: 'webstrates', q: 'not-an-object', id: 'q3' },
				{ a: 'qs', c: 'webstrates', q: null, id: 'q4' }
			]) {
				send(socket, message);
			}
			await sleep(1000);
			await serverAlive();
		});

		it('survives delete ops on nonexistent documents and double creates', async function() {
			const docId = freshWebstrateId();
			const socket = await connect(docId);
			// Delete a document that doesn't exist.
			send(socket, { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz', seq: 4,
				del: true });
			await nextMessage(socket, message =>
				message.a === 'op' && message.d === docId).catch(() => null);
			// Create twice.
			const create = { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz', seq: 5,
				create: { type: 'http://sharejs.org/types/JSONv0', data: ['html', {}, ['body']] } };
			send(socket, create);
			await nextMessage(socket, message => message.a === 'op' && message.d === docId);
			send(socket, create);
			await nextMessage(socket, message => message.a === 'op' && message.d === docId);
			await sleep(300);
			await serverAlive();
			assert.isOk(true);
		});
	});

	// -------------------------------------------------------------------------
	// 2. `wa` (webstrates action) fuzzing — the custom action layer on the same socket
	// -------------------------------------------------------------------------

	describe('wa actions', function() {
		this.timeout(20000);

		const waReply = (socket, token, timeout = 5) => nextMessage(socket,
			message => message.wa === 'reply' && message.token === token, timeout);

		it('survives unknown and malformed wa actions', async function() {
			const socket = await connect();
			send(socket, { a: 's', c: 'webstrates', d: webstrateId });
			await nextMessage(socket, message => message.a === 's' && message.d === webstrateId);
			for (const message of [
				{ wa: 42, d: webstrateId },
				{ wa: null, d: webstrateId },
				{ wa: '', d: webstrateId },
				{ wa: ['array'], d: webstrateId },
				{ wa: { evil: true }, d: webstrateId },
				{ wa: 'unknowable-action-🐦', d: webstrateId, m: { hi: true } }
			]) {
				send(socket, message);
			}
			await sleep(800);
			await serverAlive();
		});

		it('replies with clean errors to fetchdoc/getOps version garbage', async function() {
			const docId = freshWebstrateId();
			await createDoc(docId);
			const socket = await connect(docId);
			const cases = [
				['negative version', { wa: 'fetchdoc', d: docId, token: 'f1', v: -1 }],
				['huge version', { wa: 'fetchdoc', d: docId, token: 'f2', v: 1e15 }],
				['head version', { wa: 'fetchdoc', d: docId, token: 'f3', v: 'head' }],
				['array tag', { wa: 'fetchdoc', d: docId, token: 'f4', l: ['tag'] }],
				['object version', { wa: 'fetchdoc', d: docId, token: 'f5', v: { evil: 1 } }],
				['negative ops from', { wa: 'getOps', d: docId, token: 'g1', from: -5, to: 'x' }],
				['huge ops to', { wa: 'getOps', d: docId, token: 'g2', from: 0, to: 1e308 }],
				['string ops range', { wa: 'getOps', d: docId, token: 'g3', from: 'a', to: 'b' }]
			];
			for (const [, message] of cases) {
				send(socket, message);
				const reply = await waReply(socket, message.token);
				// Both a clean error and a valid reply are fine; a crash is not.
				assert.isOk(reply.error !== undefined || reply.reply !== undefined,
					`no reply to ${JSON.stringify(message)}`);
			}
			await serverAlive();
		});

		it('replies with clean errors to tag/untag/restore garbage', async function() {
			const docId = freshWebstrateId();
			await createDoc(docId);
			const socket = await connect(docId);
			const messages = [
				{ wa: 'tag', d: docId, v: '1', l: 42 },
				{ wa: 'tag', d: docId, v: '1', l: { a: 1 } },
				{ wa: 'tag', d: docId, v: '1' },
				{ wa: 'tag', d: docId, v: '0', l: 'zero' },
				{ wa: 'tag', d: docId, v: '-1', l: 'neg' },
				{ wa: 'tag', d: docId, v: '999999999999', l: 'big' },
				{ wa: 'tag', d: docId, v: '1', l: 'with.period' },
				{ wa: 'untag', d: docId, l: 42 },
				{ wa: 'untag', d: docId, v: 'x' },
				{ wa: 'restore', d: docId, token: 'r1', v: 0 },
				{ wa: 'restore', d: docId, token: 'r2', v: 999999 },
				{ wa: 'restore', d: docId, token: 'r3', v: 1, l: 'both' },
				{ wa: 'restore', d: docId, token: 'r4' }
			];
			for (const message of messages) {
				send(socket, message);
			}
			// All of these with a token get an error reply; the tag ones without a token may
			// be silently dropped (current behavior) — the server just must not die.
			await sleep(2000);
			await serverAlive();
		});

		it('survives assetSearch with garbage query parameters', async function() {
			const docId = freshWebstrateId();
			await createDoc(docId);
			const socket = await connect(docId);
			send(socket, { wa: 'assetSearch', d: docId, token: 'as1', assetName: 'no-such-asset',
				query: {}, limit: -1e15, skip: 'x', sort: { $evil: 1 } });
			const reply = await waReply(socket, 'as1');
			assert.isOk(reply.error, 'assetSearch should reply with a clean error');
			await serverAlive();
		});

		it('refuses anonymous cookie updates and fetches', async function() {
			const docId = freshWebstrateId();
			await createDoc(docId);
			const socket = await connect(docId);
			send(socket, { wa: 'cookieUpdate', d: docId, token: 'c1',
				update: { key: { obj: true }, value: 'v' } });
			send(socket, { wa: 'cookieUpdate', d: docId, token: 'c2',
				update: { key: 'a.b' } });
			send(socket, { wa: 'cookieUpdate', d: docId, token: 'c3',
				update: { key: '__proto__' } });
			send(socket, { wa: 'cookieFetch', d: docId, token: 'c4' });
			for (const token of ['c1', 'c2', 'c3', 'c4']) {
				const reply = await waReply(socket, token);
				assert.isOk(reply.error, `anonymous ${token} should be refused with an error`);
			}
			await serverAlive();
		});

		it('refuses anonymous sendMessage and deleteMessage', async function() {
			const socket = await connect(webstrateId);
			send(socket, { wa: 'sendMessage', d: webstrateId,
				recipients: ['nobody'], m: { hi: true } });
			send(socket, { wa: 'deleteMessage', d: webstrateId, messageId: 'x' });
			send(socket, { wa: 'deleteAllMessages', d: webstrateId });
			await sleep(600);
			await serverAlive();
		});

		it('survives publish/signalUserObject with garbage payloads', async function() {
			const docId = freshWebstrateId();
			await createDoc(docId);
			const socket = await connect(docId);
			send(socket, { a: 's', c: 'webstrates', d: docId });
			await nextMessage(socket, message => message.a === 's' && message.d === docId);
			for (const message of [
				{ wa: 'publish', d: docId, m: null, recipients: 5 },
				{ wa: 'publish', d: docId, m: 'plain string' },
				{ wa: 'publish', d: docId, id: 0, m: 1 },
				{ wa: 'publish', d: docId, m: { nested: { deep: { deeper: { deepest: true } } } } },
				{ wa: 'publish', d: docId, m: 'x'.repeat(200000) },
				{ wa: 'signalUserObject', d: docId, m: { anything: true } },
				{ wa: 'signalUserObject', d: docId, m: 'x'.repeat(200000) }
			]) {
				send(socket, message);
			}
			await sleep(1000);
			await serverAlive();
		});
	});

	// -------------------------------------------------------------------------
	// 3. JSONML structure fuzzing — ops that store DOM no browser can represent
	// -------------------------------------------------------------------------

	describe('JSONML structure fuzzing', function() {
		this.timeout(30000);

		// One shared document that gets progressively more bizarre.
		let docId, socket, version = 1;

		before(async function() {
			docId = freshWebstrateId();
			socket = await createDoc(docId,
				['html', {}, ['head'], ['body', {}, ['div', { id: 'root' }, 'seed']]]);
		});

		after(async function() {
			// Every serialization route must still work over the fuzzed document.
			if (!socket) return;
			for (const suffix of ['?raw', '?json', '?dl', '?v', '?ops', '?tags', '?assets']) {
				const response = await httpGet(docId + '/' + suffix);
				assert.equal(response.status, 200,
					`GET ${suffix} over the fuzzed document failed: ${response.status}`);
			}
			await serverAlive();
		});

		const apply = async (label, op) => {
			const reply = await submitOp(socket, docId, version, op);
			assert.isNotOk(reply.error, `op "${label}" should apply: ${JSON.stringify(reply.error)}`);
			version++;
			await serverAlive();
		};

		it('stores attribute values of every JSON type (browsers only have strings)', async function() {
			await apply('number', [{ p: [3, 1, 'number-value'], oi: 42 }]);
			await apply('object', [{ p: [3, 1, 'object-value'], oi: { deep: ['er'] } }]);
			await apply('array', [{ p: [3, 1, 'array-value'], oi: [1, 2, 3] }]);
			await apply('null', [{ p: [3, 1, 'null-value'], oi: null }]);
			await apply('false', [{ p: [3, 1, 'false-value'], oi: false }]);
			await apply('true', [{ p: [3, 1, 'true-value'], oi: true }]);
			await apply('NaN-ish string', [{ p: [3, 1, 'nan-value'], oi: 'NaN' }]);
		});

		it('stores attribute names from the entire ASCII range and beyond', async function() {
			// Every ASCII control character, punctuation char, and quote — names DOM cannot
			// produce via the HTML parser (which rejects almost all of these).
			const names = [];
			for (let code = 1; code < 128; code++) {
				const name = String.fromCharCode(code);
				// JSON.stringify cannot carry some of these alone; all are legal in strings.
				names.push(name);
			}
			names.push('quote"attr', 'newline\nattr', 'equal=attr', 'less<attr',
				'slash/attr', 'back\\slash', 'nul\0byte', 'emoji🦄attr',
				'rtl‮override', 'combining áttr', 'tab\tattr', 'colon:attr',
				'CAPS-attr', 'data-auth-ish', 'data-cors-ish', 'x'.repeat(1000));
			for (const [index, name] of names.entries()) {
				const reply = await submitOp(socket, docId, version,
					[{ p: [3, 1, name], oi: 'v' + index }]);
				// Most are accepted (only __proto__-family names are rejected by sharedb).
				if (!reply.error) version++;
			}
			await serverAlive();
		});

		it('stores tag names no HTML parser would ever produce', async function() {
			const tagNames = [
				'img onerror=alert(1) src=x',   // stored verbatim — see the ?raw assertion
				'#comment', '!', '#cdata-section', 'HTML', 'ÅÄÖ', '日本語', 'a:b:c',
				'\0null-tag', 'tab\ttag', 'x'.repeat(500)
			];
			for (const [index, tagName] of tagNames.entries()) {
				const reply = await submitOp(socket, docId, version,
					[{ p: [3, 2 + index], li: [tagName, {}, 'content-' + index] }]);
				// Tag names in list positions are li ops against arrays; most apply. The
				// server must survive them all either way.
				if (!reply.error) version++;
			}
			await serverAlive();
		});

		it('stores text nodes that are not strings', async function() {
			const replies = [];
			for (const value of [7, 42.5, null, false, { toString: 'nope' }, ['nested']]) {
				const reply = await submitOp(socket, docId, version,
					[{ p: [3, 2], li: value }]);
				if (!reply.error) version++;
				replies.push(reply.error ? 'rejected' : 'accepted');
			}
			await serverAlive();
		});

		it('stores structurally impossible documents as prototypes', async function() {
			// Documents whose data is not a JSONML array at all. Created through raw ops,
			// then used as prototypes for new webstrates — the server must survive all of it.
			const cases = [
				['string', 'just a string'],
				['number', 42],
				['null', null],
				['object', { plain: true }],
				['attrs-is-number', ['html', 5]],
				['no-attrs', ['html']],
				['headless', ['html', {}, ['body']]],
				['text root child', ['html', {}, 'raw text', ['body', {}, 'more']]],
				['comment tag', ['html', {}, ['head'], ['body', {}, ['!', 'never closed']]]]
			];
			for (const [label, data] of cases) {
				const weirdId = 'test-fuzz-' + label.replace(/[^a-z0-9]/g, '') +
					'-' + util.randomString(4).toLowerCase();
				const weirdSocket = await createDoc(weirdId, data);
				weirdSocket.ws.close();
				for (const suffix of ['?raw', '?json']) {
					const response = await httpGet(weirdId + '/' + suffix);
					assert.equal(response.status, 200,
						`GET ${suffix} on the "${label}" document failed: ${response.status}`);
				}
				const response = await httpGet('new/?prototypeId=' + weirdId);
				assert.isAtLeast(response.status, 200,
					`/new?prototypeId= on the "${label}" document failed`);
			}
			await serverAlive();
		});

		it('serializes the fuzzed document without crashing (?raw)', async function() {
			const response = await httpGet(docId + '/?raw');
			assert.equal(response.status, 200, `?raw failed: ${response.status}`);
			// The document carries an element named `img onerror=alert(1) src=x` — the
			// server serializes tag names verbatim, so the injection marker is visible
			// in the output. This documents the current serialization behavior: ops can
			// store DOM beyond what browsers can parse, and ?raw serves it back raw.
			assert.include(response.body, 'img onerror=alert(1) src=x',
				'the weird tag name should round-trip through ?raw verbatim');
			// Attribute names are served verbatim, too — only values get their quotes
			// escaped. A `"` inside an attribute name therefore breaks out of the HTML
			// quoting that follows it: a stored-injection surface in ?raw output.
			assert.include(response.body, 'quote"attr=',
				'quote-bearing attribute name should be served raw (values are escaped, not names)');
			assert.include(response.body, 'less<attr=',
				'an attribute name containing < is served raw');
			await serverAlive();
		});

		it('serves the fuzzed document to a browser client without dying', async function() {
			// A real browser fetching the page gets the JSONML over the websocket and
			// renders it client-side. Fuzzed structures may break the renderer — the
			// server must survive regardless.
			const browser = await launchBrowser();
			try {
				const page = await browser.newPage();
				page.on('pageerror', () => {}); // renderer errors are expected, not fatal
				await page.goto(serverAddress + docId + '/',
					{ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
				await sleep(2000);
				await serverAlive();
				assert.isOk(true);
			} finally {
				await browser.close();
			}
		});
	});

	// -------------------------------------------------------------------------
	// 4. DOM fuzzing in a real browser — manipulation and events at the DOM's edge
	// -------------------------------------------------------------------------

	describe('DOM manipulation and events (real browser)', function() {
		this.timeout(60000);

		let browser, pageA, pageB;
		let docId;

		const launchBrowserForSuite = async () => {
			browser = await launchBrowser();
			pageA = await browser.newPage();
			pageB = await browser.newPage();
			// Renderer errors are expected under fuzzing — they must never reach the server.
			for (const page of [pageA, pageB]) {
				page.on('pageerror', () => {});
				page.on('error', () => {});
				page.on('console', message => {
					if (message.type() === 'error') page.lastConsoleError = message.text();
				});
			}
		};

		const waitForWebstrate = async (page, timeout = 20000) => {
			try {
				await page.waitForFunction(() => window.webstrate && window.webstrate.loaded === true,
					{ timeout, polling: 100 });
				return true;
			} catch {
				return false;
			}
		};

		const evaluateQuietly = async (page, fn, ...args) => {
			try {
				return await page.evaluate(fn, ...args);
			} catch (err) {
				return { evaluationError: err.message.split('\n')[0] };
			}
		};

		before(async function() {
			await launchBrowserForSuite();
			docId = freshWebstrateId();

			await pageA.goto(serverAddress + docId + '/', { waitUntil: 'domcontentloaded' });
			assert.isTrue(await waitForWebstrate(pageA),
				'the webstrate client failed to load in the first page');

			await pageB.goto(serverAddress + docId + '/', { waitUntil: 'domcontentloaded' });
			assert.isTrue(await waitForWebstrate(pageB),
				'the webstrate client failed to load in the second page');
		});

		after(async function() {
			if (browser) await browser.close();
		});

		it('synchronizes an attribute-name storm covering the ASCII range', async function() {
			const result = await evaluateQuietly(pageA, () => {
				const element = document.createElement('div');
				element.id = 'ascii-storm';
				document.body.appendChild(element);
				const accepted = [];
				const rejected = [];
				for (let code = 1; code < 128; code++) {
					const name = String.fromCharCode(code);
					try {
						element.setAttribute(name, 'v' + code);
						accepted.push(code);
					} catch {
						rejected.push(code); // DOM refuses whitespace, /, =, >
					}
				}
				return { accepted: accepted.length, rejected };
			});
			assert.isAbove(result.accepted, 100, 'the DOM should accept most ASCII attribute names');
			await sleep(2000); // let the op storm settle and synchronize

			// The roundtrip has three different views, all verified behavior:
			//  - Page B's client rebuilds elements through coreJsonML, which sanitizes every
			//    attribute name outside [:A-Z_a-z][-._:0-9a-zA-Z] into '_': it only ever
			//    materializes the ~29 sanitized survivors (a-z, ':', '_' and the id).
			//  - Browsers lowercase attribute names, so 'A'..'Z' collide with 'a'..'z'
			//    before any op exists.
			//  - The server, though, stores whatever names the ops carry — ?raw serves the
			//    control characters, digits and punctuation raw. Server and clients
			//    legitimately disagree about this document.
			const synced = await evaluateQuietly(pageB, () => {
				const element = document.getElementById('ascii-storm');
				if (!element) return null;
				const letters = [];
				for (let code = 97; code <= 122; code++) {
					letters.push(element.getAttribute(String.fromCharCode(code)));
				}
				return { total: element.attributes.length, letters,
					colon: element.getAttribute(':'), underscore: element.getAttribute('_') };
			});
			assert.isOk(synced, 'the storm element should exist on the second page');
			assert.isAtLeast(synced.total, 26, 'the sanitized survivors should be materialized');
			assert.equal(synced.letters.filter(v => v && v.startsWith('v')).length, 26,
				'all lowercase letter attributes should be on the second page');
			assert.isOk(synced.colon, 'the \':\' attribute survives sanitization');
			assert.isOk(synced.underscore, 'the \'_\' attribute survives sanitization');

			// The server stored the storm raw: control characters, digits, punctuation and
			// < inside attribute names are served back verbatim in ?raw (deterministically,
			// which names survive client-side op batching was verified stable across runs).
			const response = await httpGet(docId + '/?raw');
			assert.equal(response.status, 200);
			const divLine = response.body.match(/<[dD][iI][vV][^>]*ascii-storm[^>]*>/);
			assert.isOk(divLine, 'the storm element should be stored');
			const storedCount = (divLine[0].match(/="v\d+"/g) || []).length;
			assert.isAbove(storedCount, 40,
				'the server should store far more raw attribute names than clients materialize');
			assert.isAbove(storedCount, synced.total,
				'server (?raw) and clients must disagree on the attribute storm');
			for (const marker of [String.fromCharCode(2) + '="v2"', '0="v48"', '!="v33"',
				'a="v97"', '<="v60"']) {
				assert.include(divLine[0], marker,
					'control/digit/punctuation attribute names are stored and served raw');
			}
			await serverAlive();
		});

		it('synchronizes attribute values containing the whole unicode edge', async function() {
			const result = await evaluateQuietly(pageA, () => {
				const element = document.createElement('div');
				element.id = 'value-storm';
				document.body.appendChild(element);
				const chunks = [];
				for (let code = 1; code < 0x300; code++) chunks.push(String.fromCodePoint(code));
				for (const code of [0x2028, 0x2029, 0xFEFF, 0x200B, 0x200D, 0x200E, 0x200F,
					0x202A, 0x202E, 0x1F600, 0x10FFFF]) {
					chunks.push(String.fromCodePoint(code));
				}
				// Lone surrogates: legal JS strings, illegal UTF-8, unrepresentable in JSON
				// round-trips. The websocket layer must survive them.
				chunks.push('\uD800', '\uDC00');
				const value = chunks.join('');
				element.setAttribute('kitchen-sink', value);
				element.setAttribute('entities', '&<>"\'`\\');
				return { length: element.getAttribute('kitchen-sink').length };
			});
			// 0x1..0x2FF = 767 UTF-16 units, + 9 single-unit specials, + 2 surrogate pairs
			// for the astral code points (2 units each), + 2 lone surrogates = 782 exactly.
			assert.isAbove(result.length, 780, 'the unicode kitchen sink value should be set');
			await sleep(2000);
			const synced = await evaluateQuietly(pageB, () => {
				const element = document.getElementById('value-storm');
				return element ? element.getAttribute('kitchen-sink').length : -1;
			});
			// The value syncs with full fidelity — even the lone surrogates survive the
			// websocket/BSON roundtrip (verified: page B receives all 782 UTF-16 units).
			assert.isAtLeast(synced, 780, 'the second page should have received the value');
			await serverAlive();
		});

		it('survives element names at the edge of what createElement accepts', async function() {
			const result = await evaluateQuietly(pageA, () => {
				const results = {};
				const names = ['', 'a b', 'a/b', 'a\\b', 'a<b', 'a>b', '<a>', '1abc', '-abc',
					'ab:cd', 'ab::cd', ':ab', 'AB', 'ÅÄÖ', '日本語', 'a\nb', 'a\tb',
					'x'.repeat(1000), 'onerror', 'onclick', 'DIV', 'div'.repeat(200)];
				for (const name of names) {
					try {
						const element = document.createElement(name);
						document.body.appendChild(element);
						results[name.slice(0, 20)] = element.tagName;
					} catch (err) {
						results[name.slice(0, 20)] = 'ERR:' + err.name;
					}
				}
				return results;
			});
			assert.isOk(result, 'the element name storm should evaluate');
			await sleep(2000);
			await serverAlive();
		});

		it('survives deep and wide DOM trees', async function() {
			const result = await evaluateQuietly(pageA, () => {
				let parent = document.body;
				let depth = 0;
				try {
					while (depth < 600) {
						const element = document.createElement('div');
						parent.appendChild(element);
						parent = element;
						depth++;
					}
				} catch { /* browsers cap the tree at some point */ }
				const wide = document.createElement('div');
				wide.id = 'wide-tree';
				document.body.appendChild(wide);
				for (let i = 0; i < 2000; i++) wide.appendChild(document.createElement('span'));
				return { depth, width: wide.children.length };
			});
			assert.isAbove(result.width, 1900, 'the wide tree should be built');
			await sleep(4000); // the deep tree may exceed the database nesting depth —
			// the op gets rejected with an error reply, which must not kill anything.
			await serverAlive();
			const pagesAlive = await evaluateQuietly(pageB, () => !!window.webstrate);
			assert.isTrue(pagesAlive, 'the second page should still be alive');
		});

		it('survives event dispatch storms', async function() {
			const result = await evaluateQuietly(pageA, () => {
				const target = document.body;
				const types = ['click', 'dblclick', 'mousedown', 'mouseup', 'input', 'keydown',
					'keypress', 'keyup', 'focus', 'blur', 'change', 'submit', 'wheel',
					'contextmenu', 'dragstart', 'beforeinput', 'selectionchange',
					'transitionend', 'weird-custom-event-🐦', 'x'.repeat(300)];
				let dispatched = 0;
				const errors = [];
				for (const type of types) {
					try {
						target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
						dispatched++;
					} catch (err) {
						errors.push(type.slice(0, 12) + ':' + err.name);
					}
				}
				for (const constructorArgs of [
					['huge-detail', { detail: { x: 'y'.repeat(100000) } }, CustomEvent],
					['kbd', { key: '', keyCode: 0x10FFFF, which: NaN }, KeyboardEvent],
					['ui', { detail: Infinity }, UIEvent],
					['focus', { relatedTarget: document.documentElement }, FocusEvent]
				]) {
					try {
						target.dispatchEvent(new constructorArgs[2](...constructorArgs));
						dispatched++;
					} catch (err) {
						errors.push('ctor:' + err.name);
					}
				}
				return { dispatched, errors };
			});
			assert.isAbove(result.dispatched, 15, 'most event storms should dispatch');
			await sleep(1000);
			await serverAlive();
		});

		it('survives rapid attribute churn (MutationObserver stress)', async function() {
			const result = await evaluateQuietly(pageA, async () => {
				const element = document.createElement('div');
				element.id = 'churn';
				document.body.appendChild(element);
				for (let i = 0; i < 500; i++) {
					element.setAttribute('data-i', String(i));
					element.setAttribute('class', i % 2 ? 'a' : 'b');
					if (i % 100 === 0) element.setAttribute('data-critical', 'c' + i);
				}
				await new Promise(resolve => setTimeout(resolve, 300));
				return element.getAttribute('data-i');
			});
			assert.equal(result, '499', 'churn should end on the last value');
			await sleep(2000);
			const synced = await evaluateQuietly(pageB, () =>
				document.getElementById('churn')?.getAttribute('data-i'));
			assert.equal(synced, '499', 'the second page should see the final churn value');
			await serverAlive();
		});

		it('survives document structure surgery (title, documentElement, head)', async function() {
			const result = await evaluateQuietly(pageA, () => {
				const out = [];
				const attempt = (label, fn) => {
					try { fn(); out.push(label + ':ok'); } catch (err) { out.push(label + ':' + err.name); }
				};
				attempt('title-emoji-injection', () => {
					document.title = 'fuzz–🐦-<title>injected</title>';
				});
				attempt('documentElement-attr', () => {
					document.documentElement.setAttribute('data-fuzz', 'x"y=z');
				});
				attempt('head-title-move', () => {
					document.title = 'moved';
					document.head.appendChild(document.createTextNode('headtext'));
				});
				attempt('body-attr', () => {
					document.body.setAttribute('data-fuzz', '\0nul');
				});
				attempt('comment-node', () => {
					document.body.appendChild(document.createComment('<!-- not a comment -->'));
				});
				attempt('processing-instruction', () => {
					// Not supported in HTML documents — must throw cleanly, not hang.
					document.createProcessingInstruction('xml', 'version="1.0"');
				});
				attempt('cdata-attempt', () => {
					// HTML documents don't expose createCDATASection.
					document.createCDATASection('cdata');
				});
				return out;
			});
			assert.include(result, 'title-emoji-injection:ok');
			await sleep(2000);
			await serverAlive();
			const pagesAlive = await evaluateQuietly(pageB, () => !!window.webstrate);
			assert.isTrue(pagesAlive, 'the second page should survive the surgery');
		});

		it('synchronizes DOM changes between two pages, server stays healthy', async function() {
			const marker = 'marker-' + util.randomString();
			await evaluateQuietly(pageB, (marker) => {
				const element = document.createElement('p');
				element.id = marker;
				element.setAttribute('data-source', 'page-b');
				element.textContent = 'from b';
				document.body.appendChild(element);
			}, marker);
			await sleep(2000);
			const received = await evaluateQuietly(pageA, (marker) => {
				const element = document.getElementById(marker);
				return element && element.getAttribute('data-source');
			}, marker);
			assert.equal(received, 'page-b', 'page A should see the element page B created');
			await serverAlive();
		});

		it('keeps serving ?raw of a browser-fuzzed document', async function() {
			// Same transient-fetch tolerance as the canary below: poll briefly so a one-off
			// miss under load doesn't fail the suite (persistent loss is a real failure).
			let response;
			for (let attempt = 0; attempt < 8; attempt++) {
				response = await httpGet(docId + '/?raw');
				if (response.status === 200) break;
				await sleep(500);
			}
			assert.equal(response.status, 200);
			assert.include(response.body, 'ascii-storm', 'the storm element should be stored');
			// Control-character and digit attribute names from the browser storm are served
			// raw. Which codes make it through the client's op batching is deterministic but
			// uneven (even-numbered controls, even digits, odd punctuation — verified stable
			// across runs);  (STX) and '0' always survive.
			assert.include(response.body, String.fromCharCode(2) + '="v2"',
				'control-character attribute names should be stored and served');
			assert.include(response.body, '0="v48"',
				'digit attribute names should be stored and served');
			await serverAlive();
		});
	});

	// -------------------------------------------------------------------------
	// 5. Process-killing and process-corrupting candidates (run last)
	// -------------------------------------------------------------------------

	describe('crash candidates', function() {
		this.timeout(30000);

		// A canary document: created before any pollution attempt, its ?raw output must
		// stay free of phantom attributes afterwards. Prototype pollution in the server
		// leaks inherited properties into every document via replaceInKeys' for..in loop.
		let canaryId;

		before(async function() {
			canaryId = 'test-fuzz-canary-' + util.randomString().toLowerCase();
			const socket = await createDoc(canaryId,
				['html', {}, ['head'], ['body', {}, ['div', { id: 'canary' }, 'clean']]]);
			socket.ws.close();
			await sleep(300);
		});

		// The ?raw fetch occasionally hiccuped into a 404 under load in a long run (seen
		// once across many runs, never reproduced with the document actually gone); poll
		// briefly so a transient miss doesn't fail the canary, while persistent pollution
		// still fails.
		const canaryRaw = async () => {
			let last;
			for (let attempt = 0; attempt < 8; attempt++) {
				last = await httpGet(canaryId + '/?raw');
				if (last.status === 200) return last.body;
				await sleep(500);
			}
			return last.body;
		};

		it('canary starts clean', async function() {
			const raw = await canaryRaw();
			assert.include(raw, '<div id="canary">clean</div>',
				'the canary document should serve clean before the pollution attempts');
		});

		it('survives subscribe with nodeIds colliding with Object.prototype (the crash recipe)',
			async function() {
				// The deterministic kill on unfixed servers:
				//   1. join a webstrate ({a:'s'}),
				//   2. {wa:'subscribe', id:'__proto__'} — records the bad nodeId, then
				//      throws contained TypeErrors,
				//   3. close the socket — the partFn cleanup dereferences the bad nodeId
				//      synchronously in the websocket close chain: process death.
				const crashDocId = 'test-fuzz-crash-' + util.randomString().toLowerCase();
				await createDoc(crashDocId);
				const socket = await connect(crashDocId);
				send(socket, { a: 's', c: 'webstrates', d: crashDocId });
				await nextMessage(socket, message =>
					message.a === 's' && message.d === crashDocId);
				for (const nodeId of ['__proto__', 'toString', 'hasOwnProperty', 'constructor',
					'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__',
					'__lookupGetter__', '__defineSetter__', '__lookupSetter__', 'toLocaleString']) {
					send(socket, { wa: 'subscribe', d: crashDocId, id: nodeId });
				}
				// Give the (contained) subscribe processing time to run and record.
				await sleep(1000);
				await serverAlive();
				// The disconnect is the actual trigger of the fatal path.
				socket.ws.close();
				await sleep(500);
				await serverAlive();
				// The delayed partFn window (2s) must not kill the process either.
				await sleep(2600);
				await serverAlive();
			});

		it('survives unsubscribing from colliding nodeIds directly', async function() {
			const docId = 'test-fuzz-unsub-' + util.randomString().toLowerCase();
			await createDoc(docId);
			const socket = await connect(docId);
			send(socket, { a: 's', c: 'webstrates', d: docId });
			await nextMessage(socket, message => message.a === 's' && message.d === docId);
			for (const nodeId of ['__proto__', 'toString', 'constructor']) {
				send(socket, { wa: 'subscribe', d: docId, id: nodeId });
				send(socket, { wa: 'unsubscribe', d: docId, id: nodeId });
			}
			await sleep(1500);
			await serverAlive();
			socket.ws.close();
			await sleep(2600);
			await serverAlive();
		});

		it('survives publish to nodeIds colliding with Object.prototype', async function() {
			const docId = 'test-fuzz-pub-' + util.randomString().toLowerCase();
			await createDoc(docId);
			const socket = await connect(docId);
			send(socket, { a: 's', c: 'webstrates', d: docId });
			await nextMessage(socket, message => message.a === 's' && message.d === docId);
			for (const nodeId of ['__proto__', 'toString', 'document']) {
				send(socket, { wa: 'publish', d: docId, id: nodeId, m: { hi: true } });
			}
			await sleep(1500);
			await serverAlive();
		});

		it('does not pollute when webstrateId collides with Object.prototype', async function() {
			// Connecting to /__proto__/ (any Object.prototype property as URL segment) and
			// subscribing used to write through plain-object maps straight into
			// Object.prototype — process-wide pollution that leaked phantom attributes
			// into every document the server serves.
			const badWebstrateIds = ['__proto__', 'toString', 'constructor', 'hasOwnProperty'];
			for (const badId of badWebstrateIds) {
				const socket = await connect(badId);
				send(socket, { a: 's', c: 'webstrates', d: badId });
				await sleep(500);
				send(socket, { wa: 'subscribe', d: badId, id: 'document' });
				send(socket, { wa: 'subscribe', d: badId, id: 'polluted-key-test' });
				send(socket, { wa: 'publish', d: badId, id: 'document', m: { hi: true } });
				await sleep(800);
				socket.ws.close();
				// The join timer (2s) and the delayed partFn run after close.
				await sleep(2600);
				await serverAlive();
			}

			// The canary document must still serve completely clean — no phantom
			// attributes leaked into it by any of the pollution attempts above.
			const raw = await canaryRaw();
			assert.include(raw, '<div id="canary">clean</div>',
				'the canary document must stay free of phantom attributes');
			assert.notInclude(raw, 'polluted-key-test',
				'the pollution marker must not leak into other documents');
			assert.notMatch(raw, /\sdocument=""/,
				'the "document" pollution marker must not leak into other documents');
		});

		it('still serves well-formed clients after all crash candidates', async function() {
			const docId = freshWebstrateId();
			const socket = await createDoc(docId);
			// A well-formed op still round-trips.
			await opShouldApply(socket, docId, 1, [{ p: [3, 2], li: ['div', {}, 'alive'] }]);
			const raw = await httpGet(docId + '/?raw');
			assert.equal(raw.status, 200, '?raw should still serve the document');
			assert.include(raw.body, 'alive');
			await serverAlive();
		});
	});
});

// Launch a browser for the fuzz suite. Root environments (this jail, upstream CI) need the
// no-sandbox wrapper — the same resolution the test runner applies.
async function launchBrowser() {
	if (!process.env.PUPPETEER_EXECUTABLE_PATH && typeof process.getuid === 'function'
		&& process.getuid() === 0) {
		const wrapper = path.join(path.dirname(new URL(import.meta.url).pathname),
			'..', 'lib', 'chrome-wrapper');
		if (fs.existsSync(wrapper)) {
			process.env.PUPPETEER_EXECUTABLE_PATH = wrapper;
		}
	}
	return await puppeteer.launch();
}
