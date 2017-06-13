'use strict';
const coreEvents = require('./coreEvents');

/**
 * Create public events on all webstrate objects on DOM nodes.
 * @param  {DOMNode} node       Node containing webstrate element.
 * @param  {Object} eventObject Event object associated to the webstrate element.
 * @private
 */
function createEventsOnEventObject(node, eventObject) {
	switch (node.nodeType) {
		case document.ELEMENT_NODE:
			eventObject.createEvent('attributeChanged');
			eventObject.createEvent('nodeAdded');
			eventObject.createEvent('nodeRemoved');
			// falls through
		case document.TEXT_NODE:
			eventObject.createEvent('insertText');
			eventObject.createEvent('deleteText');
			break;
	}
}

// This gets triggered when the page has loaded initially and and nodes have had webstrate
// objects added.
coreEvents.addEventListener('webstrateObjectsAdded', (nodes) => {
	nodes.forEach((eventObject, node) => createEventsOnEventObject(node, eventObject));

	coreEvents.addEventListener('DOMAttributeSet', (node, attributeName, oldValue, newValue,
		local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodes.get(node);
		eventObject.triggerEvent('attributeChanged', attributeName, oldValue, newValue, !!local);
	});

	coreEvents.addEventListener('DOMAttributeRemoved', (node, attributeName, oldValue, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodes.get(node);
		eventObject.triggerEvent('attributeChanged', attributeName, oldValue, undefined, !!local);
	});

	coreEvents.addEventListener('DOMNodeInserted', (node, parentElement, local) => {
		// Finding the event object of the parent instead of the node itself, as firing the event
		// on the node itself isn't very useful.
		const eventObject = nodes.get(parentElement);
		eventObject.triggerEvent('nodeAdded', node, !!local);
	});

	coreEvents.addEventListener('DOMNodeDeleted', (node, parentElement, local) => {
		// Finding the event object of the parent instead of the node itself, as firing the event
		// on the node itself isn't very useful.
		const eventObject = nodes.get(parentElement);
		eventObject.triggerEvent('nodeRemoved', node, !!local);
	});

	coreEvents.addEventListener('DOMAttributeTextInsertion', (node, attributeName, position,
		value, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodes.get(node);
		eventObject.triggerEvent('insertText', position, value, attributeName, !!local);
	});

	coreEvents.addEventListener('DOMTextNodeInsertion', (node, parentElement, position, value,
		local) => {
		let eventObject = nodes.get(node);
		eventObject.triggerEvent('insertText', position, value, !!local);
		// Also trigger on parent.
		if (parentElement.nodeType === document.ELEMENT_NODE) {
			eventObject = nodes.get(parentElement);
			eventObject.triggerEvent('insertText', position, value, !!local);
		}
	});

	coreEvents.addEventListener('DOMAttributeTextDeletion', (node, attributeName, position,
		value, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodes.get(node);
		eventObject.triggerEvent('deleteText', position, value, attributeName, !!local);
	});

	coreEvents.addEventListener('DOMTextNodeDeletion', (node, parentElement, position, value,
		local) => {
		let eventObject = nodes.get(node);
		eventObject.triggerEvent('deleteText', position, value, !!local);
		// Also trigger on parent.
		if (parentElement.nodeType === document.ELEMENT_NODE) {
			eventObject = nodes.get(parentElement);
			eventObject.triggerEvent('deleteText', position, value, !!local);
		}
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// This gets triggered when an node gets added after the initial page load.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	createEventsOnEventObject(node, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);