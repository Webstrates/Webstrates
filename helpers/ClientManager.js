"use strict";

var shortId = require('shortid');

/**
 * ClientManager constructor.
 * @constructor
 */
module.exports = (function() {
	var module = {};

	// One-to-one mapping from socketIds to client sockets as well as one-to-many mapping from
	// socketId to webstrateIds.
	var clients = {};

	// One-to-many mapping from webstrateIds to clientIds. This could be derived from `clients`, but
	// this is faster.
	var webstrates = {};

	/**
	 * Add client to ClientManager.
	 * @param  {Socket} client Client socket.
	 * @return {string}        Generated socketId.
	 * @public
	 */
	module.addClient = function(client) {
		var socketId = shortId.generate();
		clients[socketId] = {
			socket: client,
			webstrateIds: []
		};

		return socketId;
	}

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

		clients[socketId].webstrateIds.forEach(function(webstrateId) {
			module.removeClientFromWebstrate(socketId, webstrateId);
		});

		delete clients[socketId];
	}

	/**
	 * Add client to Webstrate and broadcast join.
	 * @param {string} socketId    socketId.
	 * @param {string} webstrateId webstrateId.
	 * @public
	 */
	module.addClientToWebstrate = function(socketId, webstrateId) {
		if (!webstrates[webstrateId]) {
			webstrates[webstrateId] = [];
		}

		sendToClient(socketId, {
			wa: "hello",
			id: socketId,
			c: "webstrates",
			d: webstrateId,
			clients: webstrates[webstrateId]
		});

		broadcastToWebstrateClients(webstrateId, {
			wa: "clientJoin",
			id: socketId,
			c: "webstrates",
			d: webstrateId
		});

		webstrates[webstrateId].push(socketId);
		clients[socketId].webstrateIds.push(webstrateId);
	}

	/**
	 * Remove client from webstrate and broadcast departure.
	 * @param {string} socketId    SocketId.
	 * @param {string} webstrateId WebstrateId.
	 * @public
	 */
	module.removeClientFromWebstrate = function(socketId, webstrateId) {
		var socketIdIdx = webstrates[webstrateId].indexOf(socketId);
		webstrates[webstrateId].splice(socketIdIdx, 1);

		var webstrateIdIdx = clients[socketId].webstrateIds.indexOf(webstrateId);
		clients[socketId].webstrateIds.splice(webstrateIdIdx, 1);

		broadcastToWebstrateClients(webstrateId, {
			wa: "clientPart",
			id: socketId,
			c: "webstrates",
			d: webstrateId
		});
	}

	/**
	 * Send message to all clients currently connected to a webstrate.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {string} message     Message.
	 */
	function broadcastToWebstrateClients(webstrateId, message) {
		if (!webstrates[webstrateId]) {
			return;
		}
		webstrates[webstrateId].forEach(function(socketId) {
			sendToClient(socketId, message);
		});
	}

	/**
	 * Send message to client by socketId.
	 * @param  {string} socketId SocketId.
	 * @param  {string} message  Message.
	 * @return {bool}            True on success, false on failure.
	 */
	function sendToClient(socketId, message) {
		try {
			clients[socketId].socket.send(JSON.stringify(message));
		} catch (e) {
			module.removeClient(socketId);
			return false;
		}
		return true;
	}

	return module;
}());