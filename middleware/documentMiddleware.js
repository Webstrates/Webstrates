'use strict';

/**
 * Document protocol handlers — the 'wa' actions that move documents, ops and
 * ids over the websocket (the replacement for the ShareDB stream).
 *
 *   (subscribe)                   → implicit: the connection joins its own
 *                                     document when it is established (see
 *                                     autoJoin); no 'wa' action needed
 *   dunsubscribe  {wa, d}          → leave presence (like the sharedb 'u')
 *   commit        {wa, d, base, ops, token} → apply one transaction based on
 *                                     revision `base`; server-side OT-lite
 *                                     transform against commits since `base`;
 *                                     ack {v, firstOpid, xformed}; broadcast
 *                                     the final ops to ALL clients (including
 *                                     the originator — application is
 *                                     idempotent, so the originator's replay
 *                                     is a no-op)
 *   allocids      {wa, d, count, token} → {start, end} block from the
 *                                     document's global id counter; clients
 *                                     mint element ids and attribute indexes
 *                                     from their block
 *   fetchStructure{wa, d, token}   → brotli binary frame {v, struct, state}
 *                                     (the clean-rebuild fallback when a
 *                                     client's parsed DOM disagrees with the
 *                                     server's structure)
 *
 * The handlers are invoked from customActionHandlerMiddleware's switch (the
 * hub for every 'wa' action) with the resolved user, permissions and socketId.
 */

const zlib = require('zlib');

const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const snapshotCacheManager = require(APP_PATH + '/helpers/SnapshotCacheManager.js');
const documentStore = require(APP_PATH + '/helpers/DocumentStore.js');
const db = require(APP_PATH + '/helpers/database.js');

// ws.__sessionLogged → true once a sessionLog entry was written for the
// connection (the old ShareDB connect flow logged one entry per agent, keyed
// by the sharedb client id; ours is keyed by the socketId, which is what
// commit entries carry as their src — so getOps' session attachment keeps
// working). The flag lives on the socket itself, so it cannot outlive the
// connection. The op broadcast audience is the webstrate's presence set
// itself (clientManager.sendToClients): joining happens when the connection
// is established (autoJoin), leaving in dunsubscribe/disconnect — the same
// lifecycle the old ShareDB subscription had, so no separate subscription
// map is needed.

/**
 * Write one sessionLog entry per connection (unless disabled).
 * @param {ws}  ws  Websocket (carries the once-per-connection flag).
 * @param {req} req Express request (with socketId, user, remoteAddress).
 * @private
 */
async function logSession(ws, req) {
	if (config.disableSessionLog || ws.__sessionLogged) return;
	ws.__sessionLogged = true;
	try {
		await db.sessionLog.insertOne({
			sessionId: req.socketId,
			userId: req.user.userId,
			connectTime: Date.now(),
			remoteAddress: req.remoteAddress
		});
	} catch (err) {
		// The old ShareDB flow retried for ~500ms while the database connected;
		// at subscribe time it is long up, so a plain error log suffices.
		console.error('documentMiddleware: session log insert failed:', err.message);
	}
}

/**
 * Whether the ops of a pending commit change the document's permissions
 * (data-auth on the root element) — the admin check + cache invalidation
 * trigger, equivalent to the old changesPermissions() on json0 ops.
 * @param  {Handle} handle Document handle.
 * @param  {[op]}   ops    Forward ops.
 * @return {bool}          True if data-auth would change.
 * @private
 */
function changesPermissions(handle, ops) {
	const root = handle.nodes.get(0);
	const htmlEid = root && root.kids[0];
	if (!htmlEid) return false;
	const htmlNode = handle.nodes.get(htmlEid);
	const authPos = htmlNode
		? htmlNode.attrs.findIndex((a) => a.n === 'data-auth') : -1;
	return ops.some((op) => op.e === htmlEid && (
		(op.k === 'aa' && op.n === 'data-auth')
		// ar ops are name-anchored when they carry a name (clients always
		// send it); a position-only ar against the current index also counts.
		|| (op.k === 'ar' && (op.n === 'data-auth'
			|| (op.n === undefined && authPos !== -1 && op.i === authPos)))));
}

/**
 * Broadcast a commit to every subscriber of a webstrate. The originator is
 * included: applying its own (possibly transformed) ops is idempotent, and it
 * is what converges a client whose local application lost a race.
 * @param {string} webstrateId WebstrateId.
 * @param {result} result      applyCommit result ({v, ops, xformed}).
 * @param {string} socketId    Originator socketId.
 * @private
 */
