'use strict';
const coreEvents = require('./coreEvents');
const coreDOM = require('./coreDOM');
const coreOpCreator = require('./coreOpCreator');
const coreUtils = require('./coreUtils');
const loadedEvent = require('./loadedEvent');

const nodeObjectsModule = {};

nodeObjectsModule.getEventObject = (node) => node && node.__eventObject;
nodeObjectsModule.setEventObject = (node, eventObject) => node.__eventObject = eventObject;

coreEvents.createEvent('webstrateObjectsAdded');
coreEvents.createEvent('webstrateObjectAdded');

// Delay the loaded event, until the 'clientsReceived' event has been triggered.
loadedEvent.delayUntil('webstrateObjectsAdded');

/**
 * Attach webstrate object to node if it doesn't exist.
 * @param  {DOMNode} node        DOM Node to add webstrate object to.
 * @param  {bool} triggerEvent   Whether to trigger the webstrateObjectAdded event.
 * @private
 */
function attachWebstrateObjectToNode(node, triggerEvent) {
	const eventObjectExists = nodeObjectsModule.getEventObject(node);

	// If an event object doesn't exist, we recreate the webstrate object itself to avoid confusion.
	// This can happen if an element has been removed from the DOM, then re-added. In this case, all
	// event listeners will have been removed, so it might cause confusion when the same webstrate
	// object persists when all event listeners are gone.
	// By doing this, we also prevent other modules from trying to redefine read-only properties on
	// a webstrate object that has been "recycled".
	if (!eventObjectExists) {
		node.webstrate = {};
	}

	// If this webstrate object is being added before the element has been node to the DOM (or if the
	// node is transient), it won't have a __wid, so we won't create an id property.
	// attachWebstrateObjectToNode may be run multiple times for the same node (e.g. if a node is
	// being moved around in the DOM), in which case we're not allowed to redefine the id property.
	if (node.__wid && !node.webstrate.id) {
		// We don't use `writeable: false` and value here, because in rare cases, node.__wid may change,
		// so we need to always serve the current node.__wid, not the node.__wid value that existed when
		// this was added. The wid may get redefined if a client (e.g. file system) creates a node
		// without a wid, causing a race condition on setting the wid on the other clients. This is
		// handled by sharedb, so we won't have different wids for the same node for more than a few
		// milliseconds under normal network conditions. That's the cost of eventual consistency.
		Object.defineProperty(node.webstrate, 'id', {
			get: () => node.__wid,
			set: () => { throw new TypeError('Cannot redefine property: id'); },
			enumerable: true
		});
	}

	// Only continue if the event object doesn't exist. We can't just check for the existence of
	// the webstrate object here, because an element that has been deleted and then reinserted
	// may still have a webstrate object, but won't have an event object, as the event object gets
	// deleted whenever an element gets removed from the DOM.
	if (eventObjectExists) {
		return;
	}

	// Map from event names to a set of the actual listeners: string -> set of listeners.
	const eventListeners = {};
	// Map from event names to actual listeners: string -> function.
	const addEventListenerListeners = {};
	// Map from event names to actual listeners: string -> function.
	const removeEventListenerListeners = {};

	function eventExists(eventName) {
		return eventListeners.hasOwnProperty(eventName);
	}

	node.webstrate.on = (eventName, eventListener) => {
		if (!eventExists(eventName)) {
			throw new Error(`Event ${eventName} doesn't exist on ${node}.`);
		}
		eventListeners[eventName].add(eventListener);
		if (addEventListenerListeners[eventName]) {
			addEventListenerListeners[eventName](eventListener);
		}
	};
	node.webstrate.off = (eventName, eventListener) => {
		if (!eventExists(eventName)) {
			throw new Error(`Event ${eventName} doesn't exist.`);
		}
		eventListeners[eventName].delete(eventListener);
		if (removeEventListenerListeners[eventName]) {
			removeEventListenerListeners[eventName](eventListener);
		}
	};

	const eventObject = {
		createEvent: (eventName, options = {}) => {
			if (eventExists(eventName) && !options.idempotent) {
				console.error(`Event ${eventName} already exists on ${node}.`);
				throw new Error(`Event ${eventName} already exists on ${node}.`);
			}

			if (typeof options.addListener !== 'undefined') {
				if (typeof options.addListener !== 'function') {
					console.error(`addListener must be a function, received: ${options.addListener}`);
					throw new Error(`addListener must be a function, received: ${options.addListener}`);
				}
				addEventListenerListeners[eventName] = options.addListener;
			}

			if (typeof options.removeListener !== 'undefined') {
				if (typeof options.removeListener !== 'function') {
					console.error(`removeListener must be a function, received: ${options.removeListener}`);
					throw new Error(`removeListener must be a function, received: ${options.removeListener}`);
				}
				removeEventListenerListeners[eventName] = options.removeListener;
			}

			if (!eventExists(eventName)) {
				eventListeners[eventName] = new Set();
			}
		},
		triggerEvent: (eventName, ...args) => {
			if (!eventExists(eventName)) {
				console.error(`Event ${eventName} doesn't exist on ${node}.`);
				throw new Error(`Event ${eventName} doesn't exist on ${node}.`);
			}
			eventListeners[eventName].forEach(eventListener => {
				setImmediate(eventListener, ...args);
			});
		}
	};

	nodeObjectsModule.setEventObject(node, eventObject);

	if (triggerEvent) {
		coreEvents.triggerEvent('webstrateObjectAdded', node, eventObject);
	}
}

