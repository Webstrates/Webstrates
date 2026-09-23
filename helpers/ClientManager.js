'use strict';

const shortId = require('shortid');
const db = require(APP_PATH + '/helpers/database.js');
const messagingManager = require(APP_PATH + '/helpers/MessagingManager.js');

// Webstrate ids (URL segments) and signal node ids (`wa` action fields) are client-controlled
// and are used as keys into the plain-object maps and per-client arrays below. A key that
// collides with a property of Object.prototype or Array.prototype is not looked up as an own
// property but walks the prototype chain instead: reads return inherited values that lack
// the map's methods (TypeError, and in the join/part timers a process-fatal one), and writes
// land straight in Object.prototype, polluting the whole process — every document the server
// serves gained phantom attributes (see tests/functional-tests/5-fuzzing.mjs, "crash
// candidates"). Such keys are refused at the entry points of this module. Legitimate ids
// (shortid-generated webstrate ids and node wids) never contain these names.
const INVALID_NAMES = new Set([
	...Object.getOwnPropertyNames(Object.prototype),
	...Object.getOwnPropertyNames(Array.prototype)
]);
const isInvalidName = (key) => INVALID_NAMES.has(key);

// One-to-one mapping from socketIds to client sockets as well as one-to-many mapping from
// socketId to webstrateIds. clients holds all connected clients.
const clients = {};

// One-to-many mapping from webstrateIds to socketIds, as well as a one-to-one mapping from those
// socket Ids to userIds. This variable holds a list of all clients connected in all webstrates.
const webstrates = {};

// One-to-many mapping from webstrateIds to nodeIds as well as one-to-many mapping from nodeIds
// to socketIds.
const nodeIds = {};

// One-to-one mapping from socketIds to `clientJoin` trigger function and its associated
// setTimeout id.
const joinTimeouts = {};

// One-to-many mapping from userId to socketIds. Used for communicating cookie updates.
const userIds = {};

// One-to-many mapping from userId to a user's client objects (including device type, IP, etc.)
const userClients = {};

/**
 * Add client to ClientManager.
 * @param  {Socket} ws     Client socket.
 * @param  {Socket} req    Express request object.
 * @param  {obj}    user   User object (OAuth credentials).
 * @return {string}        Generated socketId.
 * @public
 */
module.exports.addClient = function(ws, req, user) {
	var socketId = shortId.generate();

	if (!userIds[user.userId]) userIds[user.userId] = [];
	userIds[user.userId].push(socketId);

	// This is the object we'll make available on webstrate.user.allClients..
	const userClient = {
		socketId,
		ipAddress: req.remoteAddress,
		webstrateId: req.params.webstrateId,
		userAgent: req.headers['user-agent']
	};

	//Only add non anonymous user clients
	if (user.userId !== 'anonymous:') {
		addUserClient(socketId, user.userId, userClient);
	}

	clients[socketId] = {
		socket: ws,
		userClient,
		user: {
			userId: user.userId,
			username: user.username,
			provider: user.provider,
			displayName: user.displayName,
			userUrl: user.userUrl || (user._json && user._json.html_url),
			avatarUrl: user.avatarUrl ||
				(user._json && (user._json.avatar_url || (user._json.image && user._json.image.url)))
		},
		webstrates: {} // contains a one-to-many mapping from webstrateIds to nodeIds.
	};

	messagingManager.clientAdded(socketId, user.userId);

	return socketId;
};

/**
 * Add a user client to userClients and broadcast it (so it ends up in webstrate.user.allClients).
 * @param  {string} socketId   Unique ID generated for each socket.
 * @param  {string} userId     userId (e.g. kbadk:github).
 * @param  {mixed} userClient  User client object.
 * @private
 */
const addUserClient = (socketId, userId, userClient) => {
	userClients[userId] = userClients[userId] || {};
	userClients[userId][socketId] = userClient;

	module.exports.broadcastToUserClients(userId, {
		wa: 'userClientJoin',
		id: socketId,
		userClient
	});
};

