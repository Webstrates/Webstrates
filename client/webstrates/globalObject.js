'use strict';
const coreConfig = require('./coreConfig');
const coreDatabase = require('./coreDatabase');
const corePopulator = require('./corePopulator');
const coreUtils = require('./coreUtils');

const globalObjectModule = {};

// Public webstrate object
const publicObject = {};

// Expose our internal, proxied window and document objects.
Object.defineProperty(publicObject, 'window', {
	get: () => window,
	set: () => { throw new Error('Internal window object should not be modified'); },
	// If enumerable is 'true', Puppeteer tests fail as `window.webstrate` is suddenly undefined
	// due to the circular reference.
	enumerable: false
});

Object.defineProperty(publicObject, 'document', {
	get: () => document,
	set: () => { throw new Error('Internal document object should not be modified'); },
	enumerable: true
});

Object.defineProperty(publicObject, 'webstrateId', {
	get: () => coreUtils.getLocationObject().webstrateId,
	set: () => { throw new Error('webstrate ID should not be modified'); },
	enumerable: true
});

// Every webstrate object needs a unique ID. Let's just go with 'document' for the global object.
Object.defineProperty(publicObject, 'id', {
	get: () => 'document',
	set: () => { throw new Error('node ID should not be modified'); },
	enumerable: true
});

Object.defineProperty(publicObject, 'isStatic', {
	get: () => coreUtils.getLocationObject().staticMode,
	set: () => { throw new Error('isStatic cannot be modified.'); },
	enumerable: true
});

Object.defineProperty(publicObject, 'config', { value: coreConfig });

globalObjectModule.publicObject = publicObject;

// Map from event names to a set of the actual listeners: string -> set of listeners.
const eventListeners = {};
// Map from event names to actual listeners: string -> function.
const addEventListenerListeners = {};
// Map from event names to actual listeners: string -> function.
const removeEventListenerListeners = {};

function eventExists(eventName) {
	return eventListeners.hasOwnProperty(eventName);
}

globalObjectModule.createEvent = (eventName, options = {}) => {
	if (eventExists(eventName) && !options.idempotent) {
		throw new Error(`Event ${eventName} already exists.`);
	}

	if (typeof options.addListener !== 'undefined') {
		if (typeof options.addListener !== 'function') {
			throw new Error(`addListener must be a function, received: ${options.addListener}`);
		}
		addEventListenerListeners[eventName] = options.addListener;
	}

	if (typeof options.removeListener !== 'undefined') {
		if (typeof options.removeListener !== 'function') {
			throw new Error(`removeListener must be a function, received: ${options.removeListener}`);
		}
		removeEventListenerListeners[eventName] = options.removeListener;
	}

	if (!eventExists(eventName)) {
		eventListeners[eventName] = new Set();
	}
};

globalObjectModule.triggerEvent = (eventName, ...args) => {
	if (!eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}
	eventListeners[eventName].forEach(eventListener => {
		setImmediate(eventListener, ...args);
	});
};

publicObject.on = (eventName, eventListener) => {
	if (!eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}
	eventListeners[eventName].add(eventListener);
	if (addEventListenerListeners[eventName]) {
		addEventListenerListeners[eventName](eventListener);
	}
};

publicObject.off = (eventName, eventListener) => {
	if (!eventExists(eventName)) {
		throw new Error(`Event ${eventName} doesn't exist.`);
	}
	eventListeners[eventName].delete(eventListener);
	if (removeEventListenerListeners[eventName]) {
		removeEventListenerListeners[eventName](eventListener);
	}
};

/**
 * Restore document to a previous version, either by version number or tag label.
 * Labels cannot begin with a digit whereas versions consist only of digits, so distinguishing
 * is easy.
 * @param  {string} tagOrVersion Tag label or version number.
 */
publicObject.restore = (tagOrVersion, callback) => {
	if (publicObject.isStatic) {
		coreDatabase.fetch(publicObject.webstrateId, tagOrVersion).then(doc => {
			corePopulator.populate(document, doc);
			callback();
		});
	} else {
		coreDatabase.restore(publicObject.webstrateId, tagOrVersion, callback);
	}
};

/**
 * Get a range of ops from the document.
 * @param  {Number}   fromVersion Version to start the op range from (inclusive).
 * @param  {Number}   toVersion   Version to end the op range at (exclusive).
 * @param  {Function} callback    Callback.
 * @return {Array}                (async) Array of ops in the range.
 */
publicObject.getOps = (fromVersion, toVersion, callback) => {
	coreDatabase.getOps(publicObject.webstrateId, fromVersion, toVersion, callback);
};

window.webstrate = publicObject;
module.exports = globalObjectModule;