'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const nodeObjects = require('./nodeObjects');

const signalingModule = {};

coreEvents.createEvent('receivedSignal');

const websocket = coreWebsocket.copy(event => event.data.startsWith('{"wa":"publish"'));
const webstrateId = coreUtils.getLocationObject().webstrateId;

// Allow other modules to add interceptors to signals. An interceptor is function that gets access
// to a signal payload, then decides whether this module should handle the signal as a regular
// signal. For instance, the signal streaming module uses the signaling mechanism to set up
// streaming connections, but we don't want the streaming signals to be triggering regular signals
// on nodes. Therefore, the streaming module intercepts all signals, and handles the streaming
// signals and then returns true to intercept it.
const interceptors = new Set();

signalingModule.addInterceptor = interceptor => interceptors.add(interceptor);
signalingModule.removeInterceptor = interceptor => interceptors.delete(interceptor);

// Allow other modules to subscribe manually to a node. This is useful for interception. E.g. signal
// streaming needs to subscribe to nodes, but subscribing in the "normal" way will be silly, since
// the callback given there will never be triggered, because we intercept all the signals.
signalingModule.subscribe = wid => subscribe(wid);
signalingModule.unsubscribe = wid => unsubscribe(wid);

websocket.onjsonmessage = payload => {
	// Ignore message intended for other webstrates sharing the same websocket.
	if (payload.d !== webstrateId) return;

	let intercepted = false;
	interceptors.forEach(interceptor => {
		intercepted |= interceptor(payload);
	});
	// If any of the interceptors has returned true, we don't want to process the signal, as the
	// intercepting module has already done what needs to be done with it.
	if (intercepted) return;

	const wid = payload.id;
	const node = coreUtils.getElementByWid(wid);
	if (!node && wid !== 'document') {
		return;
	}

	const senderId = payload.s;
	const message = payload.m;
	const eventObject = nodeObjects.getEventObject(node);

	// Trigger event in userland.
	const triggerTarget = node ? eventObject : globalObject;
	triggerTarget.triggerEvent('signal', message, senderId, node);

	// Trigger event internally.
	coreEvents.triggerEvent('receivedSignal', message, senderId, node);
};

// Map of wids to number of subscribers on the wid. Used to resubscribe after a disconnect.
const subscriptions = {};

function signal(wid, message, recipients) {
	const msgObj = {
		wa: 'publish',
		d: webstrateId,
		id: wid,
		m: message
	};
	if (recipients) {
		msgObj.recipients = recipients;
	}
	websocket.send(msgObj);
}

function subscribe(wid) {
	const msgObj = {
		wa: 'subscribe',
		d: webstrateId,
		id: wid
	};
	websocket.send(msgObj);
	subscriptions[wid] = (subscriptions[wid] || 0) + 1;
}

function unsubscribe(wid) {
	subscriptions[wid] = (subscriptions[wid] || 0) - 1;
	if (subscriptions[wid] < 1) {
		const msgObj = {
			wa: 'unsubscribe',
			d: webstrateId,
			id: wid
		};
		websocket.send(msgObj);
		delete subscriptions[wid];
	}
}

function setupSignal(node, publicObject, eventObject) {
	// Text nodes and won't have wids, meaning there's way for us to signal on them, and thus it'd be
	// pointless to add a signaling method and event.
	if (node.nodeType === document.TEXT_NODE) {
		return;
	}

	// If an element doesn't have a wid, it's because we haven't registered it in the DOM yet,
	// meaning nobody can signal on it. However, we still allow users to subscribe to signals on
	// the event, in case the element gets a wid in the next cycle. If it doesn't get a wid in
	// time, we warn the user that they subscribed to a signal that doesn't exist.
	eventObject.createEvent('signal', {
		addListener: () => {
			const wid = publicObject.id;
			if (wid) {
				subscribe(wid);
				return;
			}
			setImmediate(() => {
				const wid = publicObject.id;
				if (wid) {
					subscribe(wid);
					return;
				}
				console.warn(`Signal event listener attached to ${node.outerHTML}, but element can't be`
					+ ' signaled on, because it\'s not in the DOM or is transient.');
			});
		},
		removeListener: () => {
			const wid = publicObject.id;
			unsubscribe(wid);
		}
	});

	Object.defineProperty(publicObject, 'signal', {
		value: (message, recipients) => {
			const wid = publicObject.id;
			if (wid) {
				signal(wid, message, recipients);
				return;
			}
			throw new Error(`Can't signal on ${node.outerHTML}, because it's not in the DOM or is` +
				' transient.');
		},
		writable: false
	});
}

coreEvents.addEventListener('populated', targetElement => {
	setupSignal(targetElement, globalObject.publicObject, globalObject);
});

// Add signal events to all webstrate objects (with a wid) after the document has been populated.
coreEvents.addEventListener('webstrateObjectsAdded', (nodeTree) => {
	coreUtils.recursiveForEach(nodeTree, (node) => {
		const eventObject = nodeObjects.getEventObject(node);
		setupSignal(node, node.webstrate, eventObject);
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// Add signal events to all webstrate objects (with wid) after they're added continually.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	setupSignal(node, node.webstrate, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('reconnect', () => Object.keys(subscriptions).forEach(subscribe));

module.exports = signalingModule;