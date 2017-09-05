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

	userObjectModule.publicObject = publicObject;
	globalObject.publicObject.user = publicObject;

	websocket.onjsonmessage = (message) => {
		if (message.wa === 'hello') {
			// Merge the incoming information with the existing user object. We don't overwrite it, as
			// other modules may already have added their own stuff.
			Object.assign(publicObject, message.user);
			coreEvents.triggerEvent('userObjectAdded');
		}
	};
}
module.exports = userObjectModule;