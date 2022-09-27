const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const messagingManager = require(APP_PATH + '/helpers/MessagingManager.js');
const searchableAssets = require(APP_PATH + '/helpers/SearchableAssets.js');

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
			const message = data.m;
			const recipients = data.recipients;
			const senderId = user.userId === 'anonymous:' ? socketId : user.userId;
			messagingManager.sendMessage(recipients, message, senderId, true);
			return;
		}
		case 'deleteMessage': {
			if (user.userId !== 'anonymous:') {
				messagingManager.deleteMessage(user.userId, data.messageId, true);
			}
			return;
		}
		case 'deleteAllMessages': {
			if (user.userId !== 'anonymous:') {
				messagingManager.deleteAllMessages(user.userId, true);
			}
			return;
		}
		case 'cookieUpdate': {
			if (data.update && user.userId !== 'anonymous:') {
				clientManager.updateCookie(user.userId, webstrateId, data.update.key, data.update.value,
					true);
			}
			return;
		}
	}

	const permissions = await permissionManager.getUserPermissions(user.username, user.provider,
		webstrateId);

	if (!permissions.includes('r')) {
		return console.error('Insufficient read permissions in', data.wa, 'call');
	}

	switch (data.wa) {
		// Request a snapshot.
		case 'fetchdoc': {
			if (!data.token) break;
			const version = data.v;
			const tag = data.l;
			documentManager.getDocument({ webstrateId, tag, version }, function(err,
				snapshot) {
				const responseObj = { wa: 'reply', token: data.token };
				if (err) {
					responseObj.error = err.message;
				} else {
					responseObj.reply = snapshot;
				}
				ws.send(JSON.stringify(responseObj));
			});
			break;
		}
		// Request a range of ops.
		case 'getOps': {
			if (!data.token) break;
			const initialVersion = data.from;
			const version = data.to;
			documentManager.getOps({ webstrateId, initialVersion, version }, function(err, ops) {
				const responseObj = { wa: 'reply', token: data.token };
				if (err) {
					responseObj.error = err.message;
				} else {
					responseObj.reply = ops;
				}
				ws.send(JSON.stringify(responseObj));
			});
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
			clientManager.publish(socketId, webstrateId, nodeId, message, recipients, true);
			break;
		}
		// Signaling on user object.
		case 'signalUserObject': {
			const message = data.m;
			clientManager.signalUserObject(user.userId, socketId, message, webstrateId, true);
			return;
		}
		// Mark asset as deleted.
		case 'deleteAsset': {
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
			// version xor tag.
			if (!!version ^ !!tag) {
				const source = `${user.userId} (${req.remoteAddress})`;
				documentManager.restoreDocument({ webstrateId, tag, version }, source,
					function(err, newVersion) {
						if (err) {
							if (data.token) {
								ws.send(JSON.stringify({ wa: 'reply', token: data.token,
									error: err.message
								}));
							}
						} else {
							// The permissions of the older version of the document may be different than
							// what they are now, so we should invalidate the cached permissions.
							permissionManager.invalidateCachedPermissions(webstrateId);
							permissionManager.expireAllAccessTokens(webstrateId, true);

							ws.send(JSON.stringify({ wa: 'reply', reply: newVersion,
								token: data.token }));
						}
					});
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
			documentManager.tagDocument(webstrateId, version, tag, function(err, res) {
				if (data.token) {
					const returnObject = { wa: 'reply', token: data.token };
					if (err) {
						console.error(err);
						returnObject.error = err.message;
					} else {
						returnObject.reply = res;
					}
					ws.send(JSON.stringify(returnObject));
				}
			});
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
			const version = parseInt(data.v);
			if (version) {
				documentManager.untagDocument(webstrateId, { version });
				break;
			}
			console.error('Can\'t restore, need either a tag label or version.');
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