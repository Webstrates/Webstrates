const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const messagingManager = require(APP_PATH + '/helpers/MessagingManager.js');
const searchableAssets = require(APP_PATH + '/helpers/SearchableAssets.js');
const snapshotCacheManager = require(APP_PATH + '/helpers/SnapshotCacheManager.js');

// Per-sender rate limit for sendMessage, so a client gone haywire or a malicious user
// cannot flood other users' inboxes. Configurable as config.messageRateLimit =
// { messagesPerInterval, intervalLength }; defaults to 100 messages per minute. All of a user's
// connections share one budget.
const DEFAULT_MESSAGE_RATE_LIMIT = { messagesPerInterval: 100, intervalLength: 60 * 1000 };
const messageRateLimit = Object.assign({}, DEFAULT_MESSAGE_RATE_LIMIT,
	global.config && global.config.messageRateLimit);
const validLimit = value => Number.isFinite(value) && value >= 1;
if (!validLimit(messageRateLimit.messagesPerInterval)
	|| !validLimit(messageRateLimit.intervalLength)) {
	console.warn('Invalid messageRateLimit configuration, using defaults.');
	Object.assign(messageRateLimit, DEFAULT_MESSAGE_RATE_LIMIT);
}

// Messages sent per sender (userId) in the current interval.
const messageCounts = new Map();
setInterval(() => messageCounts.clear(), messageRateLimit.intervalLength);

/**
 * Whether the sender is within the message rate limit, counting the message being sent.
 * @param  {string} senderId Sender userId.
 * @return {bool}            True if the message may be sent, false otherwise.
 * @private
 */
function withinMessageRateLimit(senderId) {
	const count = (messageCounts.get(senderId) || 0) + 1;
	messageCounts.set(senderId, count);
	return count <= messageRateLimit.messagesPerInterval;
}

