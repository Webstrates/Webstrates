'use strict';
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

// Create internal events that other modules may subscribe to
coreEvents.createEvent('connect');
coreEvents.createEvent('disconnect');
coreEvents.createEvent('reconnect');

// Create events in userland.
globalObject.createEvent('disconnect');
globalObject.createEvent('reconnect');

const websocket = coreWebsocket.copy();

let previousState = websocket.readyState;

websocket.onopen = (event) => {
	// If this is the first time we're connecting.
	if (previousState === WebSocket.CONNECTING) {
		coreEvents.triggerEvent('connect');
	// If we've been connected before.
	} else if (previousState === WebSocket.CLOSED) {
		coreEvents.triggerEvent('reconnect');
		globalObject.triggerEvent('reconnect');
	}
	previousState = websocket.readyState;
};

websocket.onerror = websocket.onclose = (event) => {
	// When attempting to reconnect, onclose will get triggered on every reconnecion attempt, but we
	// don't want the disconnect event to get triggered every time we fail to connect, so we just
	// check if we're in the same state as before (WebSocket.CLOSED (3)). If we are, we are in a
	// reconnection loop, so there's no reason to fire 'disconnect' again.
	if (previousState === websocket.readyState) return;
	previousState = websocket.readyState;
	coreEvents.triggerEvent('disconnect');
	globalObject.triggerEvent('disconnect');
};