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

async function updateCookie(key, value, isAnywhere = false) {
	var updateObj = {
		wa: 'cookieUpdate',
		update: { key, value }
	};
	if (!isAnywhere) {
		updateObj.d = globalObject.publicObject.webstrateId;
	}
	await new Promise((resolve, reject)=>{
		let callback = (err,val)=>{
			if (err) reject(err);
			resolve(val);
		};		
		websocket.send(updateObj, callback);
	});
}

async function fetchCookie(key, isAnywhere = false) {
	var request = {
		wa: 'cookieFetch',
		cookie: key
	};
	if (!isAnywhere) {
		request.d = globalObject.publicObject.webstrateId;
	}

	let answer = await new Promise((resolve, reject)=>{
		let callback = (err,val)=>{
			if (err) reject(err);
			resolve(val);
		};
		websocket.send(request, callback);
	});
	return answer;
}

websocket.onjsonmessage = (message) => {
	switch (message.wa) {
		case 'hello':
			if (message.d !== webstrateId) return;

			// Only allow cookies if the user object exists, i.e. is logged in with OAuth.
			if (userObject.publicObject.userId && userObject.publicObject.userId !== 'anonymous:') {
				userObject.publicObject.cookies = {
					anywhere: {
						get: async function(key) {
							return await fetchCookie(key, true);
						},
						set: async function(key, value) {
							await updateCookie(key, value, true);
						}
					},
					here: {
						get: async function(key) {
							return await fetchCookie(key, false);
						},
						set: async function(key, value) {
							await updateCookie(key, value, false);
						}
					}
				};
			}
			break;
		case 'cookieUpdate':
			if (typeof message.d !== 'undefined' && message.d !== webstrateId) return;

			var [key, value] = [message.update.key, message.update.value];
			if (message.d) {
				globalObject.triggerEvent('cookieUpdateHere', key, value);
			} else {
				globalObject.triggerEvent('cookieUpdateAnywhere', key, value);
			}
			break;
	}
};

module.exports = cookiesModule;