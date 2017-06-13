'use strict';
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

// Create internal events that other modules may subscribe to
coreEvents.createEvent('connect');
coreEvents.createEvent('disconnect');
coreEvents.createEvent('reconnect');

// Create events in userland.
globalObject.createEvent('connect');
globalObject.createEvent('disconnect');
globalObject.createEvent('reconnect');

const websocket = coreWebsocket.copy();

let previousState = websocket.readyState;

websocket.onopen = (event) => {
	// If this is the first time we're connecting.
	if (previousState === WebSocket.CONNECTING) {
		coreEvents.triggerEvent('connect');
		globalObject.triggerEvent('connect');
	// If we've been connected before.
	} else if (previousState === WebSocket.CLOSED) {
		coreEvents.triggerEvent('reconnect');
		globalObject.triggerEvent('reconnect');
	}
	previousState = websocket.readyState;
};

websocket.onerror = websocket.onclose = (event) => {
	previousState = websocket.readyState;
	coreEvents.triggerEvent('disconnect');
	globalObject.triggerEvent('disconnect');
};