coreEvents.addEventListener('populated', targetElement => {
	coreUtils.recursiveForEach(targetElement, childNode => {
		// We ensure that all elements in the ShareDB document have wids. If an element has been added
		// with e.g. Webstrates file system, it will be in the document, but not have a wid yet.
		coreOpCreator.addWidToElement(childNode);
		// The second argument is whether to trigger the webstrateObjectAdded event. We do not want to
		// trigger these when we add the webstrate object initially as it may cause confusion when an
		// webstrateObjectsAdded event is triggered with the node in the nodes array, while a
		// webstrateObjectAdded event also is triggered for the same node.
		attachWebstrateObjectToNode(childNode, false);
	}, coreEvents.PRIORITY.IMMEDIATE);

	// All nodes get a webstrate object attached after they enter the DOM. It may, however, be
	// useful to access the Webstrate object before the element has been added to the DOM.
	// Therefore, we add Webstrate objects to all nodes created with document.createElement and
	// document.createElementNS immediately here.
	// We don't do this until after the document has been populated, because we just above attach
	// webstrate objects on the entire DOM.
	coreDOM.overrideDocument('createElementNS', coreDOM.CONTEXT.BOTH, (createElementNS, namespaceURI,
		qualifiedName, options = {}, ...unused) => {
		const element = createElementNS(namespaceURI, qualifiedName, options, ...unused);
		attachWebstrateObjectToNode(element, true); // true to trigger webstrateObjectAdded event.
		return element;
	});

	coreDOM.overrideDocument('createElement', coreDOM.CONTEXT.BOTH, (createElement, tagName,
		options = {}, ...unused) => {
		const element = createElement(tagName, options, ...unused);
		attachWebstrateObjectToNode(element, true);
		return element;
	});

	coreDOM.overrideDocument('importNode', coreDOM.CONTEXT.BOTH, (importNode, externalNode, deep,
		...unused) => {
		const element = importNode(externalNode, deep, ...unused);
		coreUtils.recursiveForEach(element, childNode => {
			attachWebstrateObjectToNode(childNode, true);
		});
		return element;
	});

	const cloneNode = Element.prototype.cloneNode;
	Element.prototype.cloneNode = function(deep, ...unused) {
		const element = cloneNode.call(this, deep, ...unused);
		coreUtils.recursiveForEach(element, childNode => {
			attachWebstrateObjectToNode(childNode, true);
		});
		return element;
	};

	coreEvents.triggerEvent('webstrateObjectsAdded', targetElement);
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('DOMNodeInserted', node => {
	coreUtils.recursiveForEach(node, childNode => {
		// The second argument is whether to trigger the webstrateObjectAdded event. We do want that.
		attachWebstrateObjectToNode(childNode, true);
	});
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('DOMTextNodeInsertion', node => {
	// The second argument is whether to trigger the webstrateObjectAdded event. We do want that.
	attachWebstrateObjectToNode(node, true);
}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = nodeObjectsModule;