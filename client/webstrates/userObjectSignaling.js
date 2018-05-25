'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const userObject = require('./userObject');

const userObjectSignalingModule = {};

// In static mode, the user object is not being sent to the client, so we can't signal on it.
if (!coreUtils.getLocationObject().staticMode) {
	coreEvents.createEvent('userObjectSignal');
	userObject.createEvent('signal');

	const websocket = coreWebsocket.copy(event => event.data.startsWith('{"wa":"signalUserObject"'));
	const webstrateId = coreUtils.getLocationObject().webstrateId;

	websocket.onjsonmessage = payload => {
		const message = payload.m;
		const senderClientId = payload.s;
		const senderWebstrateId = payload.sw;

		coreEvents.triggerEvent('userObjectSignal', message, senderClientId, senderWebstrateId);
		userObject.triggerEvent('signal', message, senderClientId, senderWebstrateId);
	};

	Object.defineProperty(userObject.publicObject, 'signal', {
		value: (message) => {
			if (!userObject.publicObject.userId || userObject.publicObject.userId === 'anonymous:') {
				throw new Error('User must be logged in to signal on user object.');
			}
			const msgObj = {
				wa: 'signalUserObject',
				d: webstrateId,
				m: message
			};
			websocket.send(msgObj);
		}
	});
}

module.exports = userObjectSignalingModule;