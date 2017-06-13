'use strict';
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const loadedEvent = require('./loadedEvent');

const clientManagerModule = {};

// Create internal events that other modules may subscribe to
coreEvents.createEvent('clientsReceived');
coreEvents.createEvent('clientJoin');
coreEvents.createEvent('clientPart');

// Delay the loaded event, until the 'clientsReceied' event has been triggered.
loadedEvent.delayUntil('clientsReceived');

// Create events in userland.
globalObject.createEvent('clientJoin');
globalObject.createEvent('clientPart');

const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));

websocket.onjsonmessage = (message) => {
	switch (message.wa) {

		case 'hello':
			globalObject.publicObject.clients = message.clients;
			globalObject.publicObject.clientId = message.id;
			coreEvents.triggerEvent('clientsReceived');
			break;

		case 'clientJoin':
			coreEvents.triggerEvent('clientJoin');
			globalObject.triggerEvent('clientJoin');
			break;

		case 'clientPart':
			coreEvents.triggerEvent('clientPart');
			globalObject.triggerEvent('clientPart');
			break;

	}
};

// The server delays firing the 'clientJoin' event until the joining client is ready.
// If we didn't do that, another client might send a message to the joining client immediately after
// the 'clientJoin' event has been triggered. At this point, however, the joining client's scripts
// haven't been run (they usually aren't executed until after the userland 'loaded' event has been
// triggered), so the joining client won't be able to receive the data. Therefore, we delay this
// 'clientJoin' message, until after the userland 'loaded' event has been triggered, so that we know
// the joining client will be ready to handle the reactions of the join.

// Note that if the server doesn't receive a ready event within 2 seconds, it sends it out anyway.
// That way, no clients can linger unnoticed in a document.
coreEvents.addEventListener('loadedTriggered', (webstrateId) => {
	websocket.send({ wa: 'ready', d: webstrateId });
});


module.exports = clientManagerModule;