/**
 * Remove a user client from userClients and broadcast it (so it gets removed from
 * webstrate.user.allClients).
 * @param  {string} socketId   Unique ID generated for each socket.
 * @param  {string} userId     userId (e.g. kbadk:github).
 * @private
 */
const removeUserClient = (socketId, userId) => {
	// userClients[userId] exists only for logged-in users (addUserClient is gated on the user not
	// being anonymous). Anonymous sockets all share the userId 'anonymous:' (userIds is populated
	// unconditionally in addClient), so broadcasting here anyway would fan a clientPart frame out
	// to every anonymous socket on the server — in every webstrate — none of which has a user
	// object to remove the parting client from. A logged-in user always has an entry while any of
	// their sockets is live, so the broadcast still reaches everyone who can use it.
	if (!userClients[userId]) {
		return;
	}

	delete userClients[userId][socketId];
	// Prune the user's entry when their last client disconnects, so userClients doesn't retain
	// an empty object per user that has ever connected.
	if (Object.keys(userClients[userId]).length === 0) {
		delete userClients[userId];
	}

	// There is no specific 'userClientPart' command, because we can just try to remove all
	// parting clients from the clients and allClients lists. If we try to remove something that
	// doesn't exist... Well, big whoop.
	module.exports.broadcastToUserClients(userId, {
		wa: 'clientPart',
		id: socketId
	});
};

/**
 * Remove client from all webstrates (and broadcast departure) and remove client itself from
 * ClientManager.
 * @param {string} socketId SocketId.
 * @public
 */
module.exports.removeClient = function(socketId) {
	// The client may have been removed already (e.g. by a failing sendToClient), and removeClient
	// may be invoked multiple times for the same socket (sendToClient failure and later the
	// socket's close event), so the messaging manager cleanup has to be idempotent and run even
	// when the client itself is already gone.
	messagingManager.clientRemoved(socketId);

	if (!clients[socketId]) {
		return;
	}

	const userId = clients[socketId].user && clients[socketId].user.userId;

	Object.keys(clients[socketId].webstrates).forEach(function(webstrateId) {
		module.exports.removeClientFromWebstrate(socketId, webstrateId, userId);
	});

	// Clear any pending join timeout, so neither its timer nor its closure (which retains the
	// join message objects) lingers after the client is gone. (P-207)
	if (joinTimeouts[socketId]) {
		clearTimeout(joinTimeouts[socketId].timeout);
		delete joinTimeouts[socketId];
	}

	delete clients[socketId];
	removeUserClient(socketId, userId);

	// Remove the socketId from the userId index. This was never done before, so userIds grew by
	// one entry per connection (including anonymous ones) and never shrank. (P-207)
	if (userIds[userId]) {
		const userIdx = userIds[userId].indexOf(socketId);
		if (userIdx !== -1) {
			userIds[userId].splice(userIdx, 1);
		}
		if (userIds[userId].length === 0) {
			delete userIds[userId];
		}
	}
};

module.exports.triggerJoin = function(socketId) {
	// In case the ready message (that should trigger the clientJoin) comes in too late, i.e. after
	// the 2 seconds, then we shouldn't send the clientJoin message again.
	if (!joinTimeouts[socketId]) {
		return;
	}

	const { timeout, fn } = joinTimeouts[socketId];
	clearTimeout(timeout);
	// The join trigger fn also deletes the entry, but delete defensively in case the entry was
	// replaced in the meantime (a socket subscribing to multiple webstrates overwrites its
	// previous entry). (P-207)
	delete joinTimeouts[socketId];
	fn();
};

/**
 * Add client to Webstrate and broadcast join.
 * @param {string} socketId    SocketId.
 * @param {string} webstrateId WebstrateId.
 * @param {number} headRevision Document head revision to include in the hello
 *                              (optional; a client that opens a socket is
 *                              subscribed without sending anything and learns
 *                              the head from the hello).
 * @public
 */
