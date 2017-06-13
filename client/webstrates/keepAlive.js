'use strict';
const coreWebsocket = require('./coreWebsocket');

const websocket = coreWebsocket.copy();
let interval;

websocket.onopen = (event) => {
	interval = setInterval(() => {
		websocket.send({ type: 'alive' });
	}, config.keepAliveInterval * 1000);
};

websocket.onclose = websocket.onerror = (event) => {
	clearInterval(interval);
};