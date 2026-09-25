'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

const deleteEventModule = {};

// Internal event that other modules may subscribe to, and a userland event, both triggered
// when the webstrate has been deleted (by any client, including this one, through
// `/<webstrateId>/?delete`).
coreEvents.createEvent('deleted');
globalObject.createEvent('deleted');

const webstrateId = coreUtils.getLocationObject().webstrateId;

const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));

websocket.onjsonmessage = (message) => {
	// Ignore messages intended for other webstrates sharing the same websocket.
	if (message.d !== webstrateId) return;

	if (message.wa === 'delete') {
		coreEvents.triggerEvent('deleted', message.d);
		globalObject.triggerEvent('deleted', message.d);

		// The webstrate no longer exists on the server, so there is nothing left to
		// synchronize. Redirect the client to the front page, as the documentation
		// promises.
		//
		// Two precautions:
		//
		// 1. The delete broadcast races the ?delete HTTP response (the server
		//    broadcasts before it responds), so we wait a moment before deciding
		//    whether to redirect: the ?delete response marks the *deleting* browser
		//    with a short-lived `webstrates-deleted-<id>` cookie (see
		//    HttpRequestController.deleteWebstrate) and already navigates that
		//    browser to `/` by itself. If, by the time we check, we can see that
		//    cookie, this browser is the deleting one — redirecting again would only
		//    race and abort the navigation that's already in flight, so we skip.
		//    (All of this browser's tabs see the same cookie; every other browser
		//    redirects.)
		//
		// 2. We use location.replace, rather than location.assign or setting
		//    location.href, so the deleted webstrate doesn't linger in the session
		//    history: navigating back to a deleted webstrate would just recreate it.
		setTimeout(() => {
			const deletedHere = document.cookie
				.split(';')
				.map(cookie => cookie.trim())
				.includes(`webstrates-deleted-${webstrateId}=1`);

			if (!deletedHere) {
				window.location.replace('/');
			}
		}, 250);
	}
};

module.exports = deleteEventModule;