module.exports.addClientToWebstrate = function(socketId, userId, webstrateId, headRevision) {
	if (isInvalidName(webstrateId)) {
		return;
	}

	// The client may have disconnected while its ({a:'s'}) subscribe was still in flight. In that
	// case clients[socketId] is already gone (removeClient ran on close) and continuing would (a)
	// throw an unhandled rejection when reading clients[socketId].user below, and (b) leak: the
	// socketId would already be set() into webstrates[webstrateId] below, but nothing would ever
	// delete it again (the close-time cleanup only iterates webstrates recorded in
	// clients[socketId].webstrates, which this function never got to populate). Bail out instead.
	// (P-207)
	if (!clients[socketId]) {
		return;
	}

	if (!webstrates[webstrateId]) {
		webstrates[webstrateId] = new Map();
	}

	webstrates[webstrateId].set(socketId, userId);

	// Message to be sent to all other clients in the webstrate.
	const clientJoinMsgObj = {
		wa: 'clientJoin',
		id: socketId,
		d: webstrateId
	};

	// Additional message sent to all of the user's other clients. This is used to keep
	// webstrate.user.clients updated in the frontend.
	const userClientJoinMsgObj = {
		wa: 'userClientJoin',
		id: socketId,
		d: webstrateId
	};

	const user = Object.assign({}, clients[socketId].user);

	// Add a list of all the user's connected clients to the user object.
	if (userId !== 'anonymous:') {
		user.clients = [];
		user.allClients = userClients[userId] || {};
		webstrates[webstrateId].forEach((assUserId, socketId) => {
			if (assUserId === userId) user.clients.push(socketId);
		});
	}

	// Message to be sent to client joining the webstrate. The hello always
	// carries the document id (the one message that does) and, when known, the
	// head revision — a client that merely opens its websocket is subscribed
	// and can adopt from this without sending a single message.
	const helloMsgObj = {
		wa: 'hello',
		id: socketId,
		d: webstrateId,
		v: headRevision,
		defaultPermissions: global.config.auth.defaultPermissions,
		user: user,
		clients: Array.from(webstrates[webstrateId].keys()),
	};

	// If no userId is defined, the user isn't logged in and therefore can't have cookies attached,
	// so let's not waste time looking for them.
	if (userId === 'anonymous:') {
		module.exports.sendToClient(socketId, helloMsgObj);
	} else {
		// Get user's messages (intentionally no await here)
		messagingManager.getMessages(userId).then(messages=>{
			helloMsgObj.messages = messages;
			module.exports.sendToClient(socketId, helloMsgObj);
		}); 
	}

	// Initialize the client's list of nodeIds subscribed to in this webstrate. Only create it if
	// it doesn't exist: a re-join (a new {a:'s'} without a prior {a:'u'}) would otherwise wipe
	// the recorded nodeIds, while the nodeIds entries themselves would keep lingering. (P-207)
	if (!clients[socketId].webstrates[webstrateId]) {
		clients[socketId].webstrates[webstrateId] = [];
	}

	var joinTriggerFn = function() {
		// Remove the join timeout entry whether or not we end up broadcasting the join, so that
		// joinTimeouts doesn't retain the entry (and with it the fn closure) forever. The entry
		// may already have been replaced or removed (see triggerJoin and removeClient), so only
		// delete it if it still holds this very fn. (P-207)
		if (joinTimeouts[socketId] && joinTimeouts[socketId].fn === joinTriggerFn) {
			delete joinTimeouts[socketId];
		}

		// If the client has already left (i.e. removeClientFromWebstrate was triggered), there's no
		// reason to broadcast the clientJoin. The webstrate's client map may also have been pruned
		// entirely if we were its last client. (P-207)
		if (!webstrates[webstrateId] || !webstrates[webstrateId].has(socketId)) {
			return;
		}

		if (userId !== 'anonymous:') {
			broadcastToUserClientsInWebstrate(webstrateId, userId, userClientJoinMsgObj);
		}
		broadcastToWebstrateClients(webstrateId, clientJoinMsgObj);
	};

	var timeout = setTimeout(joinTriggerFn, 2000);
	joinTimeouts[socketId] = { timeout, fn: joinTriggerFn };
};

/**
 * Remove client from webstrate and broadcast departure.
 * @param {string} socketId    SocketId.
 * @param {string} webstrateId WebstrateId.
 * @param {string} userId      UserId if user is logged in.
 * @public
 */
