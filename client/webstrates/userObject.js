'use strict';
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const loadedEvent = require('./loadedEvent');
const coreUtils = require('./coreUtils');

const userObjectModule = {};

// In static mode, the user object is not being sent to the client.
if (!coreUtils.getLocationObject().staticMode) {
	coreEvents.createEvent('userObjectAdded');

	// Delay the loaded event, until the 'userObjectAdded' event has been triggered.
	loadedEvent.delayUntil('userObjectAdded');

	const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));

	// Public user object
	const publicObject = {};

	let clientId;

	userObjectModule.publicObject = publicObject;
	globalObject.publicObject.user = publicObject;

	websocket.onjsonmessage = (message) => {
		switch (message.wa) {
			case 'hello': {
				// Merge the incoming information with the existing user object. We don't overwrite it, as
				// other modules may already have added their own stuff.
				Object.assign(publicObject, message.user);
				clientId = message.id;
				coreEvents.triggerEvent('userObjectAdded');
				break;
			}

			case 'userClientJoin': {
				const joiningClientId = message.id;
				const isOwnJoin = clientId === joiningClientId;
				// Own join will already be in the client list.
				if (!isOwnJoin && publicObject.clients) {
					publicObject.clients.push(joiningClientId);
				}
				// Registers joins from the same user in other webstrates, from other devices, etc.
				if (message.userClient && publicObject.allClients) {
					publicObject.allClients[message.id] = message.userClient;
				}
				break;
			}

			// There is no specific 'userClientPart' command, because we can just try to remove all
			// parting clients from the user clients list.
			case 'clientPart': {
				// ClientId and socketId are the same.
				const partingClientId = message.id;
				if (publicObject.clients) {
					const userIdx = publicObject.clients.indexOf(partingClientId);
					if (userIdx !== -1) {
						publicObject.clients.splice(userIdx, 1);
					}
				}
				if (publicObject.allClients) {
					delete publicObject.allClients[partingClientId];
				}
				break;
			}
		}
	};


	// Map from event names to a set of the actual listeners: string -> set of listeners.
	const eventListeners = {};
	// Map from event names to actual listeners: string -> function.
	const addEventListenerListeners = {};
	// Map from event names to actual listeners: string -> function.
	const removeEventListenerListeners = {};

	userObjectModule.eventExists = (eventName) => eventListeners.hasOwnProperty(eventName);

	userObjectModule.createEvent = (eventName, options = {}) => {
		if (userObjectModule.eventExists(eventName) && !options.idempotent) {
			throw new Error(`Event ${eventName} already exists.`);
		}

		if (typeof options.addListener !== 'undefined') {
			if (typeof options.addListener !== 'function') {
				throw new Error(`addListener must be a function, received: ${options.addListener}`);
			}
			addEventListenerListeners[eventName] = options.addListener;
		}

		if (typeof options.removeListener !== 'undefined') {
			if (typeof options.removeListener !== 'function') {
				throw new Error(`removeListener must be a function, received: ${options.removeListener}`);
			}
			removeEventListenerListeners[eventName] = options.removeListener;
		}

		if (!userObjectModule.eventExists(eventName)) {
			eventListeners[eventName] = new Set();
		}
	};

	userObjectModule.triggerEvent = (eventName, ...args) => {
		if (!userObjectModule.eventExists(eventName)) {
			throw new Error(`Event ${eventName} doesn't exist.`);
		}
		eventListeners[eventName].forEach(eventListener => {
			setImmediate(eventListener, ...args);
		});
	};

	publicObject.on = (eventName, eventListener) => {
		if (!userObjectModule.eventExists(eventName)) {
			throw new Error(`Event ${eventName} doesn't exist.`);
		}
		eventListeners[eventName].add(eventListener);
		if (addEventListenerListeners[eventName]) {
			addEventListenerListeners[eventName](eventListener);
		}
	};

	publicObject.off = (eventName, eventListener) => {
		if (!userObjectModule.eventExists(eventName)) {
			throw new Error(`Event ${eventName} doesn't exist.`);
		}
		eventListeners[eventName].delete(eventListener);
		if (removeEventListenerListeners[eventName]) {
			removeEventListenerListeners[eventName](eventListener);
		}
	};
}

module.exports = userObjectModule;