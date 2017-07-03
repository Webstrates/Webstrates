"use strict";

var shortId = require('shortid');

/**
 * ClientManager constructor.
 * @constructor
 */
module.exports = function(clientManager, db, pubsub) {
	var PUBSUB_CHANNEL = "webstratesMessages";
	var module = {};

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
				case "clientAdded":
					module.clientAdded(message.socketId, message.userId);
				case "message":
					sendMessage(message.userId, message.messageId, message.message, message.senderId);
					break;

				default:
					console.warn("Unknown action", message);
			}
		});
	}

	// Mapping from socketId to userId: string -> string.
	var socketUserMap = new Map();

	/**
	 * Creates a mapping from socketId to userId. Called by ClientManager.
	 * @param  {string} socketId SocketId.
	 * @param  {string} userId   UserId.
	 * @param  {bool} local      Whether the request is done locally or note.
	 * @public
	 */
	module.clientAdded = function(socketId, userId, local) {
		socketUserMap.set(socketId, userId);

		if (local) {
			pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
				action: "clientAdded", socketId, userId, WORKER_ID
			}));
		}
	};

	/**
	 * Send a message to a client (or clients), either by socketId (temporary ID assigned each
	 * connection) or userId (username:provider combination).
	 * @param  {mixed} recipients Recipient or list of recipients. Either socketIds or userId.
	 * @param  {mixed} message    Messages (any type).
	 * @param  {[type]} senderId  SenderId
	 * @param  {bool} local       Whether the request is done locally or note.
	 * @public
	 */
	module.sendMessage = function(recipients, message, senderId, local) {
		if (Array.isArray(recipients)) {
			recipients.forEach(function(recipient) {
				module.sendMessage(recipient, message, senderId, local);
			});
			return;
		}
		var recipient = recipients;

		var userId = typeof recipient === 'string' && recipient.includes(":") ? recipient
			: socketUserMap.get(recipient);

		if (!userId) {
			console.error("Invalid recipient", recipient, senderId, message);
			return;
		}

		var messageId = shortId.generate();

		sendMessage(userId, messageId, message, senderId, local);

		if (local) {
			saveMessage(userId, messageId, message, senderId);
			if (pubsub) {
				pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
					action: "message", userId, messageId, message, senderId, WORKER_ID
				}));
			}
		}
	};

	/**
	 * Send message to client.
	 * @private
	 */
	function sendMessage(userId, messageId, message, senderId) {
		clientManager.broadcastToUserClients(userId, {
			wa: 'message',
			messageId,
			message,
			senderId
		});
	}

	/**
	 * Get all user messages.
	 * @param  {string}   userId   UserId.
	 * @param  {Function} callback Callback.
	 * @return {list}              (async) List of messages.
	 * @public
	 */
	module.getMessages = function(userId, callback) {
		db.messages.find({ userId }, { _id: 0 }).toArray(callback);
	};

	/**
	 * Delete a single message for a user.
	 * @param  {string} userId    UserId.
	 * @param  {string} messageId MessageId.
	 * @public
	 */
	module.deleteMessage = function(userId, messageId) {
		if (!userId || !messageId) return;
		db.messages.deleteOne({ userId, messageId });
	};


	/**
	 * Delete all messages for a user.
	 * @param  {string} userId UserId.
	 * @public
	 */
	module.deleteMessages = function(userId) {
		if (!userId) return;
		db.messages.deleteMany({ userId });
	};

	/**
	 * Save a message to the database.
	 * @param  {string} userId    UserId (username:provider combination or socketId/clientId).
	 * @param  {string} messageId Unique Id generate for the message.
	 * @param  {mixed} message    Message (any type).
	 * @param  {string} senderId  SenderId.
	 * @private
	 */
	function saveMessage(userId, messageId, message, senderId) {
		db.messages.insert({
			userId,
			messageId,
			message,
			senderId,
			createdAt: new Date()
		}, function(err, res) {
			if (err) console.error(err);
		});
	}

	return module;
};