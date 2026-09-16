'use strict';

const shortId = require('shortid');
const db = require(APP_PATH + '/helpers/database.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');

// Mapping from socketId to userId: string -> string.
var socketUserMap = new Map();

/**
 * Creates a mapping from socketId to userId. Called by ClientManager.
 * @param  {string} socketId SocketId.
 * @param  {string} userId   UserId.
 * @public
 */
module.exports.clientAdded = function(socketId, userId) {
	socketUserMap.set(socketId, userId);
};

/**
 * Removes a mapping from socketId to userId. Called by ClientManager when a client disconnects.
 * Without this, socketUserMap grew by one entry per connection and never shrank. 
 * Idempotent, as removeClient may be invoked more than once for the same socketId.
 * @param  {string} socketId SocketId.
 * @public
 */
module.exports.clientRemoved = function(socketId) {
	socketUserMap.delete(socketId);
};

/**
 * Send a message to a client (or clients), either by socketId (temporary ID assigned each
 * connection) or userId (username:provider combination).
 * @param  {mixed} recipients Recipient or list of recipients. Either socketIds or userId.
 * @param  {mixed} message    Messages (any type).
 * @param  {[type]} senderId  SenderId
 * @public
 */
module.exports.sendMessage = async function(recipients, message, senderId) {
	if (Array.isArray(recipients)) {
		return await Promise.all(recipients.map(recipient=>{
			return module.exports.sendMessage(recipient, message, senderId); // no await here
		}));
	}

	// Only single recipients from here on:
	const recipient = recipients;
	const userId = typeof recipient === 'string' && recipient.includes(':') ? recipient
		: socketUserMap.get(recipient);

	if (!userId) {
		console.error('Invalid recipient', recipient, senderId, message);
		return;
	}

	// Send it
	const messageId = shortId.generate();
	broadcastToUserEverywhere(userId, messageId, message, senderId);
	saveMessage(userId, messageId, message, senderId);
};

/**
 * Send message to client.
 * @private
 */
function broadcastToUserEverywhere(userId, messageId, message, senderId) {
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
 * @return {list}              (async) List of messages.
 * @public
 */
module.exports.getMessages = async function(userId) {
	return await db.messages.find({ userId }, { _id: 0 }).toArray();
};

/**
 * Delete a single message for a user.
 * @param  {string} userId    UserId.
 * @param  {string} messageId MessageId.
 * @public
 */
module.exports.deleteMessage = async function(userId, messageId) {
	if (!userId || !messageId) return;

	clientManager.broadcastToUserClients(userId, {
		wa: 'messageDeleted', messageId
	});

	await db.messages.deleteOne({ userId, messageId });
};


/**
 * Delete all messages for a user.
 * @param  {string} userId UserId.
 * @public
 */
module.exports.deleteAllMessages = async function(userId) {
	if (!userId) return;

	clientManager.broadcastToUserClients(userId, {
		wa: 'allMessagesDeleted'
	});

	await db.messages.deleteMany({ userId });
};

/**
 * Save a message to the database.
 * @param  {string} userId    UserId (username:provider combination or socketId/clientId).
 * @param  {string} messageId Unique Id generate for the message.
 * @param  {mixed} message    Message (any type).
 * @param  {string} senderId  SenderId.
 * @private
 */
async function saveMessage(userId, messageId, message, senderId) {
	await db.messages.insertOne({
		userId,
		messageId,
		message,
		senderId,
		createdAt: new Date()
	});
}