function broadcastCommit(webstrateId, result, socketId) {
	clientManager.sendToClients(webstrateId, {
		wa: 'ops',
		d: webstrateId,
		v: result.v,
		ops: result.ops,
		s: socketId,
		x: result.xformed === true,
		// Restore diffs (r): a commit that transforms the document into a
		// target state — typically thousands of interleaced structural ops.
		// Clients converge on these with a full rebuild rather than the
		// incremental per-op translation.
		r: result.ops && result.ops.length > 0
			&& typeof result.src === 'string'
			&& result.src.startsWith('documentRestore')
	});
}

// Registers the internal commit listeners once (documentManager broadcasts
// server-side commits: no-ops, permission updates, restores).
documentManager.onCommit((webstrateId, handle, result) => {
	broadcastCommit(webstrateId, result, null);
	snapshotCacheManager.scheduleRebuild(webstrateId);
});

/**
 * Join a socket to a webstrate: presence join (hello with the head revision +
 * clientJoin broadcast), tag and asset lists, and registration for op
 * broadcasts. Own-document joins happen automatically when the connection is
 * established (see autoJoin) — there is no explicit subscribe action anymore.
 * @param {req}    req          Express request.
 * @param {object} user         Resolved user.
 * @param {string} webstrateId  WebstrateId.
 * @param {number} headRevision Document head revision (for the hello).
 * @private
 */
function joinDocument(req, user, webstrateId, headRevision) {
	// Add client to the webstrate's presence (hello + clientJoin broadcast).
	clientManager.addClientToWebstrate(req.socketId, user.userId, webstrateId,
		headRevision);

	// Send the tag and asset lists, if any. The d names the document —
	// stripped again by sendToClient when the socket is that document's own.
	documentManager.getTags(webstrateId, (err, tags) => {
		if (err) return console.error(err);
		if (tags) {
			clientManager.sendToClient(req.socketId, { wa: 'tags', d: webstrateId, tags });
		}
	});
	assetManager.getAssets(webstrateId).then((assets) => {
		clientManager.sendToClient(req.socketId, { wa: 'assets', d: webstrateId, assets });
	}).catch((err) => console.error(err));
}

/**
 * autoJoin: subscribe the connection to its own webstrate the moment it is
 * established — the document is in the socket's URL, so opening the socket is
 * the subscription. The client receives the hello (id + head revision)
 * without sending anything.
 * @param {ws}  ws  Websocket.
 * @param {req} req Express request.
 * @public
 */
module.exports.autoJoin = async function(ws, req) {
	const webstrateId = req.params.webstrateId;
	if (!webstrateId) return;

	// The same read gate the old explicit subscribe path had to pass.
	const permissions = await permissionManager.getUserPermissions(
		req.user.username, req.user.provider, webstrateId);
	if (!permissions || !permissions.includes('r')) return;

	await logSession(ws, req);

	const handle = documentStore.getHandle(webstrateId);
	let revision;
	try {
		revision = handle.revision;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}

	joinDocument(req, req.user, webstrateId, revision);
};

/**
 * dunsubscribe: presence part (like the old sharedb 'u').
 * @param {req}    req Express request.
 * @param {string} webstrateId WebstrateId.
 * @public
 */
module.exports.dunsubscribe = function(req, webstrateId) {
	clientManager.removeClientFromWebstrate(req.socketId, webstrateId);
};

/**
 * commit: apply one transaction based on revision `base`. Write permission is
 * required (or the create check when the document is still empty); permission
 * changes require admin when the document has an admin. On success: broadcast
 * the final ops to everyone (originator included) and ack the originator.
 * @param {ws}     ws          Websocket.
 * @param {req}    req         Express request.
 * @param {object} user        Resolved user.
 * @param {string} webstrateId WebstrateId.
 * @param {object} data        Parsed client message ({base, ops, token}).
 * @public
 */