module.exports.removeClientFromWebstrate = function(socketId, webstrateId, userId) {
	// Prototype-colliding webstrate ids are never recorded as joined (see
	// addClientToWebstrate), so a part for one can only be an attempt to reach the
	// prototype chain through clients[socketId].webstrates[webstrateId] and
	// webstrates[webstrateId]. Refuse it the same way.
	if (isInvalidName(webstrateId)) {
		return;
	}

	// The client may unsubscribe from a webstrate it never joined (no prior 's'), in which case
	// there are no node subscriptions to clean up.
	// Unsubscribe the client from all the nodeIds it subscribed to in this webstrate. subscribe()
	// records every nodeId in clients[socketId].webstrates[webstrateId], so this loop actually
	// removes the client's signal subscriptions on disconnect and on ShareDB {a:'u'}
	// unsubscribes. Before this bookkeeping existed, the loop iterated an always-empty list, so
	// signal subscriptions survived both. (P-207, P-317)
	if (clients[socketId] && clients[socketId].webstrates[webstrateId]) {
		clients[socketId].webstrates[webstrateId].forEach(function(nodeId) {
			module.exports.unsubscribe(socketId, webstrateId, nodeId);
		});

		// Forget the client's node subscriptions for this webstrate, so that (a) subscribe retries
		// still in flight abort instead of re-adding subscriptions after the unsubscribe, and
		// (b) a disconnecting client is not reprocessed for a webstrate it already left.
		delete clients[socketId].webstrates[webstrateId];
	}

	if (userClients[userId]) {
		delete userClients[userId][socketId];
		// Prune the user's entry if this was their last client in the webstrate. (P-207)
		if (Object.keys(userClients[userId]).length === 0) {
			delete userClients[userId];
		}
	}

	var partFn = function() {
		// When this part action runs delayed (i.e. the unsubscribe arrived before the client had
		// joined), a late join may have re-created the client's webstrate entry and node
		// subscriptions in the meantime. Clean those up as well, so the unsubscribe always wins.
		// (P-207, P-317)
		if (clients[socketId] && clients[socketId].webstrates[webstrateId]) {
			clients[socketId].webstrates[webstrateId].forEach(function(nodeId) {
				module.exports.unsubscribe(socketId, webstrateId, nodeId);
			});
			delete clients[socketId].webstrates[webstrateId];
		}

		// In case webstrates[webstrateId] still doesn't exist, let's just give up in trying to remove
		// the client.
		if (!webstrates[webstrateId]) {
			return;
		}

		const socketIdExisted = webstrates[webstrateId].delete(socketId);
		if (socketIdExisted) {
			broadcastToWebstrateClients(webstrateId, {
				wa: 'clientPart',
				id: socketId,
				d: webstrateId
			});
		}

		// Prune the webstrate's client map when its last client parts, so webstrates doesn't
		// retain an empty map for every webstrateId ever visited. (P-207)
		if (webstrates[webstrateId].size === 0) {
			delete webstrates[webstrateId];
		}
	};

	// Due to the delay in joins, we may end up in a situation where a part is broadcast before a
	// join. In this case, webstrates[webstrateId] may not even be defined. Therefore, before we
	// remove a client from a webstrate, we ensure that the client has already joined.
	// If the client hasn't joined yet, we instead delay the part action with 2 seconds just like
	// the join action has been. That way, we know the client will have joined by the time we remove
	// it. It's a little convoluted, but it's the easiest way to ensure that even brief join/parts
	// get registered to all clients.
	if (webstrates[webstrateId] && webstrates[webstrateId].has(socketId)) {
		partFn();
		return;
	}

	setTimeout(partFn, 2000);
};

/**
 * Subscribe client to signals on a node in a webstrate.
 * @param  {string} socketId    SocketId.
 * @param  {string} webstrateId WebstrateId.
 * @param  {string} nodeId      NodeId.
 * @public
 */
