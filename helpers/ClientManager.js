"use strict";

var shortId = require('shortid');

/**
 * ClientManager constructor.
 * @constructor
 */
module.exports = function(cookieHelper, pubsub) {
	var PUBSUB_CHANNEL = "webstratesClients";
	var module = {};

	// One-to-one mapping from socketIds to client sockets as well as one-to-many mapping from
	// socketId to webstrateIds.
	var clients = {};

	// One-to-many mapping from webstrateIds to socketIds. This could be derived from `clients`, but
	// this is faster.
	var webstrates = {};

	// One-to-many mapping from webstrateIds to nodeIds as well as one-to-many mapping from nodeIds
	// to socketIds.
	var nodeIds = {};

	// One-to-one mapping from socketIds to `clientJoin` trigger function and its associated
	// setTimeout id.
	var joinTimeouts = {};

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
				default:
					console.warn("Unknown action", message);
			}
		});
	}

	/**
	 * Add client to ClientManager.
	 * @param  {Socket} client Client socket.
	 * @return {string}        Generated socketId.
	 * @public
	 */
	module.addClient = function(client) {
		var socketId = shortId.generate();
		var cookie = cookieHelper.decodeCookie(client.upgradeReq.headers.cookie);
		var user = (cookie && cookie.passport.user) || {};

		clients[socketId] = {
			socket: client,
			user: {
				userId: user.userId,
				username: user.username,
				provider: user.provider,
				displayName: user.displayName
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

		var msgObj = {
			wa: "clientJoin",
			id: socketId,
			d: webstrateId
		};

		if (!local) {
			broadcastToWebstrateClients(webstrateId, msgObj);
			return;
		}

		module.sendToClient(socketId, {
			wa: "hello",
			id: socketId,
			d: webstrateId,
			user: clients[socketId].user,
			clients: webstrates[webstrateId]
		});

		clients[socketId].webstrates[webstrateId] = [];

		var joinTriggerFn = function() {
			// If the client has already left (i.e. removeClientFromWebstrate was triggered), there's no
			// reason to broadcast the clientJoin.
			if (!webstrates[webstrateId].includes(socketId)) {
				return;
			}

			broadcastToWebstrateClients(webstrateId, msgObj);

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

		if (local && pubsub.publisher) {
			pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
				action: "publish", senderSocketId, webstrateId, nodeId, message,
				recipients: unknownRecipients, WORKER_ID
			}));
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
	 * @param  {string} message     Message.
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

	return module;
};