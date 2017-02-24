"use strict";

var shortId = require('shortid');

/**
 * ClientManager constructor.
 * @constructor
 */
module.exports = function(cookieHelper, db, pubsub) {
	var PUBSUB_CHANNEL = "webstratesClients";
	var module = {};

	// One-to-one mapping from socketIds to client sockets as well as one-to-many mapping from
	// socketId to webstrateIds. clients holds all clients connected to this server instance, but not
	// remote clients.
	var clients = {};

	// One-to-many mapping from webstrateIds to socketIds. webstrates holds a list of all clients
	// connected in all webstrates, including remote clients.
	var webstrates = {};

	// One-to-many mapping from webstrateIds to nodeIds as well as one-to-many mapping from nodeIds
	// to socketIds.
	var nodeIds = {};

	// One-to-one mapping from socketIds to `clientJoin` trigger function and its associated
	// setTimeout id.
	var joinTimeouts = {};

	// One-to-many mapping from userId to socketIds. Used for communicating cookie updates.
	var userIds = {}

	// Listen for events happening on other server instances. This is only used when using multi-
	// threading and Redis.
	if (pubsub) {
		pubsub.subscriber.subscribe(PUBSUB_CHANNEL);
		pubsub.subscriber.on("message", function(channel, message) {

			// Ignore messages on other channels.
			if (channel !== PUBSUB_CHANNEL) {
				return;
			}

			message = JSON.parse(message);

			// Ignore messages from ourselves.
			if (message.WORKER_ID === WORKER_ID) {
				return;
			}

			switch (message.action) {
				case "clientJoin":
					module.addClientToWebstrate(message.socketId, message.webstrateId);
					break;
				case "clientPart":
					module.removeClientFromWebstrate(message.socketId, message.webstrateId);
					break;
				case "publish":
					module.publish(message.senderSocketId, message.webstrateId, message.nodeId,
						message.message, message.recipients);
					break;
				case "signalUserObject":
					module.signalUserObject(message.userId, message.senderSocketId, message.message);
					break;
				case "cookieUpdate":
					module.updateCookie(message.userId, message.webstrateId, message.update.key,
						message.update.value);
					break;
				default:
					console.warn("Unknown action", message);
			}
		});
	}

	/**
	 * Add client to ClientManager.
	 * @param  {Socket} client Client socket.
	 * @param  {obj}    user   User object (OAuth credentials).
	 * @return {string}        Generated socketId.
	 * @public
	 */
	module.addClient = function(client) {
		var socketId = shortId.generate();

		if (!userIds[client.user.userId]) userIds[client.user.userId] = [];
		userIds[client.user.userId].push(socketId);

		clients[socketId] = {
			socket: client,
			user: {
				userId: client.user.userId,
				username: client.user.username,
				provider: client.user.provider,
				displayName: client.user.displayName,
				userUrl: client.user._json && client.user._json.html_url,
				avatarUrl: client.user._json && client.user._json.avatar_url
			},
			webstrates: {} // contains a one-to-many mapping from webstrateIds to nodeIds.
		};

		return socketId;
	};

	/**
	 * Remove client from all webstrates (and broadcast departure) and remove client itself from
	 * ClientManager.
	 * @param {string} socketId SocketId.
	 * @public
	 */
	module.removeClient = function(socketId) {
		if (!clients[socketId]) {
			return;
		}

		Object.keys(clients[socketId].webstrates).forEach(function(webstrateId) {
			module.removeClientFromWebstrate(socketId, webstrateId, true);
		});

		delete clients[socketId];
	};

	module.triggerJoin = function(socketId) {
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
	 * @param {bool}   local       Whether the client joined locally (on this server instance) or
	 *                             remotely (on another server instance). We should only forward local
	 *                             client joins, otherwise we end up in a livelock where we
	 *                             continuously send the same join back and forth between instances.
	 * @public
	 */
	module.addClientToWebstrate = function(socketId, webstrateId, local) {
		if (!webstrates[webstrateId]) {
			webstrates[webstrateId] = [];
		}

		webstrates[webstrateId].push(socketId);

		var clientJoinMsgObj = {
			wa: "clientJoin",
			id: socketId,
			d: webstrateId
		};

		if (!local) {
			broadcastToWebstrateClients(webstrateId, clientJoinMsgObj);
			return;
		}

		var helloMsgObj = {
			wa: "hello",
			id: socketId,
			d: webstrateId,
			defaultPermissions: global.config.auth && global.config.auth.defaultPermissions,
			user: clients[socketId].user,
			clients: webstrates[webstrateId],
		};

		var userId = clients[socketId].user.userId;

		// If no userId is defined, the user isn't logged in and therefore can't have cookies attached,
		// so let's not waste time looking for them.
		if (!userId) {
			module.sendToClient(socketId, helloMsgObj);
		} else {
			db.cookies.find({ userId, $or: [ { webstrateId }, { webstrateId: { "$exists": false } } ] })
			.toArray(function(err, res) {
				if (err) return console.error(err);

				helloMsgObj.cookies = { here: {}, anywhere: {} };
				// Find the "here" (document) cookies entry in the array, and convert the [{ key, value }]
				// structure into a regular object.
				var documentCookies = res.find(cookie => cookie.webstrateId === webstrateId) || {};
				if (documentCookies.cookies) {
					documentCookies.cookies.forEach(({ key, value }) => helloMsgObj.cookies.here[key] = value);
				}

				// Rinse and repeat for "anywhere" (global) cookies.
				var globalCookies = res.find(cookie => typeof cookie.webstrateId === "undefined") || {};

				if (globalCookies.cookies) {
					globalCookies.cookies.forEach(({ key, value }) => helloMsgObj.cookies.anywhere[key] = value);
				}

				module.sendToClient(socketId, helloMsgObj);
			});
		}

		clients[socketId].webstrates[webstrateId] = [];

		var joinTriggerFn = function() {
			// If the client has already left (i.e. removeClientFromWebstrate was triggered), there's no
			// reason to broadcast the clientJoin.
			if (!webstrates[webstrateId].includes(socketId)) {
				return;
			}

			broadcastToWebstrateClients(webstrateId, clientJoinMsgObj);

			if (pubsub) {
				pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
					action: "clientJoin", socketId, webstrateId, WORKER_ID
				}));
			}
		};

		var timeout = setTimeout(joinTriggerFn, 2000);
		joinTimeouts[socketId] = { timeout, fn: joinTriggerFn };
	};

	/**
	 * Remove client from webstrate and broadcast departure.
	 * @param {string} socketId    SocketId.
	 * @param {string} webstrateId WebstrateId.
	 * @param {bool}   local       Whether the client joined locally (on this server instance) or
	 *                             remotely (on another server instance). We should only forward local
	 *                             client joins, otherwise we end up in a livelock where we
	 *                             continuously send the same join back and forth between instances.
	 * @public
	 */
	module.removeClientFromWebstrate = function(socketId, webstrateId, local) {
		if (local) {
			clients[socketId].webstrates[webstrateId].forEach(function(nodeId) {
				unsubscribe(socketId, webstrateId, nodeId);
			});

			if (pubsub) {
				pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
					action: "clientPart", socketId, webstrateId, WORKER_ID
				}));
			}
		}

		var partFn = function() {
			// In case webstrates[webstrateId] still doesn't exist, let's just give up in trying to remove
			// the client.
			if (!webstrates[webstrateId]) {
				return;
			}

			var socketIdIdx = webstrates[webstrateId].indexOf(socketId);
			webstrates[webstrateId].splice(socketIdIdx, 1);

			broadcastToWebstrateClients(webstrateId, {
				wa: "clientPart",
				id: socketId,
				d: webstrateId
			});
		};

		// Due to the delay in joins, we may end up in a situation where a part is broadcast before a
		// join. In this case, webstrates[webstrateId] may not even be defined. Therefore, before we
		// remove a client from a webstrate, we ensure that the client has already joined.
		// If the client hasn't joined yet, we instead delay the part action with 2 seconds just like
		// the join action has been. That way, we know the client will have joined by the time we remove
		// it. It's a little convoluted, but it's the easiest way to ensure that even brief join/parts
		// get registered to all clients.
		if (webstrates[webstrateId] && webstrates[webstrateId].includes(socketId)) {
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
	module.subscribe = function(socketId, webstrateId, nodeId) {
		// Make sure the client is connected to the webstrate.
		if (!clients[socketId].webstrates[webstrateId]) {
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
	module.unsubscribe = function(socketId, webstrateId, nodeId) {
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
	 * @param {bool}   local          Whether the publis has happened locally (on this server
	 *                                instance) or remotely (on another server instance). We should
	 *                                only forward local publish messages, otherwise we end up in a
	 *                                livelock where we continuously send the same join back and
	 *                                forth between instances.
	 * @public
	 */
	module.publish = function(senderSocketId, webstrateId, nodeId, message, recipients, local) {
		if (!nodeIds[webstrateId]) {
			return;
		}

		// In case we receive a single recipientId instead of an array.
		if (typeof recipients === "string") {
			recipients = [recipients];
		}

		// Messages should be sent to everybody listening on the nodeId and the "document". We use a
		// Set, so we don't send to the same socketId twice.
		var listeners = new Set([...(nodeIds[webstrateId][nodeId] || []),
			...(nodeIds[webstrateId]["document"] || [])]);

		// Register all the recipients we don't know, so we can forward them to other server instances.
		var unknownRecipients = [];
		(recipients || webstrates[webstrateId]).forEach(function(recipientId) {
			// We don't know the client.
			if (!clients[recipientId]) {
				unknownRecipients.push(recipientId);
				return;
			}

			// We know the client, but it isn't listening.
			if (!listeners.has(recipientId)) {
				return;
			}

			// We know the client and it's listening, so let's do this!
			module.sendToClient(recipientId, {
				wa: "publish",
				id: nodeId,
				d: webstrateId,
				s: senderSocketId,
				m: message
			});
		});

		if (local && pubsub) {
			pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
				action: "publish", senderSocketId, webstrateId, nodeId, message,
				recipients: unknownRecipients, WORKER_ID
			}));
		}
	};

	/**
	 * Signal on user object. Any signal made on the user object is sent to all of the user's
	 * connected clients.
	 * @param {string} userId          User Id (of the format <username>:<provider, e.g.
	 *                                 "kbadk:github").
	 * @param {string} senderSocketId  SocketId (= webstrate.clientId on the client).
	 * @param {json}   message         Optional message object.
	 * @param {bool}   local           Whether the publis has happened locally (on this server
	 *                                 instance) or remotely (on another server instance). We should
	 *                                 only forward local publish messages, otherwise we end up in a
	 *                                 livelock where we continuously send the same join back and
	 *                                 forth between instances.
	 * @public
	 */
	module.signalUserObject = function(userId, senderSocketId, message, local) {
		broadcastToUserClients(userId, {
			wa: "signalUserObject",
			s: senderSocketId,
			m: message
		});

		if (local) {
			pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
				action: "signalUserObject", userId, senderSocketId, message
			}));
		}
	};

	/**
	 * Update cookies. Any update made to a user's is sent to all of the user's conneted clients.
	 * @param {string} userId  User Id (of the format <username>:<provider, e.g. "kbadk:github").
	 * @param {string} webstrateId WebstrateId.
	 * @param {string} key         Key to update (or add) in the cookie.
	 * @param {string} value       Value associated with key.
	 * @param {bool}   local       Whether the publis has happened locally (on this server
	 *                             instance) or remotely (on another server instance). We should
	 *                             only forward local publish messages, otherwise we end up in a
	 *                             livelock where we continuously send the same join back and
	 *                             forth between instances.
	 * @public
	 */
	module.updateCookie = function(userId, webstrateId, key, value, local) {
		var updateObj = {
			wa: "cookieUpdate",
			update: { key, value }
		};

		if (webstrateId) {
			updateObj.d = webstrateId;
			broadcastToUserClientsInWebstrate(webstrateId, userId, updateObj);
		} else {
			broadcastToUserClients(userId, updateObj);
		}

		if (local && pubsub) {
			var webstrateIdQuery = webstrateId || { "$exists": false };
			db.cookies.update({ userId, webstrateId: webstrateIdQuery, cookies: { key } },
			{ $set: { "cookies.$.value": value } }, function(err, res) {
				if (err) return console.error(err);
				// If our update didn't update anything, we have to add it first. Maybe this could be done
				// in one query, but as this point, I've given up trying to get clever with MongoDB.
				if (res.result.nModified === 0) {
					db.cookies.update({ userId, webstrateId: webstrateIdQuery },
					// We still have to upsert, because even though the particular cookie key from above
					// doesn't exist, the document may still exist.
					{ $push: { cookies: { key, value } } }, { upsert: true }, function(err, res) {
						if (err) return console.error(err);
						pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
							action: "cookieUpdate", userId, update: { key, value }, webstrateId, WORKER_ID
						}));
					});
				}
				else {
					// Actually, I've stopped trying to be clever altogether. Yes, this is the same as
					// above.
					pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
						action: "cookieUpdate", userId, update: { key, value }, webstrateId, WORKER_ID
					}));
				}
			});
		}
	};

	/**
	 * Send message to clients in a webstrate.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {string} message  Message.
	 * @return {bool}            True on success, false on failure.
	 * @public
	 */
	module.sendToClients = function(webstrateId, message) {
		// We technically can't fail when we don't have to send any messages.
		if (!webstrates[webstrateId]) {
			return true;
		}

		return webstrates[webstrateId].reduce(function(success, socketId) {
			return module.sendToClient(socketId, message) && success;
		}, true);
	};

	/**
	 * Send message to client by socketId.
	 * @param  {string} socketId SocketId.
	 * @param  {string} message  Message.
	 * @return {bool}            True on success, false on failure.
	 * @public
	 */
	module.sendToClient = function(socketId, message) {
		message.c = "webstrates";

		// If we don't have the client's socket, we can't send the message, and that's fine. The client
		// will be connected to another server instance that will also have been told to send the
		// message to the client. In essence, we tell all server instances to send the same message,
		// knowing that only one of them will get past this conditional (and thus send it).
		if (!clients[socketId]) {
			return false;
		}

		try {
			clients[socketId].socket.send(JSON.stringify(message));
		} catch (e) {
			module.removeClient(socketId);
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

		webstrates[webstrateId].forEach(function(socketId) {
			module.sendToClient(socketId, message);
		});
	}

	function broadcastToUserClientsInWebstrate(webstrateId, userId, message) {
		if (!webstrates[webstrateId] || !userIds[userId]) {
			return;
		}

		userIds[userId].forEach(function(socketId) {
			if (webstrates[webstrateId].includes(socketId)) {
				module.sendToClient(socketId, message);
			}
		});
	}

	/**
	 * Send message to all clients currently connected and logged in as userId.
	 * @param  {string} userId  User Id (of the format <username>:<provider, e.g. "kbadk:github").
	 * @param  {obj}    message     Message object.
	 * @private
	 */
	function broadcastToUserClients(userId, message) {
		if (!userIds[userId]) {
			return;
		}

		userIds[userId].forEach(function(socketId) {
			module.sendToClient(socketId, message);
		});
	}

	return module;
};