module.exports.subscribe = function(socketId, webstrateId, nodeId, retry = 5) {
	// Refuse bad ids - this also stops the retry timer below from ever dereferencing them.
	if (isInvalidName(webstrateId) || isInvalidName(nodeId)) {
		return;
	}

	// Make sure the client is connected to the webstrate.
	if (!clients[socketId] || !clients[socketId].webstrates[webstrateId]) {
		// The user may have been so eager to subscribe that they sent the command before they have
		// joined the document. Let's retry the subscribe command in a little while.
		if (retry > 0) {
			setTimeout(function() {
				module.exports.subscribe(socketId, webstrateId, nodeId, retry - 1);
			}, 200);
		}
		return;
	}

	if (!nodeIds[webstrateId]) {
		nodeIds[webstrateId] = {};
	}

	if (!nodeIds[webstrateId][nodeId]) {
		nodeIds[webstrateId][nodeId] = [];
	}

	// Record the nodeId on the client's webstrate entry, so that removeClientFromWebstrate can
	// unsubscribe the client from all of its nodeIds when it disconnects or unsubscribes from the
	// webstrate (e.g. through ShareDB's {a:'u'}). Without this bookkeeping, that cleanup iterated
	// an always-empty list and every signal subscription leaked. (P-207, P-317)
	const subscribedNodeIds = clients[socketId].webstrates[webstrateId];
	if (!subscribedNodeIds.includes(nodeId)) {
		subscribedNodeIds.push(nodeId);
	}

	// Keep the listener list free of duplicates, so that a single unsubscribe removes the client
	// again even if it (or its userland) subscribed more than once.
	const listeners = nodeIds[webstrateId][nodeId];
	if (!listeners.includes(socketId)) {
		listeners.push(socketId);
	}
};

/**
 * Unsubscribe client from signals on a node in a webstrate.
 * @param {string} socketId    SocketId.
 * @param {string} webstrateId WebstrateId.
 * @param {string} nodeId      NodeId.
 * @public
 */
module.exports.unsubscribe = function(socketId, webstrateId, nodeId) {
	// Prototype-colliding ids never have recorded subscriptions (see subscribe), so a
	// request for one can only be an attempt to reach the prototype chain through
	// nodeIds[webstrateId][nodeId]. Refuse it the same way.
	if (isInvalidName(webstrateId) || isInvalidName(nodeId)) {
		return;
	}

	if (!nodeIds[webstrateId] || !nodeIds[webstrateId][nodeId]) {
		return;
	}

	var socketIdIdx = nodeIds[webstrateId][nodeId].indexOf(socketId);
	// The client may not be subscribed to this nodeId, e.g. because it unsubscribed while its
	// subscribe was still in its (up to 1 second long) retry window — subscribe retries, while
	// unsubscribe is immediate. Without this check, splice(-1, 1) removes the last (arbitrary)
	// listener instead, destroying another client's subscription. (P-322)
	if (socketIdIdx === -1) {
		return;
	}

	nodeIds[webstrateId][nodeId].splice(socketIdIdx, 1);

	// Remove the nodeId from the client's list of subscribed nodeIds, too. The client may be gone
	// already (in which case the whole entry goes away with it), and the nodeId may have been
	// removed already (e.g. by removeClientFromWebstrate unsubscribing all nodeIds at once), so
	// guard the splice. (P-322, P-207)
	if (clients[socketId] && clients[socketId].webstrates[webstrateId]) {
		var nodeIdIdx = clients[socketId].webstrates[webstrateId].indexOf(nodeId);
		if (nodeIdIdx !== -1) {
			clients[socketId].webstrates[webstrateId].splice(nodeIdIdx, 1);
		}
	}

	// Prune empty listener lists (and empty webstrate entries), so that nodeIds doesn't retain an
	// empty array for every (webstrateId, nodeId) pair ever subscribed. (P-207)
	if (nodeIds[webstrateId][nodeId].length === 0) {
		delete nodeIds[webstrateId][nodeId];
		if (Object.keys(nodeIds[webstrateId]).length === 0) {
			delete nodeIds[webstrateId];
		}
	}
};

