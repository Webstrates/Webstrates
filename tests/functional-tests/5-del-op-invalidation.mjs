// Deleting a webstrate must invalidate everything keyed to it.
//
// History: the ShareDB del op carried no op components, so the old
// afterWrite hook's changesPermissions(op.op) threw a TypeError after the
// delete had already been committed — the del acknowledgement never
// arrived, and the permission-cache entry and access tokens of the deleted
// document were never invalidated. That fix lived in the submit pipeline;
// when deletion moved to the plain HTTP ?delete route (the custom 'wa'
// protocol has no del action), the invalidation had to move with it —
// deleteWebstrate now expires the cached permissions and every outstanding
// access token of the document.
//
// These tests fail on unfixed code: the document is gone but the stale
// token's websocket is accepted instead of being closed with 1002
// "Invalid access token."

import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Deletion invalidation', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const wsAddress = config.server_address.replace(/^http/, 'ws') + webstrateId;
	const docUrl = config.server_address + webstrateId + '/';
	let token;

	// Send a message and resolve the next reply carrying that token.
	const sendAndAwaitReply = (ws, message) => new Promise((resolve, reject) => {
		const on = (data) => {
			const parsed = JSON.parse(data.toString());
			if (parsed.token === message.token) {
				ws.off('message', on);
				resolve(parsed);
			}
		};
		ws.on('message', on);
		ws.on('error', reject);
		ws.send(JSON.stringify(message));
	});

	// Connect a websocket with the access token. Resolves null if the connection
	// is accepted (stays open), or {code, reason} for the close frame otherwise.
	const connectWithToken = () => new Promise((resolve) => {
		const ws = new WebSocket(wsAddress + '?token=' + token);
		const timer = setTimeout(() => {
			try { ws.close(); } catch { /* already closed */ }
			resolve(null);
		}, 5000);
		ws.on('close', (code, reason) => {
			clearTimeout(timer);
			resolve({ code, reason: reason ? reason.toString() : '' });
		});
		ws.on('error', () => { /* rejections surface as a close frame */ });
	});

	before(async function() {
		// Seed the webstrate through the legacy create shim — a document
		// exists once its first commit lands (the same way old tooling and
		// the fuzz suite seed documents).
		const ws = new WebSocket(wsAddress);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		const create = { a: 'op', c: 'webstrates', d: webstrateId, v: 0, seq: 1,
			create: { type: 'http://sharejs.org/types/JSONv0',
				data: ['html', {}, ['head'], ['body', {}, 'seeded']] } };
		ws.send(JSON.stringify(create));
		await new Promise((resolve, reject) => {
			const on = (data) => {
				const parsed = JSON.parse(data.toString());
				if (parsed.a === 'op' && parsed.d === webstrateId && !parsed.error) {
					ws.off('message', on);
					resolve(parsed);
				} else if (parsed.a === 'op' && parsed.d === webstrateId && parsed.error) {
					ws.off('message', on);
					reject(new Error('legacy create failed: ' + parsed.error));
				}
			};
			ws.on('message', on);
		});
		ws.close();

		// Issue an access token (POST token=<seconds>) for the webstrate.
		const response = await fetch(docUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'token=600'
		});
		assert.equal(response.status, 200, 'token generation should succeed');
		({ token } = await response.json());
		assert.isOk(token, 'an access token should have been issued');

		// Sanity check: while the webstrate exists, the token grants access.
		assert.isNull(await connectWithToken(),
			'token should be accepted while the webstrate exists');
	});

	it('delete should be acknowledged and the document should be gone', async function() {
		// The custom-protocol deletion route.
		const response = await fetch(docUrl + '?delete', { redirect: 'manual' });
		assert.oneOf(response.status, [200, 301, 302],
			'deletion should succeed (a redirect to / follows)');

		// Verify against the server: the version endpoint answers revision 0
		// (the document no longer exists), and a fresh websocket sees the
		// document at revision 0 with an empty structure again.
		const versionResponse = await fetch(docUrl + '?v');
		assert.equal(versionResponse.status, 200, '?v should still answer');
		const versionBody = await versionResponse.json().catch(() => null);
		assert.equal(versionBody && versionBody.version, 0,
			'the deleted webstrate should report version 0: ' + JSON.stringify(versionBody));

		const ws = new WebSocket(wsAddress);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		const header = await sendAndAwaitReply(ws, { wa: 'fetchdoc', token: 'del-check' });
		assert.isNotOk(header.error, 'fetchdoc on the deleted id should not error: '
			+ JSON.stringify(header.error));
		assert.equal(header.reply.v, 0, 'the deleted webstrate should be back at revision 0');
		assert.equal(header.reply.struct.length, 0, 'the structure should be empty');
		ws.close();
	});

	it('access tokens should be invalidated when the document is deleted', async function() {
		// On unfixed code the token outlives the webstrate and this websocket
		// is accepted; the fix expires all access tokens of the document.
		const closed = await connectWithToken();
		assert.isOk(closed, 'websocket with the stale token should be closed, not accepted');
		assert.equal(closed.code, 1002, 'close code should be 1002');
		assert.equal(closed.reason, 'Invalid access token.', 'close reason');
	});
});
