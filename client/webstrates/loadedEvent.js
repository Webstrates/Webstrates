'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');

const loadedEventModule = {};

let loadedTriggered = false;

Object.defineProperty(globalObject.publicObject, 'loaded', {
	get: () => loadedTriggered
});

// List of events that has to be resolved before the loaded event gets triggered.
let delayLoadedUntilPromises = [];

/**
 * Add event to list of events that has to be resolved, before the loaded event gets triggered.
 * This allows other modules to postpone the loaded event until they're ready.
 * @param  {...string} eventNames List of event names.
 * @public
 */
loadedEventModule.delayUntil = (...args) => {
	var [eventName, ...eventNames] = args;
	if (!eventName) return;

	delayLoadedUntilPromises.push(new Promise((accept) => {
		// Low priority, because want need to ensure that this gets triggered after the webstrateId
		// has been set on the wet publicObject (which we do below at medium priority).
		coreEvents.addEventListener(eventName, accept, coreEvents.PRIORITY.LOW);
	}));

	loadedEventModule.delayUntil(...eventNames);
};

// Initially delay the loaded event until the document has been populated.
loadedEventModule.delayUntil('populated');

// Create loaded event: The event to be triggered when the webstrate has finished.
globalObject.createEvent('loaded', {
	// If anybody adds a 'loaded' event listener after it has already been triggered, we run the
	// callback immediately.
	addListener: callback => {
		if (loadedTriggered) {
			setImmediate(callback, globalObject.publicObject.webstrateId,
				globalObject.publicObject.clientId, globalObject.publicObject.user);
		}
	}
});

// Also create an internal event.
coreEvents.createEvent('loadedTriggered', {
	// Same goes for the internal 'loadedTriggered' event.
	addListener: callback => {
		if (loadedTriggered) {
			setImmediate(callback, globalObject.publicObject.webstrateId,
				globalObject.publicObject.clientId, globalObject.publicObject.user);
		}
	}
});

// Wait for all events to have been triggered, before firing the loaded event.
coreEvents.addEventListener('allModulesLoaded', () => {

	Promise.all(delayLoadedUntilPromises).then(() => {
		loadedTriggered = true;

		globalObject.triggerEvent('loaded', globalObject.publicObject.webstrateId,
			// These last two arguments depend on the existance of the clientManager and userObject
			// modules, respectively, which aren't a part of the core. It may be bad style to have them
			// here anyway, but luckily it won't break anything if these two modules aren't present.
			globalObject.publicObject.clientId, globalObject.publicObject.user);
		coreEvents.triggerEvent('loadedTriggered', globalObject.publicObject.webstrateId,
			globalObject.publicObject.clientId, globalObject.publicObject.user);
	});
});

module.exports = loadedEventModule;