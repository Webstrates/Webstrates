'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const globalObject = require('./globalObject');
const nodeObjects = require('./nodeObjects');

// If webstrate is transcluded in an iframe, we should probably raise an event on the frame element
// in the parent document, so the parent document can trigger the transcluded event.
if (coreUtils.isTranscluded()) {
	// If the domain of the iframe we're in is different from the parent's domain, we shouldn't raise
	// we won't be allowed to access frameElement due to cross-domain restrictions on iframes.
	if (coreUtils.sameParentDomain()) {
		coreEvents.addEventListener('loadedTriggered', () => {
			window.frameElement.dispatchEvent(new CustomEvent('transcluded', {
				detail: [
					globalObject.publicObject.webstrateId,
					globalObject.publicObject.clientId,
					globalObject.publicObject.user
				],
				bubbles: true,
				cancelable: true
			}));
		}, coreEvents.PRIORITY.LAST);
	}
}

/**
 * Add 'transcluded' event to iframe. Do nothing if called with an element that is not an iframe.
 * @param {DOMNode} node       DOMNode.
 * @param {Object} eventObject Event object associated with the given DOM Node. This is the object
 *                             we should add the 'transcluded' event to if the node is an iframe.
 * @private
 */
function addTransclusionEvent(node, eventObject) {
	if (node instanceof HTMLIFrameElement) {
		let transcludedTriggered = false;
		let eventDetails;
		eventObject.createEvent('transcluded', {
			addListener: callback => {
				if (transcludedTriggered) {
					setImmediate(callback, ...eventDetails);
				}
			}
		});
		document.addEventListener('transcluded', (event) => {
			if (event.target === node) {
				transcludedTriggered = true;
				eventDetails = event.detail;
				eventObject.triggerEvent('transcluded', ...eventDetails);
			}
		});
	}
}

// Wait for all webstrate objects to be defined, then create a transcluded event on all iframe
// elements and trigger the event once it has loaded (i.e. been populated).
coreEvents.addEventListener('webstrateObjectsAdded', (nodeTree) => {
	coreUtils.recursiveForEach(nodeTree, (node) => {
		const eventObject = nodeObjects.getEventObject(node);
		addTransclusionEvent(node, eventObject);
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// Also listen for future webstrate objects that gets added.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	addTransclusionEvent(node, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);
