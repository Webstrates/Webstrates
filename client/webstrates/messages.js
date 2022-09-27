'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

const messagesModule = {};

// Messaging is disabled in static mode, because no 'hello' message is received, there's no client
// list, etc.
if (!coreUtils.getLocationObject().staticMode) {
	// Create internal event that other modules may subscribe to
	coreEvents.createEvent('messageReceived');
	coreEvents.createEvent('messageSent');
	coreEvents.createEvent('messageDeleted');
	coreEvents.createEvent('allMessagesDeleted');

	// Create event in userland.
	globalObject.createEvent('messageReceived');
	globalObject.createEvent('messageDeleted');

	const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));

	let messages;

	const defineMessageProperties = () => {
		// If we're reconnecting, these properties will already exist.
		if (globalObject.publicObject.messages) return;

		Object.defineProperty(globalObject.publicObject, 'messages', {
			get: () => {
				return coreUtils.objectCloneAndLock(messages);
			},
			set: () => {
				throw new Error('webstrate.messages is read-only. Use webstrate.deleteMessage(messageId) ' +
				'or webstrate.deleteMessages() to delete a message');
			}
		});

		Object.defineProperty(globalObject.publicObject, 'message', {
			value: (message, recipients) => {
				const msgObj = {
					wa: 'sendMessage',
					m: message,
					recipients
				};
				websocket.send(msgObj);
			},
			writable: false
		});

		Object.defineProperty(globalObject.publicObject, 'deleteMessage', {
			value: messageId => {
				websocket.send({
					wa: 'deleteMessage', messageId
				});
				return !!messages.find(message => message.messageId === messageId);
			},
			writable: false
		});

		Object.defineProperty(globalObject.publicObject, 'deleteAllMessages', {
			value: () => {
				messages = [];
				websocket.send({
					wa: 'deleteAllMessages'
				});
				return true;
			},
			writable: false
		});
	};

	websocket.onjsonmessage = (message) => {
		switch (message.wa) {
			case 'hello': {
				messages = message.messages || [];
				messages.forEach(message => Object.freeze(message));
				if (message.user.userId !== 'anonymous:') {
					defineMessageProperties();
				}
				break;
			}
			case 'message': {
				message = {
					messageId: message.messageId,
					message: message.message,
					senderId: message.senderId
				};
				Object.freeze(message);
				messages.push(message);
				coreEvents.triggerEvent('messageReceived', message);
				globalObject.triggerEvent('messageReceived', message.message, message.senderId,
					message.messageId);
				break;
			}
			case 'messageDeleted': {
				const messageIndex = messages.findIndex(m => m.messageId === message.messageId);
				if (messageIndex === -1) return;
				messages.splice(messageIndex, 1);
				coreEvents.triggerEvent('messageDeleted', message);
				globalObject.triggerEvent('messageDeleted', message.messageId);
				break;
			}
			case 'allMessagesDeleted': {
				const oldMessages = messages;
				messages = [];
				coreEvents.triggerEvent('allMessagesDeleted', message);
				oldMessages.forEach(message =>
					globalObject.triggerEvent('messageDeleted', message.messageId));
				break;
			}
		}
	};

	coreEvents.addEventListener('loadedTriggered', () => {
		if (messages.length > 0) {
			messages.forEach(message => {
				coreEvents.triggerEvent('messageReceived', message);
				globalObject.triggerEvent('messageReceived', message.message, message.senderId,
					message.messageId);
			});
		}
	});
}

module.exports = messagesModule;