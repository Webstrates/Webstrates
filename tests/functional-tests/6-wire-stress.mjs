// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */

import zlib from 'node:zlib';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Protocol stress for the v2 wire: the same intent as the fuzzing suite —
// hammer the server from raw sockets with hostile input and concurrent
// writers, then prove the end-result is sane — but against the CURRENT
// protocol:
//   - attributes are addressed by (eid, LOCAL position): aa inserts at i
//     (clamped), updates an existing name in place, ar by name or position;
//   - text/comment content is eid-only (aa {n: null, v}, si/sd without i);
//   - `_` is a trailing unquoted eid on every element of the painted wire.
//
// What each section locks in:
//   1. early frames: a fresh socket bursting commit + allocids
//      before any round trip must get every reply (the v2 equivalent of the
//      removed ShareDB 'early frames' recipe); the connection itself is the
//      subscribe (hello with the head revision, frames without a d).
//   2. append races: two writers inserting at the same local position from
//      the same base — committed-first keeps the slot, the stale commit
//      transforms BEHIND it (xformed), the final rows are dense and ordered.
//   3. hostile positions: insert i:0/mid/999, si/sd with out-of-range i and q
//      — clamped or warn-skipped, never an error, positions stay dense.
//   4. position semantics under concurrent removal: a stale si at a slot
//      removed concurrently voids; at a later slot it SHIFTS and lands in
//      the attribute that moved into the slot.
//   5. text races: stale si/sd at the same q converge by
//      committed-first-wins-left.
//   6. random op storm: three sockets, stale bases by construction, random
//      sa/sr/aa/ar/si/sd — every commit acks without error, the server
//      survives, fetchStructure returns a closed, dense structure, getOps
//      replays monotone, and a real browser adopts the painted page with
//      ZERO fetchStructure/?json fallbacks.
//
// The suite runs its own server instance (own port, own pid) so crash
// candidates cannot take out a server shared with other suites.
describe('Wire stress (v2 local-position protocol)', function() {
	this.timeout(60000);

	const sockets = [];
	const webstrateId = 'test-' + util.randomString();
	let ownServer;
	let serverAddress;
	let browser;

	// -------------------------------------------------------------------------
	// Infrastructure helpers (mirroring 5-fuzzing.mjs)
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

	// Wait up to `timeout` seconds for a message that matches; a per-socket
	// cursor keeps replies findable after bursts, and never returns one twice.
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
			if (Date.now() > endAt) {
				return reject(new Error('timed out waiting for a message; buffered: '
					+ socket.messages.slice(0, 8).map((m) => JSON.stringify(m).slice(0, 120))
						.join(' | ')));
			}
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

	// -------------------------------------------------------------------------
	// v2 protocol helpers
	// -------------------------------------------------------------------------

	let seq = 0;
	const nextToken = () => `ws${++seq}`;

	// Submit one commit over a socket; resolves with the server's reply
	// ({ reply: { v, firstOpid, xformed } } or { error }). The document is the
	// socket's own URL — no id rides the message.
	const commit = async (socket, docId, base, ops, timeout = 10) => {
		const token = nextToken();
		send(socket, { wa: 'commit', base, token, ops });
		const reply = await nextMessage(socket,
			message => message.wa === 'reply' && message.token === token, timeout);
		if (reply.reply) socket.version = reply.reply.v;
		return reply;
	};

	// The CURRENT head revision, as a plain round trip. The old way was the
	// dsubscribe reply (the explicit subscribe is gone — opening the socket
	// is the subscription now); fetchStructure's reply carries the same
	// number ({v, struct, state}). Also updates socket.version.
	const headOf = async (socket) => {
		const structure = await fetchStructure(socket);
		assert.typeOf(structure.v, 'number', 'the head revision must be a number');
		socket.version = structure.v;
		return structure.v;
	};

	// Allocate a block of ids from the document's global counter.
	const allocBlock = async (socket, docId, count) => {
		const token = nextToken();
		send(socket, { wa: 'allocids', count, token });
		const reply = await nextMessage(socket,
			message => message.wa === 'reply' && message.token === token);
		assert.isNotOk(reply.error, 'allocids rejected: ' + JSON.stringify(reply.error));
		return reply.reply; // { start, end } inclusive
	};

	// fetchStructure over the websocket: the reply is a single binary frame
	// [0x01][tokenLen][token][brotli payload] decoding to
	// { v, struct: [[p, i, e, t, n]], state: [[e, i, n, v]] } — the state
	// rows arrive in the mirror's per-element attribute order, so their
	// positions ARE the local-position protocol on the server side.
	const fetchStructure = (socket, docId) => new Promise((resolve, reject) => {
		const token = nextToken();
		const onData = (data) => {
			if (!Buffer.isBuffer(data) || data[0] !== 1 || data[1] !== token.length) return;
			const got = data.subarray(2, 2 + data[1]).toString('utf8');
			if (got !== token) return;
			socket.ws.removeListener('message', onData);
			try {
				resolve(JSON.parse(zlib.brotliDecompressSync(
					data.subarray(2 + data[1])).toString('utf8')));
			} catch (err) { reject(err); }
		};
		socket.ws.on('message', onData);
		send(socket, { wa: 'fetchStructure', token });
	});

	// The commit log over the websocket.
	const getOps = async (socket, docId, from = 0) => {
		const token = nextToken();
		send(socket, { wa: 'getOps', from, token });
		const reply = await nextMessage(socket,
			message => message.wa === 'reply' && message.token === token);
		assert.isNotOk(reply.error, 'getOps rejected: ' + JSON.stringify(reply.error));
		return reply.reply;
	};

	// Create a document with the base-0 bootstrap (html eid 1, head 2, body 3)
	// plus extra ops, on a socket of its own.
	const createDoc = async (docId, extraOps = []) => {
		const socket = await connect(docId);
		const reply = await commit(socket, docId, 0, [
			{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
			{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
			{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' },
			...extraOps
		]);
		assert.isNotOk(reply.error, `could not create ${docId}: ${JSON.stringify(reply)}`);
		assert.isAbove(socket.version, 0);
		return socket;
	};

	// State rows of one eid, in arrival (mirror attribute) order.
	const attrsOf = (structure, eid) =>
		structure.state.filter((row) => row[0] === eid);
	const contentOf = (structure, eid) => {
		const row = structure.state.find(([e, , n]) => e === eid && n === null);
		return row ? row[3] : null;
	};

	// Sane-end-result invariants over a fetchStructure payload: the struct is
	// closed (no kids referencing unknown eids, no orphans off the root), and
	// every element's attribute rows come out dense 0..k-1 in order — the
	// local-position protocol requires exactly that, since the DOM's own
	// attribute list is the client's position map.
	const assertStructureSane = (structure) => {
		const eids = new Set(structure.struct.map(([, , e]) => e));
		eids.add(1); // html (root kid; struct rows list children, root itself is 0)
		assert.isAtLeast(structure.struct.length, 3, 'the base tree collapsed');
		for (const [p, , e] of structure.struct) {
			assert(Number.isInteger(e), `struct row carries non-integer eid ${e}`);
			assert(eids.has(p) || p === 0, `row for eid ${e} has unknown parent ${p}`);
		}
		// Root closure: everything reachable from 0.
		const byParent = new Map();
		for (const [p, i, e] of structure.struct) {
			const kids = byParent.get(p) || [];
			kids[i] = e;
			byParent.set(p, kids);
		}
		const seen = new Set();
		const walk = (p) => {
			for (const e of (byParent.get(p) || [])) {
				if (e === undefined || seen.has(e)) continue;
				seen.add(e);
				walk(e);
			}
		};
		walk(0);
		for (const e of eids) {
			assert(seen.has(e), `eid ${e} is not reachable from the document root`);
		}
		// Dense local positions per element, in row order.
		const positions = new Map();
		for (const [e, i] of structure.state) {
			const list = positions.get(e) || [];
			assert.equal(i, list.length,
				`eid ${e} state rows are not dense (got ${i} after ${list.length})`);
			list.push(i);
			positions.set(e, list);
		}
		// A text/comment node carries at most one state row (its content).
		for (const [, , e, t] of structure.struct) {
			if (t === 3 || t === 8) {
				const rows = positions.get(e) || [];
				assert.isAtMost(rows.length, 1,
					`text/comment eid ${e} has ${rows.length} state rows`);
			}
		}
	};

	before(async function() {
		this.timeout(30000);
		if (process.env.WEBSTRATES_HARNESS_STATE) {
			const harness = await import('../lib/server-harness.mjs');
			ownServer = await harness.startServer({ label: 'wirestress', port: 7188 });
			serverAddress = ownServer.address;
			console.log(`wire-stress server: ${serverAddress} (pid ${ownServer.child.pid})`);
		} else {
			serverAddress = config.server_address;
		}
		browser = await puppeteer.launch();
	});

	after(async function() {
		sockets.forEach(({ ws }) => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
		if (browser) await browser.close();
		if (ownServer) await ownServer.stop();
	});

	// -------------------------------------------------------------------------
	// 1. Early frames on a fresh socket
	// -------------------------------------------------------------------------

	it('subscribes the connection itself: hello on open, frames without a d',
		async function() {
			const docId = 'test-ws-autojoin-' + util.randomString().toLowerCase();
			const writer = await connect(docId);
			await commit(writer, docId, 0, [
				{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
				{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
				{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' }
			]);

			// A socket that merely connects — no subscribe, nothing sent —
			// must receive the hello carrying the document id and the head
			// revision, and every commit frame after it, none of which names
			// the document (the socket's URL already does).
			const reader = await connect(docId);
			const hello = await nextMessage(reader,
				(message) => message.wa === 'hello', 10);
			assert.equal(hello.d, docId, 'the hello carries the document id');
			assert.typeOf(hello.v, 'number', 'the hello carries the head revision');
			assert.equal(hello.v, writer.version,
				'the hello revision is the document head');

			const ack = await commit(writer, docId, hello.v,
				[{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' }]);
			assert.isNotOk(ack.error);
			const frame = await nextMessage(reader, (message) => message.wa === 'ops');
			assert.equal(frame.v, writer.version, 'the frame carries the new head');
			assert.notProperty(frame, 'd', 'frames for the socket\'s own document carry no d');
		});

	it('answers a burst of commit + allocids sent before any round trip',
		async function() {
			const docId = 'test-ws-early-' + util.randomString().toLowerCase();
			const socket = await connect(docId);
			// A reply poll over the WHOLE buffer: tokens are unique, and the
			// burst's replies may arrive in any order, so the cursored
			// nextMessage — which never looks back — would be wrong here.
			const awaitReply = (token, timeout = 15) => new Promise((resolve, reject) => {
				const endAt = Date.now() + timeout * 1000;
				(function check() {
					const found = socket.messages.find(
						(m) => m.wa === 'reply' && m.token === token);
					if (found) return resolve(found);
					if (socket.closeCode !== undefined) {
						return reject(new Error(`connection closed (${socket.closeCode})`));
					}
					if (Date.now() > endAt) {
						return reject(new Error('no reply for ' + token
							+ '; buffered: ' + socket.messages
							.map((m) => JSON.stringify(m).slice(0, 100)).join(' | ')));
					}
					setTimeout(check, 50);
				})();
			});
			// Send everything before waiting for anything: all must be
			// processed and answered on a socket the server has never seen.
			// (The join itself needs no message — the connection did it.)
			const t2 = nextToken(), t3 = nextToken();
			send(socket, { wa: 'commit', base: 0, token: t2, ops: [
				{ k: 'sa', p: 0, i: 0, e: 1, t: 1, n: 'html' },
				{ k: 'sa', p: 1, i: 0, e: 2, t: 1, n: 'head' },
				{ k: 'sa', p: 1, i: 1, e: 3, t: 1, n: 'body' }
			] });
			send(socket, { wa: 'allocids', count: 4, token: t3 });
			const [created, block] = await Promise.all(
				[awaitReply(t2), awaitReply(t3)]);
			// The hello rides the same guarded window as the burst (it is
			// sent during the connection setup), so it may land before or
			// after the replies — but it must arrive, naming this document.
			const hello = await nextMessage(socket, (m) => m.wa === 'hello', 15);
			assert.equal(hello.d, docId, 'the hello names the joined document');
			assert.oneOf(hello.v, [0, created.reply.v],
				'the hello revision is pre- or post-burst, whichever met it');
			assert.isNotOk(created.error, 'the early commit failed: ' + JSON.stringify(created));
			assert.isAbove(created.reply.v, 0);
			assert.isNotOk(block.error, 'the early allocids failed: ' + JSON.stringify(block));
			// The raw base-0 bootstrap commits eids 1-3 without drawing from
			// the pool (the real client allocates first), so the counter may
			// still sit at 0 — the reply must be a well-formed inclusive block.
			assert.isAtLeast(block.reply.start, 1);
			assert.equal(block.reply.end - block.reply.start, 3, 'inclusive block of 4');
			await serverAlive();
		});

	// -------------------------------------------------------------------------
	// 2. Concurrent same-position inserts
	// -------------------------------------------------------------------------

	it('keeps the committed-first insert at its slot and shifts the stale one behind it',
		async function() {
			const docId = 'test-ws-append-' + util.randomString().toLowerCase();
			await createDoc(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'data-a', v: 'a0' }
			]);

			const a = await connect(docId);
			const b = await connect(docId);
			await headOf(a);
			const base = await headOf(b);
			assert.equal(base, a.version, 'both writers must share the same base');

			// A commits an insert at the end slot (i:1); B still holds `base`.
			const ackA = await commit(a, docId, base, [
				{ k: 'aa', e: 4, i: 1, n: 'data-first', v: 'A' }
			]);
			assert.isNotOk(ackA.error, 'commit A failed: ' + JSON.stringify(ackA));
			assert.notEqual(ackA.reply.xformed, true, 'commit A was based on head');
			// v = revision + 1 (first opid) + effective ops (the commit row
			// gets its own opid), so a 1-op insert bumps the revision by 2.
			assert.equal(ackA.reply.v, base + 2, 'the insert commit must bump the revision');

			// B inserts at the SAME slot from the stale base: the transform
			// must move it behind A's (committed-first wins the left slot).
			const ackB = await commit(b, docId, base, [
				{ k: 'aa', e: 4, i: 1, n: 'data-second', v: 'B' }
			]);
			assert.isNotOk(ackB.error, 'commit B failed: ' + JSON.stringify(ackB));
			assert.equal(ackB.reply.xformed, true, 'commit B must have been transformed');
			assert.isAbove(ackB.reply.v, ackA.reply.v, 'commit B must land after A');

			const structure = await fetchStructure(a, docId);
			assertStructureSane(structure);
			const rows = attrsOf(structure, 4);
			assert.deepEqual(rows.map((row) => row[2]),
				['data-a', 'data-first', 'data-second'],
				`the final order should be committed-first then stale: ${JSON.stringify(rows)}`);
			assert.deepEqual(rows.map((row) => row[1]), [0, 1, 2],
				'the positions must be dense 0..2');

			// A truly simultaneous pair: order is either way, but the result
			// must stay dense and contain both.
			const c = await connect(docId);
			const d = await connect(docId);
			const base2 = await headOf(c);
			assert.equal(await headOf(d), base2);
			// Fire both without awaiting: a genuine arrival race.
			const cDone = commit(c, docId, base2,
				[{ k: 'aa', e: 4, i: 3, n: 'data-c', v: 'C' }]);
			const dDone = commit(d, docId, base2,
				[{ k: 'aa', e: 4, i: 3, n: 'data-d', v: 'D' }]);
			const [ackC, ackD] = [await cDone, await dDone];
			assert.isNotOk(ackC.error, 'race C failed: ' + JSON.stringify(ackC));
			assert.isNotOk(ackD.error, 'race D failed: ' + JSON.stringify(ackD));

			const structure2 = await fetchStructure(a, docId);
			assertStructureSane(structure2);
			const rows2 = attrsOf(structure2, 4);
			assert.deepEqual(rows2.map((row) => row[1]), [0, 1, 2, 3, 4],
				'both racing inserts must land with dense positions');
			const names2 = rows2.map((row) => row[2]);
			assert.includeMembers(names2, ['data-c', 'data-d']);
			assert.includeMembers(names2.slice(0, 3),
				['data-a', 'data-first', 'data-second'],
				'the pre-race order must be preserved');
			const at3 = names2[3];
			const firstOfRace = [ackC, ackD]
				.find((ack) => ack.reply && ack.reply.v === Math.min(ackC.reply.v, ackD.reply.v));
			assert.isOk(firstOfRace, 'both race commits acked');
			assert.equal(at3, firstOfRace === ackC ? 'data-c' : 'data-d',
				`the winner (${at3}) must hold the earlier slot — got ${JSON.stringify(names2)}`);
			await serverAlive();
		});

	// -------------------------------------------------------------------------
	// 3. Hostile positions
	// -------------------------------------------------------------------------

	it('clamps hostile insert positions and absorbs hostile string targets without errors',
		async function() {
			const docId = 'test-ws-hostile-' + util.randomString().toLowerCase();
			await createDoc(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'data-keep', v: 'kept' },
				{ k: 'sa', p: 4, i: 0, e: 5, t: 3, n: null },
				{ k: 'aa', e: 5, n: null, v: 'hostility' }
			]);
			const socket = await connect(docId);
			await headOf(socket);

			// One commit mixing every degenerate address the protocol defines:
			// front insert, far-past-the-end insert, mid insert, an si whose
			// attribute slot does not exist, an sd whose q is past the end,
			// and an ar addressing a position on the text node (its content is
			// never an element attribute).
			const reply = await commit(socket, docId, socket.version, [
				{ k: 'aa', e: 4, i: 0, n: 'data-front', v: 'F' },
				{ k: 'aa', e: 4, i: 999, n: 'data-end', v: 'E' },
				{ k: 'aa', e: 4, i: 2, n: 'data-mid', v: 'M' },
				{ k: 'si', e: 4, i: 999, q: 0, v: 'X' },
				{ k: 'sd', e: 5, q: 999, v: 'y' },
				{ k: 'ar', e: 5, i: 0 },
				{ k: 'si', e: 5, q: 99, v: '!' }
			]);
			assert.isNotOk(reply.error, 'hostile commit must not error: ' + JSON.stringify(reply));

			const structure = await fetchStructure(socket, docId);
			assertStructureSane(structure);
			const rows = attrsOf(structure, 4);
			// data-front at 0, data-keep shifts to 1, data-mid clamped between
			// them at 2 (insert at 2 of [front, keep] lands at the end → 2),
			// data-end clamps to the end.
			assert.deepEqual(rows.map((row) => row[2]),
				['data-front', 'data-keep', 'data-mid', 'data-end'],
				`hostile positions must clamp into dense order: ${JSON.stringify(rows)}`);
			// The out-of-slot si was skipped; the sd with q past the end
			// skipped; the text content untouched except the clamped trailing
			// si (q clamps to the end).
			assert.equal(contentOf(structure, 5), 'hostility!',
				'only the end-clamped si may touch the text node');
			await serverAlive();

			// The legacy ?raw JsonML serialization still serves the content,
			// and the painted page (GET /<id>/) carries the v2 wire: the text
			// rides with its bare <eid>_ prefix and no carrier elements leak.
			const raw = await httpGet(docId + '/?raw');
			assert.equal(raw.status, 200);
			assert.include(raw.body, 'data-front',
				'the legacy ?raw serialization must still serve the result');
			const paint = await httpGet(docId + '/');
			assert.equal(paint.status, 200);
			assert.include(paint.body, 'data-front', 'the paint must serialize the result');
			assert.match(paint.body, /(\d+)_hostility!/,
				'text nodes must ride with their bare <eid>_ prefix');
			assert.notInclude(paint.body, '<w ',
				'no carrier elements may leak into the paint');
		});

	// -------------------------------------------------------------------------
	// 4. Position ops under concurrent removal
	// -------------------------------------------------------------------------

	it('shifts stale position-addressed si over a concurrent removal and voids the exact slot',
		async function() {
			const docId = 'test-ws-void-' + util.randomString().toLowerCase();
			// Two elements: one where the si targets a LATER slot than the one
			// removed (shift), one where it targets the EXACT removed slot
			// (void).
			await createDoc(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'data-a', v: 'AA' },
				{ k: 'aa', e: 4, i: 1, n: 'data-b', v: 'BB' },
				{ k: 'aa', e: 4, i: 2, n: 'data-c', v: 'CC' },
				{ k: 'sa', p: 3, i: 1, e: 6, t: 1, n: 'div' },
				{ k: 'aa', e: 6, i: 0, n: 'data-a', v: 'AA2' },
				{ k: 'aa', e: 6, i: 1, n: 'data-b', v: 'BB2' },
				{ k: 'aa', e: 6, i: 2, n: 'data-c', v: 'CC2' }
			]);

			const a = await connect(docId);
			const b = await connect(docId);
			await headOf(a);
			const base = await headOf(b);
			assert.equal(base, a.version);

			// A removes data-b (slot 1) on BOTH elements in one commit.
			const ackA = await commit(a, docId, base, [
				{ k: 'ar', e: 4, n: 'data-b' },
				{ k: 'ar', e: 6, n: 'data-b' }
			]);
			assert.isNotOk(ackA.error, 'removal failed: ' + JSON.stringify(ackA));

			// B, still on `base`, targets slot 2 (data-c) on eid 4 — after A's
			// removal data-c sits at slot 1, so the si must SHIFT and edit
			// data-c. On eid 6 it targets slot 1 (the removed data-b): void.
			const ackB = await commit(b, docId, base, [
				{ k: 'si', e: 4, i: 2, q: 0, v: 'X' },
				{ k: 'si', e: 6, i: 1, q: 0, v: 'Y' }
			]);
			assert.isNotOk(ackB.error, 'stale si commit failed: ' + JSON.stringify(ackB));
			assert.equal(ackB.reply.xformed, true, 'the stale si must have been transformed');

			const structure = await fetchStructure(a, docId);
			assertStructureSane(structure);
			const rows4 = attrsOf(structure, 4);
			assert.deepEqual(rows4.map((row) => row[2]), ['data-a', 'data-c'],
				'eid 4 should be [data-a, data-c] after the removal');
			assert.equal(rows4[1][3], 'XCC',
				`the shifted si must edit data-c (XCC), got ${JSON.stringify(rows4)}`);
			const rows6 = attrsOf(structure, 6);
			assert.deepEqual(rows6.map((row) => row[2]), ['data-a', 'data-c'],
				'eid 6 should be [data-a, data-c] after the removal');
			assert.equal(rows6[1][3], 'CC2',
				`the voided si must not edit anything (CC2), got ${JSON.stringify(rows6)}`);

			// The history log (getOps) must carry both commits in order.
			const log = await getOps(a, docId, base);
			assert.isAtLeast(log.length, 2);
			for (let i = 1; i < log.length; i++) {
				assert.isAbove(log[i].v, log[i - 1].v, 'the log must be monotone');
			}
			await serverAlive();
		});

	// -------------------------------------------------------------------------
	// 5. Text races
	// -------------------------------------------------------------------------

	it('converges stale text si/sd at the same position by committed-first-wins',
		async function() {
			const docId = 'test-ws-text-' + util.randomString().toLowerCase();
			await createDoc(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 3, n: null },
				{ k: 'aa', e: 4, n: null, v: 'abc' }
			]);

			const a = await connect(docId);
			const b = await connect(docId);
			await headOf(a);
			const base = await headOf(b);

			// A types 'X' at q:1 → 'aXbc'. B, on the stale base, deletes the
			// 'b' at q:1 → the transform must move its q past A's insert and
			// delete the 'b' (not the 'X').
			const ackA = await commit(a, docId, base,
				[{ k: 'si', e: 4, q: 1, v: 'X' }]);
			assert.isNotOk(ackA.error);
			const ackB = await commit(b, docId, base,
				[{ k: 'sd', e: 4, q: 1, v: 'b' }]);
			assert.isNotOk(ackB.error);
			assert.equal(ackB.reply.xformed, true, 'the stale delete must have been transformed');

			const structure = await fetchStructure(a, docId);
			assertStructureSane(structure);
			assert.equal(contentOf(structure, 4), 'aXc',
				'the concurrent insert must survive the transformed delete ('
				+ JSON.stringify(contentOf(structure, 4)) + ')');

			// Same race in the opposite order (delete commits first): the
			// stale insert must shift left behind it. Seed a second text
			// node with a regular commit (the document already exists).
			const c = await connect(docId);
			await headOf(c);
			const seed = await commit(c, docId, c.version, [
				{ k: 'sa', p: 3, i: 1, e: 5, t: 3, n: null },
				{ k: 'aa', e: 5, n: null, v: 'abc' }
			]);
			assert.isNotOk(seed.error, 'seeding failed: ' + JSON.stringify(seed));
			const base2 = c.version;
			const d = await connect(docId);
			await headOf(d);
			const ackD = await commit(d, docId, base2,
				[{ k: 'sd', e: 5, q: 1, v: 'b' }]);
			assert.isNotOk(ackD.error);
			const ackC = await commit(c, docId, base2,
				[{ k: 'si', e: 5, q: 2, v: 'X' }]);
			assert.isNotOk(ackC.error);
			assert.equal(ackC.reply.xformed, true);

			const structure2 = await fetchStructure(a, docId);
			assert.equal(contentOf(structure2, 5), 'aXc',
				`delete-first must converge the same way: ${JSON.stringify(contentOf(structure2, 5))}`);
			await serverAlive();
		});

	// -------------------------------------------------------------------------
	// 6. Random op storm
	// -------------------------------------------------------------------------

	it('converges a random op storm from three concurrent sockets into a loadable document',
		async function() {
			this.timeout(120000);
			const docId = 'test-ws-storm-' + util.randomString().toLowerCase();
			const storm = await createDoc(docId, [
				{ k: 'sa', p: 3, i: 0, e: 4, t: 1, n: 'div' },
				{ k: 'aa', e: 4, i: 0, n: 'class', v: 'storm' },
				{ k: 'sa', p: 4, i: 0, e: 5, t: 3, n: null },
				{ k: 'aa', e: 5, n: null, v: 'storm-text' }
			]);
			await headOf(storm);

			const writers = [storm];
			for (let i = 0; i < 2; i++) {
				const socket = await connect(docId);
				await headOf(socket);
				socket.block = await allocBlock(socket, docId, 512);
				socket.cursor = socket.block.start;
				socket.version = storm.version;
				writers.push(socket);
			}
			storm.block = await allocBlock(storm, docId, 512);
			storm.cursor = storm.block.start;

			// Storm-reachable element and text eids (approximate: removals may
			// kill them and ops then warn-skip — that is the stress).
			const ELEMENTS = ['div', 'span', 'p', 'b', 'u', 'section', 'li'];
			const ATTRS = ['class', 'title', 'data-x', 'data-n', 'id'];
			const rand = (n) => Math.floor(Math.random() * n);
			const randText = () => Math.random().toString(36).slice(2, 8);
			const elementEids = [1, 2, 3, 4];
			const textEids = [5];

			const mint = (socket) => (socket.cursor <= socket.block.end
				? socket.cursor++ : null);
			const parentEid = () => elementEids[rand(elementEids.length)];

			const genSa = (socket) => {
				const e = mint(socket);
				if (e === null) return null;
				const roll = rand(10);
				if (roll < 7) {
					const op = { k: 'sa', p: parentEid(), i: rand(4), e, t: 1,
						n: ELEMENTS[rand(ELEMENTS.length)] };
					elementEids.push(e);
					return op;
				}
				const t = roll < 9 ? 3 : 8;
				textEids.push(e);
				return [{ k: 'sa', p: parentEid(), i: rand(4), e, t, n: null },
					{ k: 'aa', e, n: null, v: randText() }];
			};
			const genOp = (socket) => {
				switch (rand(12)) {
					case 0: case 1: return genSa(socket);
					case 2: {
						// Structural removal: only ids the storm minted (never
						// the html/head/body skeleton).
						const eligible = elementEids.filter((e) => e > 5);
						const victim = eligible[rand(eligible.length)];
						return victim ? { k: 'sr', p: parentEid(), e: victim } : null;
					}
					case 3: case 4: case 5: {
						const e = elementEids[rand(elementEids.length)];
						if (rand(2) === 0) {
							return { k: 'aa', e, i: rand(5),
								n: ATTRS[rand(ATTRS.length)], v: randText() };
						}
						const t = textEids[rand(textEids.length)];
						return { k: 'aa', e: t, n: null, v: randText() };
					}
					case 6: {
						const e = elementEids[rand(elementEids.length)];
						return rand(2) === 0
							? { k: 'ar', e, n: ATTRS[rand(ATTRS.length)] }
							: { k: 'ar', e, i: rand(4) };
					}
					case 7: case 8: {
						const t = textEids[rand(textEids.length)];
						return rand(2) === 0
							? { k: 'si', e: t, q: rand(10), v: randText().slice(0, 3) }
							: { k: 'sd', e: t, q: rand(10), v: randText().slice(0, 2) };
					}
					case 9: {
						const e = elementEids[rand(elementEids.length)];
						return { k: 'si', e, i: rand(4), q: rand(4), v: randText().slice(0, 2) };
					}
					default: return null;
				}
			};

			// Eight rounds: every writer commits 1-3 ops per round based on
			// ITS last acked revision — after the first round every base is
			// stale by construction, so the server-side OT runs on nearly
			// every commit.
			const ROUNDS = 8;
			let xformedCount = 0;
			for (let round = 0; round < ROUNDS; round++) {
				const sent = [];
				for (const socket of writers) {
					const ops = [];
					while (ops.length < 1 + rand(3)) {
						const op = genOp(socket);
						if (!op) continue;
						ops.push(...(Array.isArray(op) ? op : [op]));
					}
					// Fire without awaiting: the bases race.
					sent.push(commit(socket, docId, socket.version, ops));
				}
				const acks = await Promise.all(sent);
				for (const ack of acks) {
					assert.isNotOk(ack.error, `storm commit rejected: ${JSON.stringify(ack)}`);
					if (ack.reply && ack.reply.xformed === true) xformedCount++;
				}
				await serverAlive();
			}
			assert.isAbove(xformedCount, ROUNDS,
				'the storm must have forced real transforms (stale bases), not fresh ones');

			// ---- the end-result must be sane ---------------------------------
			const structure = await fetchStructure(storm, docId);
			assertStructureSane(structure);
			assert.isAbove(structure.struct.length, 5,
				'the storm should have grown the tree beyond the seeded one');

			// Most storm ops update in place (same names, same text nodes),
			// so the honest "it did work" metric is the effective-op count
			// in the log, not the number of state rows.
			const log = await getOps(storm, docId, 0);
			assert.isAbove(log.length, ROUNDS, 'the commit log must record the storm');
			for (let i = 1; i < log.length; i++) {
				assert.isAbove(log[i].v, log[i - 1].v, 'the log must be strictly monotone');
			}
			const effectiveOps = log.reduce((sum, entry) => sum + entry.ops.length, 0);
			assert.isAbove(effectiveOps, 20,
				`the storm must have landed effective ops (only ${effectiveOps})`);

			// The paint serves, with the v2 wire artifacts only: the head
			// marker rides <head_> exactly once, text nodes carry their bare
			// <eid>_ prefix, and no carrier elements leak. (The storm may
			// rewrite the seeded text, so only shape — not values — is
			// asserted here; the browser check below is the content check.)
			const paint = await httpGet(docId + '/');
			assert.equal(paint.status, 200);
			assert.match(paint.body, />[0-9]+_/,
				'text nodes must ride the paint with their <eid>_ prefix');
			assert.notInclude(paint.body, '<w ', 'no carrier elements in the paint');
			assert.equal(paint.body.split('data-webstrates-head').length - 1, 1,
				'the head marker must appear exactly once (on <head_>)');

			// And a real browser adopts the painted storm document with zero
			// fallbacks — the strongest end-to-end sanity statement.
			const page = await browser.newPage();
			const frames = [];
			const jsonRequests = [];
			const cdp = await page.createCDPSession();
			await cdp.send('Network.enable');
			cdp.on('Network.webSocketFrameSent', (p) => {
				try { frames.push(String(p.response.payloadData)); } catch { /* gone */ }
			});
			cdp.on('Network.requestWillBeSent', (p) => {
				if (String(p.request.url).includes('?json')) jsonRequests.push(p.request.url);
			});
			const errors = [];
			page.on('pageerror', (err) => errors.push(String(err)));
			await page.goto(serverAddress + docId + '/', { waitUntil: 'load', timeout: 45000 });
			await page.waitForFunction(
				() => window.webstrate && window.webstrate.loaded === true,
				{ timeout: 45000, polling: 50 });
			const adopted = await page.evaluate(() => ({
				underscoreAttrs: document.querySelectorAll('[_]').length,
				headMarker: !!document.querySelector('head_'),
				kids: document.body.children.length
			}));
			assert.isAbove(adopted.kids, 0, 'the storm document should have body content');
			assert.equal(adopted.underscoreAttrs, 0, '_ attributes left in the adopted DOM');
			assert.equal(adopted.headMarker, false, 'head_ element left behind');
			assert.equal(frames.filter((f) => f.includes('fetchStructure')).length, 0,
				'fetchStructure on a storm document load');
			assert.equal(jsonRequests.length, 0, '?json requested on a storm document load');
			assert.equal(errors.length, 0, errors.join(' ; '));
			await page.close();
			await serverAlive();
		});
});