/**
 * Send signal to a list of clients (or a all clients) subscribed to a node in a webstrate.
 * @param {string} senderSocketId SocketId of sender.
 * @param {string} socketId       SocketId.
 * @param {string} webstrateId    WebstrateId.
 * @param {string} nodeId         NodeId.
 * @public
 */
module.exports.publish = function(senderSocketId, webstrateId, nodeId, message, recipients) {
	// Prototype-colliding ids are never subscribed (see subscribe); refusing them here
	// keeps the spreads below from trying to iterate the prototype chain.
	if (isInvalidName(webstrateId) || isInvalidName(nodeId)) {
		return;
	}

	if (!nodeIds[webstrateId]) {
		return;
	}

	// In case we receive a single recipientId instead of an array.
	if (typeof recipients === 'string') {
		recipients = [recipients];
	}

	// Messages should be sent to everybody listening on the nodeId and the "document". We use a
	// Set, so we don't send to the same socketId twice.
	var listeners = new Set([...(nodeIds[webstrateId][nodeId] || []),
		...(nodeIds[webstrateId]['document'] || [])]);

	// The webstrate's client map may have been pruned after its last client left, in which case
	// there are no recipients left to send to. (P-207)
	var defaultRecipients = webstrates[webstrateId] ? Array.from(webstrates[webstrateId].keys()) : [];

	(recipients || defaultRecipients).forEach(function(recipientId) {
		// We don't know the client, or it isn't listening.
		if (!clients[recipientId] || !listeners.has(recipientId)) {
			return;
		}

		// We know the client and it's listening, so let's do this!
		module.exports.sendToClient(recipientId, {
			wa: 'publish',
			id: nodeId,
			d: webstrateId,
			s: senderSocketId,
			m: message
		});
	});
};

/**
 * Signal on user object. Any signal made on the user object is sent to all of the user's
 * connected clients.
 * @param {string} userId          User Id (of the format <username>:<provider, e.g.
 *                                 "kbadk:github").
 * @param {string} senderSocketId  SocketId (= webstrate.clientId on the client).
 * @param {json}   message         Optional message object.
 * @public
 */
module.exports.signalUserObject = function(userId, senderSocketId, message, webstrateId) {
	module.exports.broadcastToUserClients(userId, {
		wa: 'signalUserObject',
		m: message,
		s: senderSocketId,
		sw: webstrateId,
	});
};

/**
 * Send message all clients in a webstrate about a new asset.
 * @param {string} webstrateId WebstrateId.
 * @param {Object} asset       Asset object.
 * @public
 */
module.exports.announceNewAsset = function(webstrateId, asset) {
	module.exports.sendToClients(webstrateId, {
		wa: 'asset',
		d: webstrateId,
		asset: asset,
	});
};


/**
 * Update cookies. Any update made to a user's is sent to all of the user's conneted clients.
 * @param {string} userId  User Id (of the format <username>:<provider, e.g. "kbadk:github").
 * @param {string} webstrateId WebstrateId.
 * @param {string} key         Key to update (or add) in the cookie.
 * @param {string} value       Value associated with key.
 * @public
 */
module.exports.updateCookie = async function(userId, webstrateId, key, value) {
	if (!key) throw new Error("Must provide a cookie name key");

	var updateObj = {
		wa: 'cookieUpdate',
		update: { key, value }
	};

	if (webstrateId) {
		updateObj.d = webstrateId;
		broadcastToUserClientsInWebstrate(webstrateId, userId, updateObj);
	} else {
		module.exports.broadcastToUserClients(userId, updateObj);
	}

	var webstrateIdQuery = webstrateId || { '$exists': false };

	if (value === undefined) {
		// If the value is undefined, delete the cookie key entirely
		await db.cookies.updateOne(
			{ userId, webstrateId: webstrateIdQuery },
			{ $pull: { cookies: { key } } }
		);
		return;
	}

	let res = await db.cookies.updateOne(
		{ userId, webstrateId: webstrateIdQuery, cookies: { key } },
		{ $set: { 'cookies.$.value': value } }
	);

	// If our update didn't update anything, we have to add it first. Maybe this could be done
	// in one query, but as this point, I've given up trying to get clever with MongoDB.
	if (res.modifiedCount === 0) {
		// We still have to upsert, because even though the particular cookie key from above
		// doesn't exist, the document may still exist.
		await db.cookies.updateOne(
			{ userId, webstrateId: webstrateIdQuery },
			{ $push: { cookies: { key, value } } },
			{ upsert: true }
		);
	}
};