exports.onmessage = async (ws, req, data, next) => {
	if (!data.wa || 'noop' in req.query) return next();

	const webstrateId = data.d;
	const socketId = req.socketId;
	let user = req.user;

	if (req.query.token) {
		user = permissionManager.getUserFromAccessToken(webstrateId, req.query.token);
	}

	// Here we handle all requests which do not require any sort of permissions.
	switch (data.wa) { // 'wa' for 'webstrates action'.
		// When the ws is ready.
		case 'ready': {
			clientManager.triggerJoin(socketId);
			return;
		}
		case 'sendMessage': {
			// Messaging writes into other users' inboxes, so it is gated: the sender
			// must be logged in — anonymous clients have no messaging API (see
			// client/webstrates/messages.js) — and must have read access to the webstrate the
			// client is connected to, and senders are rate limited. 
			if (user.userId === 'anonymous:') {
				return console.error('sendMessage from anonymous client, ignoring.');
			}

			// The messaging API sends no document id with sendMessage, so the gate is the
			// webstrate the websocket is connected to — not data.d, which the client controls
			// and could otherwise use to pick the least protected document to send through.
			const senderWebstrateId = req.params.webstrateId;
			if (!senderWebstrateId) {
				return console.error('sendMessage from client without a webstrate, ignoring.');
			}

			if (!withinMessageRateLimit(user.userId)) {
				return console.error('sendMessage rate limit exceeded for', user.userId);
			}

			const senderPermissions = await permissionManager.getUserPermissions(user.username,
				user.provider, senderWebstrateId);
			if (!senderPermissions || !senderPermissions.includes('r')) {
				return console.error('Insufficient read permissions in', data.wa, 'call');
			}

			await messagingManager.sendMessage(data.recipients, data.m, user.userId);
			return;
		}
		case 'deleteMessage': {
			if (user.userId !== 'anonymous:') {
				await messagingManager.deleteMessage(user.userId, data.messageId);
			}
			return;
		}
		case 'deleteAllMessages': {
			if (user.userId !== 'anonymous:') {
				await messagingManager.deleteAllMessages(user.userId);
			}
			return;
		}
		case 'cookieUpdate': {
			const responseObj = { wa: 'reply', token: data.token };
			try {
				if (user.userId === 'anonymous:') throw new Error("Must be logged in to set user cookies");
				if (!data.update) throw new Error("Must be provide update info");
				await clientManager.updateCookie(user.userId, webstrateId,
					data.update.key, data.update.value);
				responseObj.reply = true;;
			} catch (err){
				responseObj.error = err.message;
			}
			return ws.send(JSON.stringify(responseObj));
		}
		case 'cookieFetch': {
			const responseObj = { wa: 'reply', token: data.token };
			try {
				if (user.userId === 'anonymous:') throw new Error("Must be logged in to fetch user cookies");
				responseObj.reply = await clientManager.fetchCookie(user.userId, webstrateId, data.cookie);
			} catch (err){
				responseObj.error = err.message;
			}
			return ws.send(JSON.stringify(responseObj));
		}		
	}

	const permissions = await permissionManager.getUserPermissions(user.username, user.provider,
		webstrateId);

	if (!permissions.includes('r')) {
		return console.error('Insufficient read permissions in', data.wa, 'call');
	}

	switch (data.wa) {
		// Request a brotli-compressed snapshot from the server's cache over the
		// websocket
		// The reply is a single BINARY frame with a tiny envelope
		// [0x01][tokenLen:uint8][token utf8][brotli payload] — the token correlates
		// it like any other reply (see client/webstrates/coreWebsocket.js). A 
		// cache miss is reported as a regular reply with
		// no `reply` field, and triggers an immediate (deduplicated) cache rebuild
		// so the next load is warm.
		case 'fetchSnapshot': {
			if (!data.token) break;
			const entry = snapshotCacheManager.readEntry(webstrateId);
			if (!entry) {
				snapshotCacheManager.scheduleRebuild(webstrateId, null);
				ws.send(JSON.stringify({ wa: 'reply', token: data.token }));
				break;
			}
			const token = Buffer.from(String(data.token), 'utf8');
			if (token.length === 0 || token.length > 255) {
				ws.send(JSON.stringify({ wa: 'reply', token: data.token, error: 'Invalid token.' }));
				break;
			}
			ws.send(Buffer.concat([Buffer.from([1, token.length]), token, entry]));
			break;
		}
		// Request a snapshot.
		case 'fetchdoc': {
			if (!data.token) break;
			const version = data.v;
			const tag = data.l;
			const responseObj = { wa: 'reply', token: data.token };
			try {
				responseObj.reply = await documentManager.getDocument({ webstrateId, tag, version });
			} catch (err){
				responseObj.error = err.message;
			}
			ws.send(JSON.stringify(responseObj));
			break;
		}
		// Request a range of ops.
		case 'getOps': {
			if (!data.token) break;
			const initialVersion = data.from;
			const version = data.to;
			const responseObj = { wa: 'reply', token: data.token };
			try {
				responseObj.reply = await documentManager.getOps({ webstrateId, initialVersion, version });
			} catch (err){
				responseObj.error = err.message;
			}
			ws.send(JSON.stringify(responseObj));
			break;
		}
		// Subscribe to signals.
		case 'subscribe': {
			const nodeId = data.id || 'document';
			clientManager.subscribe(socketId, webstrateId, nodeId);
			if (data.token) {
				ws.send(JSON.stringify({ wa: 'reply', token: data.token }));
			}
			break;
		}
		// Unsubscribe from signals.
		case 'unsubscribe': {
			const nodeId = data.id || 'document';
			clientManager.unsubscribe(socketId, webstrateId, nodeId);
			if (data.token) {
				ws.send(JSON.stringify({ wa: 'reply', token: data.token }));
			}
			break;
		}
		// Send a signal.
		case 'publish': {
			const nodeId = data.id || 'document';
			const message = data.m;
			const recipients = data.recipients;
			clientManager.publish(socketId, webstrateId, nodeId, message, recipients);
			break;
		}
		// Signaling on user object.
		case 'signalUserObject': {
			const message = data.m;
			clientManager.signalUserObject(user.userId, socketId, message, webstrateId);
			return;
		}
		// Mark asset as deleted.
		case 'deleteAsset': {
			if (!permissions.includes('w')) {
				console.error('Insufficient write permissions in', data.wa, 'call');
				if (data.token) {
					ws.send(JSON.stringify({ wa: 'reply', token: data.token,
						error: 'Write permissions are required to delete assets.' }));
				}
				return;
			}
			let databaseResponse;
			const returnObject = { wa: 'reply', token: data.token };
			try {
				databaseResponse = await assetManager.markAssetAsDeleted(webstrateId, data.assetName);
				returnObject.reply = databaseResponse;
			} catch (err) {
				returnObject.error = err.message;
			}
			if (data.token) {
				ws.send(JSON.stringify(returnObject));
			}
			return;
		}
		// Restoring a document to a previous version.
		case 'restore': {
			if (!permissions.includes('w')) {
				ws.send(JSON.stringify({ wa: 'reply', token: data.token,
					error: 'Write permissions are required to restore a document.' }));
				return;
			}

			// If the document contains a user with admin permissions, only admins can restore the
			// document.
			if (!permissions.includes('a') && await permissionManager.webstrateHasAdmin(webstrateId)) {
				ws.send(JSON.stringify({ wa: 'reply', token: data.token,
					error: 'Admin permissions are required to restore this document.' }));
				return;
			}

			const version = data.v;
			const tag = data.l;
			// Only one of these should be defined. We can't restore to a version and a tag.
			// Version 0 (the initial, empty version of every document) is a valid restore
			// target, so presence must be tested against undefined, not with truthiness.
			// version xor tag.
			const hasVersion = version !== undefined && version !== null && version !== '';
			const hasTag = tag !== undefined && tag !== null && tag !== '';
			if (hasVersion !== hasTag) {
				const source = `${user.userId} (${req.remoteAddress})`;
				try {
					let newVersion = await documentManager.restoreDocument({ webstrateId, tag, version }, source);

					// Also restore assets, so the restored version shows the old assets, not the new ones.
					await assetManager.restoreAssets({ webstrateId, version, tag, newVersion });

					// The permissions of the older version of the document may be different than
					// what they are now, so we should invalidate the cached permissions.
					permissionManager.invalidateCachedPermissions(webstrateId);
					permissionManager.expireAllAccessTokens(webstrateId);

					ws.send(JSON.stringify({ wa: 'reply', reply: newVersion,
						token: data.token }));
				} catch (err){
					if (data.token) {
						ws.send(JSON.stringify({ wa: 'reply', token: data.token,
							error: err.message
						}));
					}
				}
			} else {
				console.error('Can\'t restore, need either a tag label or version. Not both.');
				if (data.token) {
					ws.send(JSON.stringify({ wa: 'reply', token: data.token,
						error: 'Can\'t restore, need either a tag label or version. Not both.'
					}));
				}
			}
			break;
		}
		// Adding a tag to a document version.
		case 'tag': {
			if (!permissions.includes('w')) {
				console.error('Insufficient write permissions in', data.wa, 'call');
				if (data.token) {
					ws.send(JSON.stringify({ wa: 'reply', token: data.token,
						error: 'Insufficient write permissions in tag call.'
					}));
				}
				return;
			}
			const tag = data.l;
			const version = parseInt(data.v);
			// Ensure that label does not begin with a number and that version is a number.
			if (/^\d/.test(tag) || !/^\d+$/.test(version)) {
				return;
			}

			const returnObject = { wa: 'reply'};
			try {
				returnObject.reply = await documentManager.tagDocument(webstrateId, version, tag);
			} catch (err){
				returnObject.error = err.message;
			}
			if (data.token){
				returnObject.token = data.token;
				ws.send(JSON.stringify(returnObject));
			}
			break;
		}
		// Removing a tag from a document version.
		case 'untag': {
			if (!permissions.includes('w')) {
				return console.error('Insufficient write permissions in', data.wa, 'call');
			}
			const tag = data.l;
			if (tag && !/^\d/.test(tag)) {
				documentManager.untagDocument(webstrateId, { tag });
				break;
			}
			// Version 0 (the initial, empty version of every document) is a valid version
			// to untag, so presence must be tested against undefined, not with truthiness.
			if (data.v !== undefined && data.v !== null && data.v !== '') {
				const version = parseInt(data.v, 10);
				if (!Number.isNaN(version)) {
					documentManager.untagDocument(webstrateId, { version });
					break;
				}
			}
			console.error('Can\'t untag, need either a tag label or version.');
			break;
		}
		// Search CSV assets.
		case 'assetSearch': {
			try {
				const { records, count } = await searchableAssets.search(webstrateId, data.assetName,
					data.assetVersion, data.query, data.sort, data.limit, data.skip);
				ws.send(JSON.stringify({ wa: 'reply', token: data.token, reply: { records, count } }));
			} catch (error) {
				console.error(webstrateId, data, error);
				ws.send(JSON.stringify({ wa: 'reply', token: data.token, error: error.message }));
			}
			break;
		}
		default:
			console.warn('Unknown command from %s on %s: %o', user.userId, webstrateId, data);
	}
};

exports.onclose = (ws, req, reason, next) => {
	clientManager.removeClient(req.socketId);
	next();
};