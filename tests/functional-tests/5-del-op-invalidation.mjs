// ShareDB del ops carry no op
// components (op.op is undefined), so the afterWrite hook's
// changesPermissions(req.op.op) threw a TypeError ("Cannot read properties of
// undefined (reading 'some')") after the delete had already been committed in
// the database. The submitting client's del acknowledgement never arrived,
// the permission cache entry and the access tokens of the deleted document
// were never invalidated, and the TypeError surfaced only as an unhandled
// rejection.
//
// These tests fail on unfixed code: the del callback never fires (the first
// test times out), and the websocket presenting the stale token is accepted
// instead of being closed with 1002 "Invalid access token."

import WebSocket from 'ws';
import { assert } from 'chai';
// Note: ESM can't import the lib/client directory subpath, hence the
// explicit index.js (the package has no "exports" restrictions).
import sharedb from 'sharedb/lib/client/index.js';
import config from '../config.js';
import util from '../util.js';

// The ShareDB client can't consume the webstrates-specific 'wa' messages
// (hello, tags, assets, ...) the server sends on subscribe, so silence the
// expected "Ignoring unrecognized message" noise while keeping other warnings
// visible.
{
	const warn = sharedb.logger.warn.bind(sharedb.logger);
	sharedb.logger.setMethods({
		info: () => {},
		warn: (...args) => {
			if (args[0] === 'Ignoring unrecognized message') return;
			warn(...args);
		}
	});
}

describe('Del op invalidation', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const wsAddress = config.server_address.replace(/^http/, 'ws') + webstrateId;
	const docUrl = config.server_address + webstrateId + '/';
	let token;

	// Open a ShareDB connection on the webstrate's websocket endpoint.
	const openConnection = () => new Promise((resolve, reject) => {
		const ws = new WebSocket(wsAddress);
		const connection = new sharedb.Connection(ws);
		connection.on('connected', () => resolve({ ws, connection }));
		ws.on('error', reject);
	});

	// Run a document action (subscribe, create, del) and await its callback.
	const docAction = (connection, action) => new Promise((resolve, reject) => {
		action(connection.get('webstrates', webstrateId), (err) => (err ? reject(err) : resolve()));
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
		// Create the webstrate through a ShareDB client, like the browser
		// client would.
		const { ws, connection } = await openConnection();
		await docAction(connection, (doc, cb) => doc.subscribe(cb));
		await docAction(connection, (doc, cb) => doc.create('json0', cb));
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

	it('del op acknowledgement should arrive and the document should be gone', async function() {
		const { ws, connection } = await openConnection();
		await docAction(connection, (doc, cb) => doc.subscribe(cb));
		// On unfixed code the del commits in the database but this callback
		// never fires (the afterWrite hook throws on the op), so this test
		// fails with a timeout.
		await docAction(connection, (doc, cb) => doc.del(cb));
		ws.close();

		// Verify against the server with a fresh connection that the document
		// is actually deleted.
		const { ws: ws2, connection: connection2 } = await openConnection();
		await docAction(connection2, (doc, cb) => doc.subscribe(cb));
		const doc2 = connection2.get('webstrates', webstrateId);
		assert.isNull(doc2.type, 'document type should be null after deletion');
		assert.isAbove(doc2.version, 0, 'document version should have advanced');
		ws2.close();
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
