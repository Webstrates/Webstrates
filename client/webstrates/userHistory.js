'use strict';
const coreWebsocket = require('./coreWebsocket');
const userObject = require('./userObject');
const coreUtils = require('./coreUtils');

const userHistoryModule = {};

// In static mode, the user object is not being sent to the client.
if (!coreUtils.getLocationObject().staticMode && userObject.publicObject) {
	const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));

	userObject.publicObject.history = (options) => new Promise((accept, reject) => {
		websocket.send({ wa: 'userHistory', options }, (err, res) => {
			if (err) reject(err);
			else accept(res);
		});
	});
}

module.exports = userHistoryModule;