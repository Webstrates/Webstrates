'use strict';
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const userObject = require('./userObject');
const coreUtils = require('./coreUtils');

const cookiesModule = {};

const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));
const webstrateId = coreUtils.getLocationObject().webstrateId;

globalObject.createEvent('cookieUpdateHere');
globalObject.createEvent('cookieUpdateAnywhere');

function updateCookie(key, value, isAnywhere = false) {
	var updateObj = {
		wa: 'cookieUpdate',
		update: { key, value }
	};
	if (!isAnywhere) {
		updateObj.d = globalObject.publicObject.webstrateId;
	}
	websocket.send(updateObj);
}

let cookies;
websocket.onjsonmessage = (message) => {
	switch (message.wa) {
		case 'hello':
			if (message.d !== webstrateId) return;

			cookies = message.cookies || { here: {}, anywhere: {} };

			// Only allow cookies if the user object exists, i.e. is logged in with OAuth.
			if (userObject.publicObject.userId && userObject.publicObject.userId !== 'anonymous:') {
				userObject.publicObject.cookies = {
					anywhere: {
						get: function(key) {
							return key ? cookies.anywhere[key] : cookies.anywhere;
						},
						set: function(key, value) {
							cookies.anywhere[key] = value;
							updateCookie(key, value, true);
						}
					},
					here: {
						get: function(key) {
							return key ? cookies.here[key] : cookies.here;
						},
						set: function(key, value, callback) {
							cookies.here[key] = value;
							updateCookie(key, value, false);
						}
					}
				};
			}
			break;
		case 'cookieUpdate':
			if (typeof message.d !== 'undefined' && message.d !== webstrateId) return;

			var [key, value] = [message.update.key, message.update.value];
			if (message.d) {
				cookies.here[key] = value;
				globalObject.triggerEvent('cookieUpdateHere', key, value);
			} else {
				cookies.anywhere[key] = value;
				globalObject.triggerEvent('cookieUpdateAnywhere', key, value);
			}
			break;
	}
};

module.exports = cookiesModule;