module.exports.fetchCookie = async function(userId, webstrateId, key){
	let cookieQuery = {userId};
	if (webstrateId){
		cookieQuery.webstrateId = webstrateId;
	} else {
		cookieQuery.webstrateId = { '$exists': false }
	}

	let result = await db.cookies.findOne(cookieQuery);
	if (!result) {
		if (key){
			return undefined;
		} else {
			return {};
		}
	}
	result = result.cookies.reduce((map, entry) => {
		map[entry.key] = entry.value;
		return map;
	}, {});

	if (key){
		// Single cookie
		return result[key];
	} else {
		// Cookie map
		return result;
	}
}

/**
 * Send message to clients in a webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @param  {mixed} message      Message.
 * @public
 */
module.exports.sendToClients = function(webstrateId, message) {
	if (!webstrates[webstrateId] || isInvalidName(webstrateId)) {
		return;
	}

	webstrates[webstrateId].forEach((userId, socketId) =>
		module.exports.sendToClient(socketId, message));
};

/**
 * Send message to client by socketId.
 * @param  {string} socketId SocketId.
 * @param  {mixed} message   Message.
 * @return {bool}            True on success, false on failure.
 * @public
 */
module.exports.sendToClient = function(socketId, message) {
	// If we don't have the client's socket (e.g. it has already disconnected), we can't send
	// the message, and that's fine.
	if (!clients[socketId]) {
		return false;
	}

	// The webstrate is part of the socket's URL, so a message about the
	// socket's OWN document never names it — the client already knows. A `d`
	// on an outbound frame only ever addresses a different document (a
	// secondary subscription or a cross-document reply). Two exceptions: the
	// hello always carries its document id (so a client can confirm which
	// webstrate its socket is bound to), and a cookieUpdate uses the PRESENCE
	// of `d` to tell a document-scoped cookie ("here") from a user-global one
	// ("anywhere") — it is a flag, not a document name.
	if (message.d !== undefined && message.wa !== 'hello'
		&& message.wa !== 'cookieUpdate'
		&& clients[socketId].userClient.webstrateId === message.d) {
		message = Object.assign({}, message);
		delete message.d;
	}

	try {
		clients[socketId].socket.send(JSON.stringify(message));
	} catch (e) {
		module.exports.removeClient(socketId);
		return false;
	}

	return true;
};

/**
 * Send message to all clients currently connected to a webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @param  {obj}    message     Message object.
 * @private
 */
function broadcastToWebstrateClients(webstrateId, message) {
	if (!webstrates[webstrateId] || isInvalidName(webstrateId)) {
		return;
	}

	webstrates[webstrateId].forEach(function(userId, socketId) {
		module.exports.sendToClient(socketId, message);
	});
}

/**
 * Send message to all a user's clients in a webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @param  {string} userId      User Id (e.g. "kbadk:github").
 * @param  {obj}    message     Message object.
 * @private
 */
function broadcastToUserClientsInWebstrate(webstrateId, userId, message) {
	if (!webstrates[webstrateId] || !userIds[userId] || isInvalidName(webstrateId)) {
		return;
	}

	userIds[userId].forEach(function(socketId) {
		if (webstrates[webstrateId].has(socketId)) {
			module.exports.sendToClient(socketId, message);
		}
	});
}

/**
 * Send message to all clients currently connected and logged in as userId (locally).
 * @param  {string} userId  User Id (of the format <username>:<provider, e.g. "kbadk:github").
 * @param  {obj}    message     Message object.
 * @public
 */
module.exports.broadcastToUserClients = function(userId, message) {
	if (!userIds[userId]) {
		return;
	}

	userIds[userId].forEach(function(socketId) {
		module.exports.sendToClient(socketId, message);
	});
};