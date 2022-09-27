'use strict';
const coreUtils = require('./coreUtils');
const globalObject = require('./globalObject');

const coreWebsocketModule = {};
const webstrateId = coreUtils.getLocationObject().webstrateId;

let url, protocols, websocket, forceClose, reconnectAttempts;
const copies = [];

// If somebody tries to send a message with websocket.sendWhenReady while we're not connected, we
// queue the message to be sent once connected. This is that queue. Once a queue has been drained,
// we reinitialize it to a new list, so we can't use const.
let queue = [];

// A map from tokens to callback functions: str -> fn.
const callbacks = new Map();

/**
 * Calculates increasing reconnection delay based on number of reconnection attempts:
 * Starting with: 1s, 1.5s, 2.3s, 3.4s, 5.0s, 7.6s, 11.4s, 17.0s, 25.6s, 38.4s, 57.7s, etc.
 * @return {Number} Next reconnection interval in seconds.
 * @private
 */
function reconnectDelay() {
	return 1000 * Math.pow(1.5, reconnectAttempts++);
}

// Having multiple subscriptions to the same webstrate causes ShareDB to behave oddly and cut
// off parts of operations for (so far) unknown reasons. As a result, getDocument() above will
// return nothing if a subcription to the document already exists.
const subscriptions = new Set();
Object.defineProperty(globalObject.publicObject, 'getWebsocket', {
	value: (filter, webstrateId) => {
		if (typeof filter === 'string') {
			webstrateId = filter;
		}
		if (subscriptions.has(webstrateId)) return;
		subscriptions.add(webstrateId);
		return coreWebsocketModule.copy();
	}
});

coreWebsocketModule.setup = (_url, _protocols) => {

	url = _url;
	protocols = _protocols;

	if (coreUtils.isTranscluded() && coreUtils.sameParentDomain() && config.reuseWebsocket) {
		websocket = window.parent.window.webstrate.getWebsocket(webstrateId);
	}

	// Even if we're transcluded, we won't succeed in getting a websocket from our parent if another
	// subscription on the same webstrate already exists.
	if (!websocket || websocket.readyState === WebSocket.CLOSED) {
		websocket = new WebSocket(url, protocols);
	}

	forceClose = false;

	websocket.onopen = event => {
		// Drain queue and empty it.
		queue.forEach(data => websocket.send(data));
		queue = [];

		reconnectAttempts = 0;
		copies.forEach(({ websocket }) =>
			typeof websocket.onopen === 'function' && websocket.onopen(event));
	};

	websocket.onclose = event => {
		copies.forEach(({ websocket }) =>
			typeof websocket.onclose === 'function' && websocket.onclose(event));

		if (!forceClose) {
			reconnectAttempts++;
			setTimeout(() => {
				coreWebsocketModule.setup(url, protocols);
			}, reconnectDelay());
		}
	};

	websocket.onconnecting = event => {
		copies.forEach(({ websocket }) =>
			typeof websocket.onconnecting === 'function' && websocket.onconnecting(event));
	};

	websocket.onmessage = event => {
		let parsedData;

		// If the message has a reply attached, it means it's an answer to a specific request, and not
		// something that should just be sent to everybody. Therefore, we find the requester in the
		// callback map, call the callback function, and then terminate.
		if (event.data.startsWith('{"wa":"reply"')) {
			parsedData = JSON.parse(event.data);
			const token = parsedData.token;
			if (token && callbacks.has(token)) {
				const callback = callbacks.get(token);
				callbacks.delete(token);
				callback(parsedData.error, parsedData.reply);
			}
			return;
		}

		copies.forEach(({ websocket, filter }) => {
			if (!filter || filter(event)) {
				if (typeof websocket.onmessage === 'function') {
					websocket.onmessage(event);
				}
				// As an optimization, we add a custom onjsonmessage event to websockets, so every websocket
				// copy doesn't have to parse the same data.
				if (typeof websocket.onjsonmessage === 'function') {
					if (parsedData === undefined) {
						parsedData = Object.freeze(JSON.parse(event.data));
					}
					websocket.onjsonmessage(parsedData);
				}
			}
		});
	};

	websocket.onerror = event => {
		copies.forEach(({ websocket }) =>
			typeof websocket.onerror === 'function' && websocket.onerror(event));
	};
};

/**
 * Get a copy of the websocket, allowing modules to treat it like their own and overwrite onopen,
 * onmessage, etc. without fear of overwriting other modules' callbacks.
 * @param  {function} filter A filter function, allowing users to filter messages before receiving
 *                           them.
 * @return {WebSocket}       A WebSocket (almost up to specification).
 * @public
 */
coreWebsocketModule.copy = filter => {

	const copy = {
		send: coreWebsocketModule.send,
		close: () => {
			forceClose = true;
			websocket.close();
		},
		refresh: () => {
			websocket.close();
		},
		url: url,
		URL: url,
		protocols: protocols,
		get readyState() {
			return websocket.readyState;
		}
	};

	copies.push({ websocket: copy, filter });
	return copy;
};

/**
 * Send messages through the websocket. This is possible both directly through coreWebsocket.send
 * (as defined here) or through a websocket copy. Some modules may not need the websocket for more
 * than sending a message, in which case there's no reason to create a copy.
 * The method signature does not exactly adhere to the specification.
 * @param  {mixed}   data      The data to be sent. According to the specification, this should be
 *                             string, but we allow objects as well, which we then stringify.
 * @param  {Function} callback A callback function to be called when the server replies to the
 *                             message. This is done by attaching a token to the message and having
 *                             the server reply with the same token.
 * @param  {Object}   options  Allows setting certain properties. Currently only `waitForOpen`.
 *                             When set, if somebody tries to send a message over the websocket
 *                             before it has been opened, the message gets queued to be sent once
 *                             connected.
 * @public
 */
coreWebsocketModule.send = (data, callback, options = {}) => {
	// Allow the user to specify a callback to be called when the server replies. This requires
	// the server to implment the token functionality as well, so it must be used with care, as
	// not all type of messages can handle callbacks.
	if (typeof callback === 'function') {
		if (typeof data === 'string') {
			data = JSON.parse(data);
		}
		const token = coreUtils.randomString();
		data.token = token;
		callbacks.set(token, callback);
	}

	// If we attempt to send an object, we convert it to JSON first. This isn't part of the
	// WebSocket specification, but it's nice to have.
	if (typeof data === 'object') {
		data = JSON.stringify(data);
	}

	// Always send the message if we can. If we can't, try anyway, or if waitForOpen is specified,
	// add it to a queue for it to be sent later.
	if (websocket.readyState === WebSocket.OPEN || !options.waitForOpen) {
		websocket.send(data);
	} else {
		queue.push(data);
	}
};

module.exports = coreWebsocketModule;