module.exports.commit = async function(ws, req, user, webstrateId, data) {
	await logSession(ws, req);

	// The message may name a webstrate other than the one the socket is
	// connected to (a transcluded or scripted client can d-address another
	// document). As in the old ShareDB middleware, the user is then resolved
	// through an access token for THAT webstrate — no token, no user, no
	// commit.
	if (req.params.webstrateId !== webstrateId) {
		const tokenUser = permissionManager.getUserFromAccessToken(webstrateId,
			req.query.token);
		if (!tokenUser) {
			return replyError(ws, data, 'Forbidden');
		}
		user = tokenUser;
	}

	const reply = (payload) => {
		if (data.token) {
			ws.send(JSON.stringify({ wa: 'reply', token: data.token, ...payload }));
		}
	};

	const handle = documentStore.getHandle(webstrateId);
	try {
		const ops = Array.isArray(data.ops) ? data.ops : [];
		const base = data.base;
		const creating = handle.revision === 0;

		const permissions = creating
			? null // creation is gated by userIsAllowedToCreateWebstrate below
			: await permissionManager.getUserPermissions(user.username, user.provider,
				webstrateId);

		if (creating && ops.length > 0) {
			// Creating a new document: check that the user may create, not
			// whether they may write the (empty) document.
			if (!permissionManager.userIsAllowedToCreateWebstrate(user)) {
				let err = 'Must be logged in to create a webstrate.';
				if (Array.isArray(config.loggedInToCreateWebstrates)) {
					const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
					err = `Must be logged in with ${allowedProviders} to create a webstrate.`;
				}
				return reply({ error: err });
			}
		} else if (!permissions || !permissions.includes('w')) {
			return reply({ error: 'Forbidden, write permissions required' });
		}

		if (changesPermissions(handle, ops)
			&& (!permissions || !permissions.includes('a'))
			&& await permissionManager.webstrateHasAdmin(webstrateId)) {
			return reply({ error: 'Forbidden, admin permission required' });
		}

		const result = handle.applyCommit({ base, ops, userId: user.userId,
			source: req.socketId });

		// Post-commit bookkeeping (the old afterWrite/receive middlewares).
		if (changesPermissions(handle, result.ops)) {
			permissionManager.invalidateCachedPermissions(webstrateId);
			permissionManager.expireAllAccessTokens(webstrateId);
		}
		broadcastCommit(webstrateId, result, req.socketId);
		snapshotCacheManager.scheduleRebuild(webstrateId);

		reply({ reply: { v: result.v, firstOpid: result.firstOpid,
			xformed: result.xformed === true } });
	} catch (err) {
		console.error(`documentMiddleware: commit to ${webstrateId} failed:`, err.message);
		reply({ error: err.message });
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Send an error reply on a websocket, if a token correlates it.
 * @param {ws}    ws   Websocket.
 * @param {object} data Client message (with token).
 * @param {string} error Error message.
 * @private
 */
function replyError(ws, data, error) {
	if (data.token) {
		ws.send(JSON.stringify({ wa: 'reply', token: data.token, error }));
	}
}

/**
 * allocids: allocate a block of ids from the document's global counter
 * (write permission required — only committers mint ids).
 * @param {ws}     ws          Websocket.
 * @param {req}    req         Express request.
 * @param {object} user        Resolved user.
 * @param {string} webstrateId WebstrateId.
 * @param {object} data        Parsed client message ({count, token}).
 * @public
 */
module.exports.allocids = async function(ws, req, user, webstrateId, data) {
	const permissions = await permissionManager.getUserPermissions(user.username,
		user.provider, webstrateId);
	if (!permissions || !permissions.includes('w')) {
		if (data.token) {
			ws.send(JSON.stringify({ wa: 'reply', token: data.token,
				error: 'Insufficient write permissions in allocids call.' }));
		}
		return;
	}
	const handle = documentStore.getHandle(webstrateId);
	try {
		const block = handle.allocIds(Number(data.count) || 1);
		if (data.token) {
			ws.send(JSON.stringify({ wa: 'reply', token: data.token, reply: block }));
		}
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * fetchStructure: brotli-compressed {v, struct, state} of the document —
 * the clean-rebuild fallback for clients whose parsed DOM disagrees with the
 * server's structure, and the eid source for versioned/tagged live loads
 * (those cannot adopt the pre-rendered head page; a structure at their own
 * revision tells them every node's eid and attribute index). Without data.v
 * the structure is of the head revision. Reply is a binary frame with the
 * same envelope the compressed snapshot used: [1][tokenLen][token][payload].
 * @param {ws}     ws          Websocket.
 * @param {string} webstrateId WebstrateId.
 * @param {object} data        Parsed client message ({token, v?, l?}).
 * @public
 */
module.exports.fetchStructure = function(ws, webstrateId, data) {
	if (!data.token) return;
	const send = (payload) => {
		const token = Buffer.from(String(data.token), 'utf8');
		if (token.length === 0 || token.length > 255) {
			return ws.send(JSON.stringify({ wa: 'reply', token: data.token,
				error: 'Invalid token.' }));
		}
		const header = Buffer.from([1, token.length]);
		ws.send(Buffer.concat([header, token, payload]));
	};

	// Version/tag resolution and the mirror walk live in
	// DocumentManager.getStructure — shared with the fetchdoc JSON reply.
	(async () => {
		const structure = await documentManager.getStructure({ webstrateId,
			version: data.v, tag: data.l });
		send(zlib.brotliCompressSync(Buffer.from(JSON.stringify(structure), 'utf8')));
	})().catch((err) => {
		console.error(`documentMiddleware: fetchStructure for ${webstrateId}:`, err.message);
		ws.send(JSON.stringify({ wa: 'reply', token: data.token, error: err.message }));
	});
};

