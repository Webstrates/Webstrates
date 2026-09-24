// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Fuzzing Webstrates from every direction a client can reach it: the `wa` websocket
// envelope, the commit/ops wire protocol (the sa/sr/aa/ar/si/sd op grammar over the
// SQLite mirror), the stored document model (where ops can store DOM structures no
// browser can represent, or even parse), and real browsers doing DOM manipulation
// and events at the edge of what the DOM allows.
//
// The suite runs its own server instance (custom port, own pid) so crash candidates can't take
// out a base server shared with other suites, and keeps a "canary" document whose ?raw output
// must stay clean of phantom attributes after the prototype-pollution attempts.
//
// Notable regressions locked in here (all process-killing or corrupting on unfixed code):
//  - signals: subscribing with a nodeId that collides with an Object.prototype property
//    (`__proto__`, `toString`, ...) throws inside a retry timer on disconnect — an
//    unauthenticated, one-message process kill.
//  - webstrateId: connecting to /__proto__/ (any Object.prototype property name as URL
//    segment) and subscribing pollutes Object.prototype for the whole process, leaking
//    phantom attributes into every document the server serves.
//
// Notable contained/verified behaviors documented by this suite (the wire-op contract):
//  - Element names must match the serialization grammar (ASCII-letter start) —
//    hostile tag names are rejected with a clean error, not stored.
//  - Attribute VALUES are restricted to strings at the wire (the json0 era could
//    store numbers/objects/arrays); text/comment CONTENT still carries any JSON value.
//  - Attribute names carry no grammar — every ASCII/unicode name except the reserved
//    transport names is stored; the serializer escapes the names it serves in ?raw,
//    closing the old quote-injection surface.
//  - Ops naming missing parents/nodes are warn-skipped inside an otherwise accepted
//    commit; huge eids (up to float precision) and out-of-range indexes (clamped) are
//    applied, not rejected; an empty or non-array ops list becomes a no-op commit
//    that still bumps the revision.
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

	// Wait for the `wa` reply carrying a token, i.e. one the server actually processed.
	const waReply = (socket, token, timeout = 5) => nextMessage(socket,
		message => message.wa === 'reply' && message.token === token, timeout);

	// Submit a wire-op commit ({wa:'commit', d, base, ops, token}) and return the
	// server's reply: {reply: {v, firstOpid, xformed}} on success, {error} otherwise.
	let commitSeq = 0; // token counter, one fresh token per commit
	const submitCommit = (socket, docId, base, ops, token = 'c' + (++commitSeq)) => {
		send(socket, { wa: 'commit', d: docId, base, token, ops });
		return waReply(socket, token);
	};

	// A commit that should apply without error; returns the reply payload
	// ({v, firstOpid, xformed}) and asserts the server is still alive.
	const commitShouldApply = async (socket, docId, base, ops) => {
		const reply = await submitCommit(socket, docId, base, ops);
		assert.isNotOk(reply.error, 'commit was rejected: ' + JSON.stringify(reply.error));
		await serverAlive();
		return reply.reply;
	};

	// Bootstrap a document through the native wire protocol — the way the browser
	// client itself creates documents: a base-0 commit growing the empty mirror.
	// Returns the socket with `version` set to the created revision.
	const createDocV2 = async (docId, extraOps = []) => {
		const socket = await connect(docId);
		const reply = await submitCommit(socket, docId, 0, [
			{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
			{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
			{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' },
			...extraOps
		], 'create');
		assert.isNotOk(reply.error, `could not create ${docId}: ${JSON.stringify(reply.error)}`);
		socket.version = reply.reply.v;
		return socket;
	};

	// Fetch a document's structure over the native protocol ({v, struct, state}).
	const fetchDoc = async (socket, docId) => {
		const token = 'fetch' + (++commitSeq);
		send(socket, { wa: 'fetchdoc', d: docId, token });
		const reply = await waReply(socket, token);
		assert.isNotOk(reply.error, `fetchdoc failed: ${JSON.stringify(reply.error)}`);
		return reply.reply;
	};

	// Seed a document through the legacy JsonML create shim ({a:'op', create}) — the
	// one surviving sharedb-era message, and still the only way to ingest arbitrary
	// JsonML shapes from a socket (the weird-create corpora below). The reply echoes
	// the seq and carries the created version (not 0).
	const createDoc = async (docId, data) => {
		const socket = await connect(docId);
		send(socket, { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz', seq: 1,
			create: { type: 'http://sharejs.org/types/JSONv0',
				data: data || ['html', {}, ['head'], ['body']] } });
		const reply = await nextMessage(socket, message =>
			message.a === 'op' && message.d === docId && message.seq === 1);
		assert.isNotOk(reply.error, `could not create document: ${JSON.stringify(reply.error)}`);
		return socket;
	};

	// A webstrate fetch-creating a document in the browser client, then a loaded page.
	const freshWebstrateId = () => 'test-fuzz-' + util.randomString().toLowerCase();

	// -------------------------------------------------------------------------
	// 1. Websocket envelope fuzzing — the frame/action layer under the `wa`
	//    protocol (opening a socket IS the subscribe now)
	// -------------------------------------------------------------------------

	describe('websocket protocol envelope', function() {
		this.timeout(20000);

		it('answers a well-formed client after garbage envelopes', async function() {
			if (ownServer) {
				assert.isNull(ownServer.child.exitCode, 'the server process should still be running');
			}

			// Junk first, then prove the same socket still round-trips: connecting
			// joins the document, and a fetchdoc on it answers.
			const socket = await connect();
			const hello = await nextMessage(socket,
				message => message.wa === 'hello' && message.d === webstrateId);
			assert.isOk(hello, 'opening a socket should join its document (the hello)');
			const doc = await fetchDoc(socket, webstrateId);
			assert.isOk(doc.v !== undefined, 'fetchdoc should still answer over the socket');
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

		// The d field addresses a document other than the socket's own (a secondary
		// subscription or cross-document fetch). Hostile d values must be resolved
		// (or refused) without crashing.
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
			it(`survives unusable document ids: ${label}`, async function() {
				const socket = await connect();
				const token = 'd' + label.replace(/[^a-z]/gi, '');
				send(socket, JSON.parse(JSON.stringify(
					{ wa: 'fetchdoc', d: docId, token })));
				// The server must either reply with an error or drop the message —
				// both are acceptable as long as it survives.
				await nextMessage(socket, message =>
					message.wa === 'reply' && message.token === token).catch(() => null);
				await sleep(400);
				await serverAlive();
			});
		}

		// Commit base abuse: the base drives the OT-lite transform; anything but a
		// non-negative integer within the revision range is refused with an error
		// reply, never a crash.
		for (const [label, base] of [
			['negative base', -1],
			['fractional base', 0.5],
			['base as string', '0'],
			['base as null', null],
			['missing base', undefined],
			['beyond head revision', 1e15]
		]) {
			it(`survives commit base abuse: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDocV2(docId);
				const reply = await submitCommit(socket, docId, base,
					[{ k: 'sa', p: 3, i: 0, e: 10, t: 1, n: 'div' }]);
				assert.isOk(reply.error, `base ${JSON.stringify(base)} should be rejected`);
				await serverAlive();
			});
		}

		// The ops list: a non-array value is coerced to an empty commit — a no-op
		// that still bumps the revision by exactly one (documented behavior) —
		// while a hostile op ENTRY is rejected with an error.
		for (const [label, ops, expectError] of [
			['ops as number', 5, false],
			['ops as string', 'div', false],
			['ops as null', null, false],
			['ops as object', { k: 'sa' }, false],
			['missing ops', undefined, false],
			['empty ops', [], false],
			['op as string', ['sa'], true],
			['op as number', [7], true],
			['op as null', [null], true],
			['op as array', [[{ k: 'sa' }]], true],
			['op without a kind', [{ p: 3, i: 0, e: 10 }], true],
			['op with unknown kind', [{ k: 'zz', p: 3, i: 0, e: 10, t: 1, n: 'div' }], true],
			['op with numeric kind', [{ k: 7, p: 3, i: 0, e: 10, t: 1, n: 'div' }], true]
		]) {
			it(`survives commit ops abuse: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDocV2(docId);
				const before = socket.version;
				const reply = await submitCommit(socket, docId, before, ops);
				if (expectError) {
					assert.isOk(reply.error, `ops ${JSON.stringify(ops)} should be rejected`);
				} else {
					assert.isNotOk(reply.error, 'a coerced-empty ops value should not error');
					assert.equal(reply.reply.v, before + 1,
						'a no-op commit bumps the revision by exactly one');
				}
				await serverAlive();
			});
		}

		// Op field types across the wire kinds: eids, parents, indexes and offsets
		// must be non-negative integers; names, values and text must be strings.
		// Hostile values are rejected; huge integers are accepted (the mirror
		// keys rows by whatever integer arrives — up to float precision,
		// documented), and so are node types no browser produces.
		for (const [label, op, expectError] of [
			['negative eid', { k: 'sa', p: 3, i: 0, e: -5, t: 1, n: 'div' }, true],
			['fractional eid', { k: 'sa', p: 3, i: 0, e: 1.5, t: 1, n: 'div' }, true],
			['zero eid', { k: 'sa', p: 3, i: 0, e: 0, t: 1, n: 'div' }, true],
			['eid as string', { k: 'sa', p: 3, i: 0, e: '10', t: 1, n: 'div' }, true],
			['eid as object', { k: 'sa', p: 3, i: 0, e: { evil: 1 }, t: 1, n: 'div' }, true],
			['missing eid', { k: 'sa', p: 3, i: 0, t: 1, n: 'div' }, true],
			['huge integer eid', { k: 'sa', p: 3, i: 0, e: 1e15, t: 1, n: 'div' }, false],
			['max safe integer eid', { k: 'sa', p: 3, i: 0, e: 9007199254740991, t: 1, n: 'div' }, false],
			['negative index', { k: 'sa', p: 3, i: -1, e: 10, t: 1, n: 'div' }, true],
			['fractional index', { k: 'sa', p: 3, i: 0.5, e: 10, t: 1, n: 'div' }, true],
			['index as string', { k: 'sa', p: 3, i: '0', e: 10, t: 1, n: 'div' }, true],
			['missing parent', { k: 'sa', i: 0, e: 10, t: 1, n: 'div' }, true],
			['parent as string', { k: 'sa', p: '3', i: 0, e: 10, t: 1, n: 'div' }, true],
			['negative node type', { k: 'sa', p: 3, i: 0, e: 10, t: -1 }, true],
			// A hostile node type with no name cannot be persisted (undefined
			// does not bind as a SQL parameter) — rejected with a clean error.
			['hostile node type 999', { k: 'sa', p: 3, i: 0, e: 10, t: 999 }, true],
			// With a name it binds and stores (the schema does not constrain
			// node types to text/comment/element).
			['hostile node type 999 with a name', { k: 'sa', p: 3, i: 0, e: 11, t: 999, n: 'x' }, false],
			['element name as number', { k: 'sa', p: 3, i: 0, e: 10, t: 1, n: 7 }, true],
			['element name as object', { k: 'sa', p: 3, i: 0, e: 10, t: 1, n: { evil: 1 } }, true],
			['attribute value as number', { k: 'aa', e: 3, i: 0, n: 'x', v: 42 }, true],
			['attribute value as object', { k: 'aa', e: 3, i: 0, n: 'x', v: { evil: 1 } }, true],
			['attribute value as null', { k: 'aa', e: 3, i: 0, n: 'x', v: null }, true],
			['attribute value as false', { k: 'aa', e: 3, i: 0, n: 'x', v: false }, true],
			['attribute name as number', { k: 'aa', e: 3, i: 0, n: 7, v: 'x' }, true],
			['attribute name missing', { k: 'aa', e: 3, i: 0, v: 'x' }, true],
			['reserved name underscore', { k: 'aa', e: 3, i: 0, n: '_', v: 'x' }, true],
			['reserved name case-folded',
				{ k: 'aa', e: 3, i: 0, n: 'DATA-WEBSTRATES-TYPE', v: 'x' }, true],
			['text insert at negative offset', { k: 'si', e: 5, q: -1, v: 'x' }, true],
			['text insert with numeric value', { k: 'si', e: 5, q: 0, v: 7 }, true],
			['text insert with fractional offset', { k: 'si', e: 5, q: 0.5, v: 'x' }, true]
		]) {
			it(`survives wire-op field abuse: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDocV2(docId, [
					{ k: 'sa', p: 3, i: 0, e: 5, t: 3, n: null },
					{ k: 'aa', e: 5, n: null, v: 'seed' }
				]);
				const reply = await submitCommit(socket, docId, socket.version, [op]);
				if (expectError) {
					assert.isOk(reply.error, `op ${JSON.stringify(op)} should be rejected`);
				} else {
					// Accepted: the huge-eid and hostile-type cases are stored.
					assert.isNotOk(reply.error, `op ${JSON.stringify(op)} should apply`);
					const doc = await fetchDoc(socket, docId);
					const row = doc.struct.find(([, , e]) => e === op.e);
					assert.isOk(row, 'the op\'d eid should be present in the structure');
					// Remove the hostile node again so the async snapshot rebuild
					// never has to serialize it (this section fuzzes the commit
					// grammar; the serialization routes are fuzzed below).
					const cleanup = await submitCommit(socket, docId, doc.v,
						[{ k: 'sr', p: 3, e: op.e }]);
					assert.isNotOk(cleanup.error, 'the hostile node should be removable');
				}
				await serverAlive();
			});
		}

		// The v2 "silently applied" corpus: wire ops that pass the grammar but are
		// degenerate — they apply with outcomes no browser would produce, or are
		// warn-skipped inside an otherwise accepted commit (the revision still
		// bumps by one). Each is deterministic, documented behavior.
		for (const [label, ops, expected] of [
			['sa onto a missing parent (skipped)',
				[{ k: 'sa', p: 999, i: 0, e: 10, t: 1, n: 'div' }], 'one'],
			['aa onto a missing element (skipped)', [{ k: 'aa', e: 999, i: 0, n: 'x', v: 'y' }], 'one'],
			['sr of a missing element (skipped)', [{ k: 'sr', p: 3, e: 999 }], 'one'],
			['ar of a missing attribute name (skipped)', [{ k: 'ar', e: 3, n: 'missing' }], 'one'],
			['content op on an element (skipped)', [{ k: 'aa', e: 3, n: null, v: 'nope' }], 'one'],
			['sd of non-matching text (skipped)', [{ k: 'sd', e: 5, q: 0, v: 'WRONG' }], 'one'],
			['si on an element without an index (skipped)', [{ k: 'si', e: 3, q: 0, v: 'x' }], 'one'],
			['lone sa replay of an attached node (skipped)',
				[{ k: 'sa', p: 3, i: 0, e: 5, t: 3, n: null }], 'one'],
			['sa of an attached node at another slot (skipped)',
				[{ k: 'sa', p: 3, i: 1, e: 5, t: 3, n: null }], 'one'],
			['sa index clamped to the end',
				[{ k: 'sa', p: 3, i: 1e9, e: 10, t: 1, n: 'div' }], 'one<div></div>'],
			['aa insert position clamped', [{ k: 'aa', e: 3, i: 1e9, n: 'x', v: 'y' }], 'x="y"'],
			['si offset clamped into the text', [{ k: 'si', e: 5, q: 1e9, v: '!' }], 'one!'],
			['si duplicated (a legitimate double insert)',
				[{ k: 'si', e: 5, q: 0, v: 'dupe' }, { k: 'si', e: 5, q: 0, v: 'dupe' }], 'dupedupe']
		]) {
			it(`applies degenerate wire ops deterministically: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDocV2(docId, [
					{ k: 'sa', p: 3, i: 0, e: 5, t: 3, n: null },
					{ k: 'aa', e: 5, n: null, v: 'one' }
				]);
				const reply = await submitCommit(socket, docId, socket.version, ops);
				assert.isNotOk(reply.error,
					'a degenerate op set should not error: ' + JSON.stringify(reply.error));
				const response = await httpGet(docId + '/?raw');
				assert.equal(response.status, 200, `?raw failed: ${response.status}`);
				assert.include(response.body, expected,
					'the applied op should be visible in ?raw (or have left the document intact)');
				await serverAlive();
			});
		}

		// Element names must survive HTML serialization (ASCII-letter start, then
		// letters/digits/:-_.): the grammar rejects everything a browser would
		// never produce — including the injection carriers the json0 era stored.
		for (const [label, name] of [
			['injection carrier', 'img onerror=alert(1) src=x'],
			['comment tag', '#comment'],
			['cdata tag', '#cdata-section'],
			['leading digit', '1abc'],
			['leading dash', '-abc'],
			['leading colon', ':ab'],
			['nul byte', '\0null-tag'],
			['tab in name', 'tab\ttag'],
			['non-ASCII letters', 'ÅÄÖ'],
			['CJK', '日本語']
		]) {
			it(`rejects element names outside the serialization grammar: ${label}`, async function() {
				const docId = freshWebstrateId();
				const socket = await createDocV2(docId);
				const reply = await submitCommit(socket, docId, socket.version,
					[{ k: 'sa', p: 3, i: 0, e: 10, t: 1, n: name }]);
				assert.isOk(reply.error, `element name ${JSON.stringify(name)} should be rejected`);
				await serverAlive();
			});
		}

		it('applies and serializes element names the grammar accepts', async function() {
			const docId = freshWebstrateId();
			const socket = await createDocV2(docId);
			const names = ['HTML', 'a:b:c', 'A-B.C_D', 'x'.repeat(500)];
			const ops = names.map((name, index) =>
				({ k: 'sa', p: 3, i: index, e: 20 + index, t: 1, n: name }));
			await commitShouldApply(socket, docId, socket.version, ops);
			// The mirror stores the names verbatim (the structure carries them
			// un-lowercased); ?raw serializes them lowercased.
			const doc = await fetchDoc(socket, docId);
			for (const [index, name] of names.entries()) {
				const row = doc.struct.find(([, , e]) => e === 20 + index);
				assert.isOk(row, `eid ${20 + index} should be in the structure`);
				assert.equal(row[4], name, `the name ${name.slice(0, 12)} should be stored verbatim`);
			}
			const raw = await httpGet(docId + '/?raw');
			assert.equal(raw.status, 200);
			assert.include(raw.body, '<a:b:c', 'the accepted name should serialize');
			assert.include(raw.body, '<a-b.c_d', 'the accepted name should serialize');
			assert.include(raw.body, '<' + 'x'.repeat(500), 'long names should serialize');
			await serverAlive();
		});

		it('stores an attribute literally named __proto__ (inert data, not a path)', async function() {
			// The json0 era's prototype-pollution corpus was path-based — paths
			// are gone from the wire, and an attribute named __proto__ is just
			// a row in the mirror (the canary in the crash-candidates section
			// still guards against any process-wide leak).
			const docId = freshWebstrateId();
			const socket = await createDocV2(docId);
			const reply = await submitCommit(socket, docId, socket.version, [
				{ k: 'aa', e: 3, i: 0, n: '__proto__', v: 'inert' }]);
			assert.isNotOk(reply.error, 'a __proto__ attribute is plain data');
			const doc = await fetchDoc(socket, docId);
			const proto = doc.state.find((row) => row[2] === '__proto__');
			assert.isOk(proto, 'the attribute should be stored');
			assert.equal(proto[3], 'inert', 'the attribute value should round-trip');
			const cleanup = await submitCommit(socket, docId, doc.v, [
				{ k: 'ar', e: 3, n: '__proto__' }]);
			assert.isNotOk(cleanup.error, 'the attribute should be removable');
			await serverAlive();
		});

		it('stores a 900-level deep sa chain in one commit (no depth limit)', async function() {
			const docId = freshWebstrateId();
			const socket = await createDocV2(docId);
			// The json0/BSON era rejected nesting beyond ~100 levels; the sqlite
			// mirror is flat rows, so a long sa chain is just a long commit.
			const ops = [];
			let parent = 3;
			for (let i = 0; i < 900; i++) {
				const eid = 100 + i;
				ops.push({ k: 'sa', p: parent, i: 0, e: eid, t: 1, n: 'div' });
				parent = eid;
			}
			const reply = await commitShouldApply(socket, docId, socket.version, ops);
			assert.equal(reply.v, socket.version + ops.length + 1,
				'the deep chain should commit as one opid per op');
			const response = await httpGet(docId + '/?raw');
			assert.equal(response.status, 200, `?raw failed: ${response.status}`);
			assert.isAbove(response.body.split('<div').length, 800,
				'the deep chain should serialize');
			await serverAlive();
		});

		it('transforms concurrent commits based on the same revision', async function() {
			const docId = freshWebstrateId();
			const socketA = await createDocV2(docId);
			const socketB = await connect(docId);
			const base = socketA.version;
			// Both commits build on `base`; B lands after A.
			const a = await submitCommit(socketA, docId, base, [
				{ k: 'sa', p: 3, i: 0, e: 10, t: 1, n: 'div' }], 'conc-a');
			assert.isNotOk(a.error, 'the first concurrent commit should apply');
			const b = await submitCommit(socketB, docId, base, [
				{ k: 'aa', e: 3, i: 0, n: 'data-b', v: 'yes' }], 'conc-b');
			assert.isNotOk(b.error, 'the second concurrent commit should apply');
			assert.equal(b.reply.xformed, true, 'the stale-based commit should be transformed');
			const doc = await fetchDoc(socketA, docId);
			assert.isOk(doc.struct.some(([, , e]) => e === 10), 'both changes should be present');
			const raw = await httpGet(docId + '/?raw');
			assert.include(raw.body, 'data-b="yes"', 'the transformed change should be visible');
			await serverAlive();
		});

		it('refuses commits naming another document without an access token', async function() {
			const docIdA = freshWebstrateId();
			const socket = await createDocV2(docIdA);
			const docIdB = freshWebstrateId();
			// A commit naming another document over A's socket must resolve the
			// user through an access token for THAT document; without one it is
			// forbidden with a clean error, whatever the permissions on either
			// document are.
			const reply = await submitCommit(socket, docIdB, 0, [
				{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' }]);
			assert.equal(reply.error, 'Forbidden',
				'a cross-document commit needs a token for that document');
			await serverAlive();
		});

		it('survives double creates without corrupting the document', async function() {
			const docId = freshWebstrateId();
			const socket = await createDocV2(docId, [
				{ k: 'sa', p: 3, i: 0, e: 5, t: 3, n: null },
				{ k: 'aa', e: 5, n: null, v: 'first' }
			]);
			// A second bootstrap commit on the same eids: the sa replays are
			// skipped (the nodes are already attached), so it lands as a
			// one-revision no-op — not a corruption.
			const second = await submitCommit(socket, docId, 0, [
				{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
				{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
				{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' }
			], 'recreate');
			assert.isNotOk(second.error, 'the replayed bootstrap should not error');
			// The legacy create shim refuses a second create outright.
			send(socket, { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz', seq: 2,
				create: { type: 'http://sharejs.org/types/JSONv0', data: ['html', {}, ['body']] } });
			const legacy = await nextMessage(socket, message =>
				message.a === 'op' && message.d === docId && message.seq === 2);
			assert.isOk(legacy.error, 'the legacy create should refuse an existing document');
			assert.include(legacy.error, 'already exists');
			const raw = await httpGet(docId + '/?raw');
			assert.equal(raw.status, 200);
			assert.include(raw.body, 'first', 'the original content should be intact');
			await serverAlive();
		});
	});

	// -------------------------------------------------------------------------
	// 2. `wa` (webstrates action) fuzzing — the custom action layer on the same socket
	// -------------------------------------------------------------------------

	describe('wa actions', function() {
		this.timeout(20000);

		it('survives unknown and malformed wa actions', async function() {
			// Opening the socket IS the subscribe now; the hello proves the
			// join completed before the hostile traffic.
			const socket = await connect();
			await nextMessage(socket, message => message.wa === 'hello' && message.d === webstrateId);
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
			const socket = await createDocV2(docId);
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
			const socket = await createDocV2(docId);
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
			const socket = await createDocV2(docId);
			send(socket, { wa: 'assetSearch', d: docId, token: 'as1', assetName: 'no-such-asset',
				query: {}, limit: -1e15, skip: 'x', sort: { $evil: 1 } });
			const reply = await waReply(socket, 'as1');
			assert.isOk(reply.error, 'assetSearch should reply with a clean error');
			await serverAlive();
		});

		it('refuses anonymous cookie updates and fetches', async function() {
			const docId = freshWebstrateId();
			const socket = await createDocV2(docId);
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
			const socket = await createDocV2(docId);
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
	// 3. Mirror structure fuzzing — ops that store DOM no browser can represent
	// -------------------------------------------------------------------------

	describe('mirror structure fuzzing', function() {
		this.timeout(30000);

		// One shared document that gets progressively more bizarre.
		let docId, socket, version;

		before(async function() {
			docId = freshWebstrateId();
			socket = await createDocV2(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'id', v: 'root' },
				{ k: 'sa', p: 4, i: 0, e: 5, t: 3, n: null },
				{ k: 'aa', e: 5, n: null, v: 'seed' }
			]);
			version = socket.version;
		});

		after(async function() {
			// Every serialization route must still work over the fuzzed document.
			if (!socket) return;
			for (const suffix of ['?raw', '?dl', '?v', '?ops', '?tags', '?assets']) {
				const response = await httpGet(docId + '/' + suffix);
				assert.equal(response.status, 200,
					`GET ${suffix} over the fuzzed document failed: ${response.status}`);
			}
			await serverAlive();
		});

		const apply = async (label, ops) => {
			const reply = await submitCommit(socket, docId, version, ops);
			assert.isNotOk(reply.error, `op "${label}" should apply: ${JSON.stringify(reply.error)}`);
			version = reply.reply.v;
			await serverAlive();
			return reply.reply;
		};

		it('rejects non-string attribute values (HTML-serializable documents only)', async function() {
			// The json0 era let ops store numbers/objects/arrays/null as attribute
			// values — DOM only has strings, and no browser could round-trip such
			// documents. The wire-op grammar rejects them at the door.
			for (const [label, value] of [
				['number', 42],
				['object', { deep: ['er'] }],
				['array', [1, 2, 3]],
				['null', null],
				['false', false],
				['true', true]
			]) {
				const reply = await submitCommit(socket, docId, version,
					[{ k: 'aa', e: 4, i: 0, n: 'bad-' + label, v: value }]);
				assert.isOk(reply.error, `a ${label} attribute value should be rejected`);
			}
			// String values — the only kind the grammar allows — apply, even ones
			// browsers cannot produce through the parser.
			await apply('NaN-ish string', [{ k: 'aa', e: 4, i: 0, n: 'nan-value', v: 'NaN' }]);
		});

		it('binds scalar text and comment content, rejects non-scalars', async function() {
			// Text/comment payloads ride the sa name field into the mirror. The
			// grammar accepts any JSON value there, but the SQL layer only binds
			// scalars: strings, numbers, null and booleans bind (booleans
			// coerce to SQLite integers at PERSISTENCE — the live mirror keeps
			// the JS value until a reload; documented), and objects/arrays
			// fail the parameter binding — a clean error reply with the commit
			// rolled back, never a corruption.
			const applied = [
				['number content', 3, 7, 7],
				['null content', 3, null, null],
				['false content', 3, false, false],
				['number comment', 8, 42, 42]
			];
			for (const [index, [label, type, value, stored]] of applied.entries()) {
				const e = 100 + index;
				await apply(label, [{ k: 'sa', p: 4, i: 1, e, t: type, n: value }]);
				const doc = await fetchDoc(socket, docId);
				const row = doc.struct.find(([, , eid]) => eid === e);
				assert.isOk(row, `the ${label} node should be in the structure`);
				assert.deepEqual(row[4], stored,
					`the ${label} should round-trip (booleans coerce to 0)`);
			}
			for (const [label, type, value] of [
				['object content', 3, { deep: ['er'] }],
				['array content', 3, ['nested']]
			]) {
				const reply = await submitCommit(socket, docId, version,
					[{ k: 'sa', p: 4, i: 1, e: 200, t: type, n: value }]);
				assert.isOk(reply.error, `a ${label} cannot be bound — rejected cleanly`);
			}
			// The failed commits rolled back completely: the doc is intact and
			// still takes further commits at the same version.
			await apply('after binding failures', [{ k: 'aa', e: 4, i: 0, n: 'after', v: 'ok' }]);
		});

		it('stores attribute names from the entire ASCII range and beyond', async function() {
			// Every ASCII control character, punctuation char, and quote — names DOM cannot
			// produce via the HTML parser (which rejects almost all of these).
			const names = [];
			for (let code = 1; code < 128; code++) {
				if (code === 95) continue; // '_' — transport-reserved, rejected below
				names.push(String.fromCharCode(code));
			}
			names.push('quote"attr', 'newline\nattr', 'equal=attr', 'less<attr',
				'slash/attr', 'back\\slash', 'nul\0byte', 'emoji🦄attr',
				'rtl‮override', 'combining áttr', 'tab\tattr', 'colon:attr',
				'CAPS-attr', 'data-auth-ish', 'data-cors-ish', 'x'.repeat(1000));
			const ops = names.map((name, index) =>
				({ k: 'aa', e: 4, i: 0, n: name, v: 'v' + index }));
			await apply('ascii attribute storm', ops);
			// The reserved transport names are refused — they can never enter the
			// mirror and collide with the wire format.
			for (const reserved of ['_', 'data-webstrates-head', 'data-webstrates-type']) {
				const reply = await submitCommit(socket, docId, version,
					[{ k: 'aa', e: 4, i: 0, n: reserved, v: 'x' }]);
				assert.isOk(reply.error, `the reserved name ${reserved} should be rejected`);
			}
		});

		it('stores comment content that breaks out of HTML comments', async function() {
			// Comment content is serialized raw (<!--...-->): a stored `-->` rides
			// into every HTML consumer of ?raw. Documented current behavior — the
			// one stored-injection surface that remains in ?raw output.
			await apply('comment breakout', [
				{ k: 'sa', p: 4, i: 1, e: 20, t: 8, n: null },
				{ k: 'aa', e: 20, n: null, v: 'safe --> injected' }]);
			const response = await httpGet(docId + '/?raw');
			assert.equal(response.status, 200);
			assert.include(response.body, 'safe --> injected',
				'comment content is served raw (documented surface)');
		});

		it('refuses non-JsonML roots through the legacy create shim, cleanly', async function() {
			// The Mongo-era snapshot accepted any JSON as a document; the
			// sqlite ingest requires an actual JsonML root (an array with a
			// string head). Scalar and object roots are refused with a clean
			// error — never stored, never a crash.
			for (const [label, data] of [
				['string', 'just a string'],
				['number', 42],
				['null', null],
				['object', { plain: true }]
			]) {
				const docId = freshWebstrateId();
				const socket = await connect(docId);
				send(socket, { a: 'op', c: 'webstrates', d: docId, v: 0, src: 'fuzz',
					seq: 9, create: { type: 'http://sharejs.org/types/JSONv0', data } });
				const reply = await nextMessage(socket, message =>
					message.a === 'op' && message.d === docId && message.seq === 9);
				assert.equal(reply.error, 'Snapshot must be JsonML.',
					`a ${label} root should be refused`);
				socket.ws.close();
			}
			await serverAlive();
		});

		it('stores structurally impossible documents as prototypes', async function() {
			// Weird-but-JsonML shapes: the legacy create shim ingests them
			// (still the only way to ingest arbitrary shapes from a socket),
			// then they serve and prototype like any document.
			const cases = [
				['attrs-is-number', ['html', 5]],  // the 5 becomes a text child
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
				for (const suffix of ['?raw']) {
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
			// Attribute NAMES are escaped on the way out (the json0 era served them
			// raw, and a `"` inside a name broke out of the HTML quoting that
			// followed it) — the quote-injection surface is closed: hostile names
			// round-trip escaped, not verbatim.
			assert.include(response.body, 'quote&quot;attr=',
				'quote-bearing attribute names are served escaped, not raw');
			assert.include(response.body, 'less&lt;attr=',
				'an attribute name containing < is served escaped');
			assert.include(response.body, '0="v',
				'digit attribute names are stored and served');
			await serverAlive();
		});

		it('serves the fuzzed document to a browser client without dying', async function() {
			// A real browser fetching the page gets the painted HTML and adopts
			// it. Fuzzed structures may break the renderer — the server must
			// survive regardless.
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

			// The roundtrip under the v2 painted transport (verified 2026-09-24):
			//  - Attribute names that cannot survive HTML serialization — control
			//    characters (\x00-\x1f), whitespace, quotes, '=', '>', '/', the empty
			//    name — and the transport-reserved names ('_',
			//    'data-webstrates-head', 'data-webstrates-type') are TRANSIENT
			//    client-side: no op is ever created for them.
			//  - Everything else (letters, digits, ':', '<', '!', DEL, ...) ops
			//    verbatim; the server stores the names raw and ?raw serves them
			//    back (escaped).
			//  - BUT: the receiving page materializes such names through the
			//    legacy rebuild sanitizer (coreUtils.sanitizeString), which is
			//    MORE stringent than the wire grammar — every non-letter/digit/
			//    colon/hyphen/dot start character maps to '_'. The exotic names
			//    therefore COLLIDE into one '_' attribute on the second page
			//    (the last storm value, DEL's 'v127'), while the server holds
			//    them all: a documented client/server disagreement, the same
			//    class the json0 era's storm documented.
			//  - Browsers lowercase attribute names, so 'A'..'Z' collide with
			//    'a'..'z' before any op exists.
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
			assert.isAtLeast(synced.total, 27, 'the serializable survivors should be materialized');
			assert.equal(synced.letters.filter(v => v && v.startsWith('v')).length, 26,
				'all lowercase letter attributes should be on the second page');
			assert.isOk(synced.colon, 'the \':\' attribute is serializable and syncs');
			assert.equal(synced.underscore, 'v127',
				'exotic-but-serializable names (DEL, digits, punctuation) collide into '
				+ 'the rebuild sanitizer\'s \'_\' on the receiving page (documented)');

			// The server stored every op'd name raw: digits, punctuation and <
			// inside attribute names are served back (escaped) in ?raw.
			const response = await httpGet(docId + '/?raw');
			assert.equal(response.status, 200);
			const divLine = response.body.match(/<[dD][iI][vV][^>]*ascii-storm[^>]*>/);
			assert.isOk(divLine, 'the storm element should be stored');
			const storedCount = (divLine[0].match(/="v\d+"/g) || []).length;
			assert.isAtLeast(storedCount, 26,
				'the serializable attribute names should be stored');
			for (const marker of ['0="v48"', '!="v33"', 'a="v97"', '&lt;="v60"']) {
				assert.include(divLine[0], marker,
					'digit/punctuation attribute names are stored and served (escaped)');
			}
			assert.notInclude(divLine[0], String.fromCharCode(2) + '="v2"',
				'control-character attribute names are transient: never stored');
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
			// Digit attribute names from the browser storm are stored and served
			// (escaped where serialization requires it). Control-character names
			// are transient client-side (they cannot ride serialized HTML), so
			// they never reach the server at all.
			assert.include(response.body, '0="v48"',
				'digit attribute names should be stored and served');
			assert.notInclude(response.body, String.fromCharCode(2) + '="v2"',
				'control-character attribute names are transient: never stored');
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

		// The ShareDB-era {a:'op', create} / {a:'s'} steps of the original recipes are
		// gone with the protocol removal (the by-design failures of the
		// websocket-protocol sections above); their v2 equivalents are a base-0
		// bootstrap commit (the shared createDocV2 helper) and the connection
		// itself (opening the socket joins the document — the hello confirms
		// it). Without them, waiting on the old replies would time out and
		// leave this whole crash-candidates section dark.

		const joinV2 = async (socket, docId) => {
			// Opening the socket IS the join now; waiting for the hello
			// proves the subscription completed before the hostile traffic.
			// (The hello may already be far back in the buffer — poll the
			// whole buffer, not the cursored nextMessage.)
			const deadline = Date.now() + 15000;
			for (;;) {
				const hello = socket.messages.find((m) => m && m.wa === 'hello');
				if (hello) {
					assert.equal(hello.d, docId, 'the hello must name the joined document');
					return;
				}
				if (Date.now() > deadline) {
					throw new Error('no hello arrived for ' + docId);
				}
				await sleep(100);
			}
		};

		before(async function() {
			canaryId = 'test-fuzz-canary-' + util.randomString().toLowerCase();
			const socket = await createDocV2(canaryId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'id', v: 'canary' },
				{ k: 'sa', p: 4, i: 0, e: 6, t: 3, n: null },
				{ k: 'aa', e: 6, n: null, v: 'clean' }
			]);
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
				const socket = await createDocV2(crashDocId);
				await joinV2(socket, crashDocId);
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
			const socket = await createDocV2(docId);
			await joinV2(socket, docId);
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
			const socket = await createDocV2(docId);
			await joinV2(socket, docId);
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
			const socket = await createDocV2(docId);
			// A well-formed commit still round-trips.
			send(socket, { wa: 'commit', d: docId, base: socket.version, token: 'alive',
				ops: [
					{ k: 'sa', p: 3, i: 0, e: 100, t: 1, n: 'div' },
					{ k: 'sa', p: 100, i: 0, e: 101, t: 3, n: null },
					{ k: 'aa', e: 101, n: null, v: 'alive' }
				] });
			const reply = await nextMessage(socket, (message) =>
				message.wa === 'reply' && message.token === 'alive');
			assert.isNotOk(reply.reply && reply.reply.error,
				`well-formed commit failed: ${JSON.stringify(reply.reply)}`);
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
