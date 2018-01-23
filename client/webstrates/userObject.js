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
				break;
			}

			// There is no specific 'userClientPart' command, because we can just try to remove all
			// parting clients from the user clients list.
			case 'clientPart': {
				if (publicObject.clients) {
					const partingClientId = message.id;
					const userIdx = publicObject.clients.indexOf(partingClientId);
					if (userIdx !== -1) {
						publicObject.clients.splice(userIdx, 1);
					}
				}
				break;
			}
		}
	};
}
module.exports = userObjectModule;