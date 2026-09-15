'use strict';

const shortId = require('shortid');
const db = require(APP_PATH + '/helpers/database.js');
const messagingManager = require(APP_PATH + '/helpers/MessagingManager.js');

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
	if (userClients[userId]) {
		delete userClients[userId][socketId];
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
	if (!clients[socketId]) {
		return;
	}

	const userId = clients[socketId].user && clients[socketId].user.userId;

	Object.keys(clients[socketId].webstrates).forEach(function(webstrateId) {
		module.exports.removeClientFromWebstrate(socketId, webstrateId, userId);
	});

	delete clients[socketId];
	removeUserClient(socketId, userId);
};

module.exports.triggerJoin = function(socketId) {
	// In case the ready message (that should trigger the clientJoin) comes in too late, i.e. after
	// the 2 seconds, then we shouldn't send the clientJoin message again.
	if (!joinTimeouts[socketId]) {
		return;
	}

	clearTimeout(joinTimeouts[socketId].timeout);
	joinTimeouts[socketId].fn();
};

/**
 * Add client to Webstrate and broadcast join.
 * @param {string} socketId    SocketId.
 * @param {string} webstrateId WebstrateId.
 * @public
 */
module.exports.addClientToWebstrate = function(socketId, userId, webstrateId) {
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

	// Message to be sent to client joining the webstrate.
	const helloMsgObj = {
		wa: 'hello',
		id: socketId,
		d: webstrateId,
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

	clients[socketId].webstrates[webstrateId] = [];

	var joinTriggerFn = function() {
		// If the client has already left (i.e. removeClientFromWebstrate was triggered), there's no
		// reason to broadcast the clientJoin.
		if (!webstrates[webstrateId].has(socketId)) {
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

	// The client may unsubscribe from a webstrate it never joined (no prior 's'), in which case
	// there are no node subscriptions to clean up.
	if (clients[socketId] && clients[socketId].webstrates[webstrateId]) {
		clients[socketId].webstrates[webstrateId].forEach(function(nodeId) {
			module.exports.unsubscribe(socketId, webstrateId, nodeId);
		});
	}

	if (userClients[userId]) {
		delete userClients[userId][socketId];
	}

	var partFn = function() {
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

	nodeIds[webstrateId][nodeId].push(socketId);
};

/**
 * Unsubscribe client from signals on a node in a webstrate.
 * @param {string} socketId    SocketId.
 * @param {string} webstrateId WebstrateId.
 * @param {string} nodeId      NodeId.
 * @public
 */
module.exports.unsubscribe = function(socketId, webstrateId, nodeId) {
	if (!nodeIds[webstrateId] || !nodeIds[webstrateId][nodeId]) {
		return;
	}

	var socketIdIdx = nodeIds[webstrateId][nodeId].indexOf(socketId);
	nodeIds[webstrateId][nodeId].splice(socketIdIdx, 1);

	var nodeIdIdx = clients[socketId].webstrates[webstrateId].indexOf(nodeId);
	clients[socketId].webstrates[webstrateId].splice(nodeIdIdx, 1);
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

	(recipients || Array.from(webstrates[webstrateId].keys())).forEach(function(recipientId) {
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
	if (!webstrates[webstrateId]) {
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
	message.c = 'webstrates';

	// If we don't have the client's socket (e.g. it has already disconnected), we can't send
	// the message, and that's fine.
	if (!clients[socketId]) {
		return false;
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
	if (!webstrates[webstrateId]) {
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
	if (!webstrates[webstrateId] || !userIds[userId]) {
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