'use strict';
const coreEventsModule = {};

// Map from event names to a set of the actual listeners: string -> set of listeners.
const eventListeners = {};
// Map from event names to actual listeners: string -> function.
const addEventListenerListeners = {};
// Map from event names to actual listeners: string -> function.
const removeEventListenerListeners = {};

const priorities = {
	IMMEDIATE: 0,
	HIGH: 1,
	MEDIUM: 2,
	LOW: 3,
	LAST: 4
};

coreEventsModule.PRIORITY = new Proxy(priorities, {
	get: (target, name) => {
		if (name in target) return target[name];
		throw new Error(`Invalid priority ${name}`);
	}
});

/**
* Create new event.
* @param  {string}  eventName  Event name.
* @param  {object} options     An object of options:
*                              idempotent:      Whether we allow the same event to be created
*                                               multiple times without throwing an error.
*                              addListener:     A callback to be triggered when an eventListener
*                                               gets added.
*                              removeListener:  A callback to be triggered when an eventListener
*                                               gets added.

* @public
*/
coreEventsModule.createEvent = (eventName, options = {}) => {
	if (coreEventsModule.eventExists(eventName) && !options.idempotent) {
		throw new Error(`Event ${eventName} already exists.`);
	}

	if (typeof options.addListener !== 'undefined') {
		if (typeof options.addListener !== 'function') {
			throw new Error(`addListener must be a function, received: ${options.addListener}.`);
		}
		addEventListenerListeners[eventName] = options.addListener;
	}

	if (typeof options.removeListener !== 'undefined') {
		if (typeof options.removeListener !== 'function') {
			throw new Error(`removeListener must be a function, received: ${options.removeListener}.`);
		}
		removeEventListenerListeners[eventName] = options.removeListener;
	}

	if (!eventListeners[eventName]) {
		eventListeners[eventName] = new Set();
	}
};

coreEventsModule.eventExists = (eventName) => eventListeners.hasOwnProperty(eventName);

coreEventsModule.addEventListener = (eventName, eventListener,
	priority = coreEventsModule.PRIORITY.LOW, options) => {

	eventListener.priority = priority;
	if (!coreEventsModule.eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}

	if (eventListeners[eventName].has(eventListener)) {
		throw new Error(`EventListener already attacehd to ${eventName}.`);
	}
	eventListeners[eventName].add(eventListener);
	if (addEventListenerListeners[eventName]) {
		addEventListenerListeners[eventName](eventListener);
	}

};

coreEventsModule.removeEventListener = (eventName, eventListener) => {
	if (!coreEventsModule.eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}
	eventListeners[eventName].delete(eventListener);
	if (removeEventListenerListeners[eventName]) {
		removeEventListenerListeners[eventName](eventListener);
	}
};

coreEventsModule.triggerEvent = (eventName, ...args) => {
	if (!coreEventsModule.eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}

	// Convert set of event listeners to array, so we can sort them.
	const arrEventListeners = Array.from(eventListeners[eventName]);

	// Sort all events by priority (IMMEDIATE, HIGH, MEDIUM, ... ).
	arrEventListeners.sort((e, f) => e.priority - f.priority);

	// Execute events (in proper order).
	arrEventListeners.forEach(eventListener => {
		try {
			// IMMEDIATE listeners get triggered right now, everything else happens on the next tick.
			if (eventListener.priority === coreEventsModule.PRIORITY.IMMEDIATE) {
				eventListener(...args);
			} else {
				// It is somewhat counter-intuitive that non-IMMEDIATE listeners gets triggered by
				// setImmediate. setImmediate means "immediately after we're done with everything else".
				setImmediate(eventListener, ...args);
			}
		}
		catch (e) {
			console.error(e);
		}
	});
};

module.exports = coreEventsModule;