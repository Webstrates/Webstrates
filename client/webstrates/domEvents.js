'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const nodeObjects = require('./nodeObjects');

/**
 * Create public events on all webstrate objects on DOM nodes.
 * @param  {DOMNode} node       Node containing webstrate element.
 * @param  {Object} eventObject Event object associated to the webstrate element.
 * @private
 */
function createEventsOnEventObject(node, eventObject) {
	switch (node.nodeType) {
		case document.ELEMENT_NODE:
			// Prime events ("*" suffix) gets triggered for local events, too. I.e. is a remote user
			// changes an attribute, both attributeChanged and attributeChanged* gets triggered. However,
			// if the local user changes an attribute, only atributeChanged* gets triggered.
			eventObject.createEvent('attributeChanged');
			eventObject.createEvent('attributeChanged*');
			eventObject.createEvent('nodeAdded');
			eventObject.createEvent('nodeAdded*');
			eventObject.createEvent('nodeRemoved');
			eventObject.createEvent('nodeRemoved*');
			// falls through
		case document.TEXT_NODE:
			eventObject.createEvent('insertText');
			eventObject.createEvent('insertText*');
			eventObject.createEvent('deleteText');
			eventObject.createEvent('deleteText*');
			break;
	}
}

// This gets triggered (in nodeObjects) when the page has loaded initially and nodes have had
// webstrate objects added to them.
coreEvents.addEventListener('webstrateObjectsAdded', (nodes) => {
	coreUtils.recursiveForEach(nodes, (node) => {
		const eventObject = nodeObjects.getEventObject(node);
		createEventsOnEventObject(node, eventObject);
	});

	coreEvents.addEventListener('DOMAttributeSet', (node, attributeName, oldValue, newValue,
		local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodeObjects.getEventObject(node);
		// Only trigger the main event for remote changes (i.e. changes made by other clients).
		if (!local) {
			eventObject.triggerEvent('attributeChanged', attributeName, oldValue, newValue, !!local);
		}
		// But do trigger the "prime" event for all changes, including local changes.
		eventObject.triggerEvent('attributeChanged*', attributeName, oldValue, newValue, !!local);
	});

	coreEvents.addEventListener('DOMAttributeRemoved', (node, attributeName, oldValue, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodeObjects.getEventObject(node);
		if (!local) {
			eventObject.triggerEvent('attributeChanged', attributeName, oldValue, undefined, !!local);
		}
		eventObject.triggerEvent('attributeChanged*', attributeName, oldValue, undefined, !!local);
	});

	coreEvents.addEventListener('DOMNodeInserted', (node, parentElement, local) => {
		// Finding the event object of the parent instead of the node itself, as firing the event
		// on the node itself isn't very useful.
		const eventObject = nodeObjects.getEventObject(parentElement);

		// They parent may have been deleted, in which case there's no event object.
		if (!eventObject) return;

		if (!local) {
			eventObject.triggerEvent('nodeAdded', node, !!local);
		}
		eventObject.triggerEvent('nodeAdded*', node, !!local);
	});

	coreEvents.addEventListener('DOMNodeDeleted', (node, parentElement, local) => {
		// Finding the event object of the parent instead of the node itself, as firing the event
		// on the node itself isn't very useful.
		const eventObject = nodeObjects.getEventObject(parentElement);

		// They parent may have been deleted, in which case there's no event object.
		if (!eventObject) return;

		if (!local) {
			eventObject.triggerEvent('nodeRemoved', node, !!local);
		}
		eventObject.triggerEvent('nodeRemoved*', node, !!local);
	});

	coreEvents.addEventListener('DOMAttributeTextInsertion', (node, attributeName, position,
		value, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodeObjects.getEventObject(node);
		if (!local) {
			eventObject.triggerEvent('insertText', position, value, attributeName, !!local);
		}
		eventObject.triggerEvent('insertText*', position, value, attributeName, !!local);
	});

	coreEvents.addEventListener('DOMTextNodeInsertion', (node, parentElement, position, value,
		local) => {
		let eventObject = nodeObjects.getEventObject(node);
		if (!local) {
			eventObject.triggerEvent('insertText', position, value, !!local);
		}
		eventObject.triggerEvent('insertText*', position, value, !!local);
		// Also trigger on parent.
		if (parentElement.nodeType === document.ELEMENT_NODE) {
			eventObject = nodeObjects.getEventObject(parentElement);
			if (!local) {
				eventObject.triggerEvent('insertText', position, value, !!local);
			}
			eventObject.triggerEvent('insertText*', position, value, !!local);
		}
	});

	coreEvents.addEventListener('DOMAttributeTextDeletion', (node, attributeName, position,
		value, local) => {
		// Finding the event object (i.e. the webstrate.on() related events) for the node and firing
		// the attributeChanged event in userland.
		const eventObject = nodeObjects.getEventObject(node);
		if (!local) {
			eventObject.triggerEvent('deleteText', position, value, attributeName, !!local);
		}
		eventObject.triggerEvent('deleteText*', position, value, attributeName, !!local);
	});

	coreEvents.addEventListener('DOMTextNodeDeletion', (node, parentElement, position, value,
		local) => {
		let eventObject = nodeObjects.getEventObject(node);
		if (eventObject) {
			if (!local) {
				eventObject.triggerEvent('deleteText', position, value, !!local);
			}
			eventObject.triggerEvent('deleteText*', position, value, !!local);
		}
		// Also trigger on parent.
		if (parentElement.nodeType === document.ELEMENT_NODE) {
			eventObject = nodeObjects.getEventObject(parentElement);
			if (!local) {
				eventObject.triggerEvent('deleteText', position, value, !!local);
			}
			eventObject.triggerEvent('deleteText*', position, value, !!local);
		}
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// This gets triggered when an node gets added after the initial page load.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	createEventsOnEventObject(node, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);