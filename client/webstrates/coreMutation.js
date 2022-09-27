'use strict';
var coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');

const coreMutation = {};

coreEvents.createEvent('mutation');

const observerOptions = {
	childList: true,
	subtree: true,
	attributes: true,
	characterData: true,
	attributeOldValue: true,
	characterDataOldValue: true
};

let rootElement;
const primaryObserver = new MutationObserver(mutationsHandler);
const fragmentObservers = {};
const fragmentParentMap = {};

coreMutation.emitMutationsFrom = (_rootElement) => {
	rootElement = _rootElement;
	// Add MutationObserver on root.
	primaryObserver.observe(rootElement, observerOptions);
	// Add MutationObservers on to all documentFragments (the things that live inside <template>s).
	coreUtils.recursiveForEach(rootElement, (node) => {
		if (node.content && node.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			setupFragmentObserver(node.content, node);
		}
	});
	isPaused = false;
};

function mutationsHandler(mutations) {
	mutations.forEach(function forEachMutation(mutation) {
		// DocumentFragments (as per the specification) can't have parents, even if they actually do.
		// Therefore, they also can't exist in the PathTree. Instead, we pretend that they *are*
		// their parents. Since this is only used with <template>s, whose only children are a single
		// documentFragment, this makes sense. The JsonML also does not store the documentFragment,
		// but it is automatically created when creating a <template> tag.
		if (mutation.target.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			// We use defineProperty rather than a primitive assignemtn, because the target property is
			// read-only.
			Object.defineProperty(mutation, 'target', {
				value: fragmentParentMap[mutation.target.id]
			});
		}

		coreEvents.triggerEvent('mutation', mutation);
	});
}

/**
 * Set ups a Mutation Observer on a Document Fragment.
 * @param {DocumentFragment} fragment Fragment to observe.
 * @param {DOMElement} element        Element containing fragment.
 * @private
 */
function setupFragmentObserver(fragment, element) {
	if (fragment.id) {
		return;
	}
	fragment.id = coreUtils.randomString();
	const fragmentObserver = new MutationObserver(mutationsHandler);
	fragmentObserver.observe(fragment, observerOptions);
	fragmentObservers[fragment.id] = [fragment, fragmentObserver];
	fragmentParentMap[fragment.id] = element;
}

/**
 * Removes a Mutation Observer from a Document Fragment.
 * @param {DocumentFragment} fragment Fragment to remove observer from.
 * @private
 */
function teardownFragmentObserver(fragment) {
	if (!fragment.id || !fragmentParentMap[fragment.id]) {
		return;
	}
	let fragmentObserver;
	[fragment, fragmentObserver] = fragmentObservers[fragment.id];
	fragmentObserver.disconnect();
	delete fragmentObservers[fragment.id];
	delete fragmentParentMap[fragment.id];
}

// The global mutation observer does not observe on changes to documentFragments (the things that
// live inside <template>s within the document, so we have to manually create and manage individual
// observers for each documentFragment.
// Before we can do that, we have to create DOMNodeInserted and DOMNodeDeletedoutselves ourselves,
// because this module gets loaded before they get created (by coreOpApplier or coreOpCreator).
// The 'idempotent' option allows these events to be created even if they already. Just to be safe.
coreEvents.createEvent('DOMNodeInserted', { idempotent: true });
coreEvents.createEvent('DOMNodeDeleted', { idempotent: true });

// Whenever the DOM gets modified, we add/remove potential MutationObservers from documentFragments
// (i.e. the things living inside <template>s).
coreEvents.addEventListener('DOMNodeInserted', addedNode => {
	coreUtils.recursiveForEach(addedNode, (node) => {
		if (node.content && node.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			setupFragmentObserver(node.content, node);
		}
	});
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('DOMNodeDeleted', removedNode => {
	coreUtils.recursiveForEach(removedNode, function(node) {
		if (node.content && node.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			teardownFragmentObserver(node.content);
		}
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// To not create a live-lock, the coreOpApplier module needs to pause the mutation observer when
// adding incoming ops to the DOM. Otherwise, those incoming ops would in turn create new ops, and
// so on.
// The following allows other modules to manage the MutationObservers.
let isPaused = true;
Object.defineProperty(coreMutation, 'isPaused', {
	get: () => isPaused
});


coreMutation.pause = () => {
	if (isPaused) return;
	Object.keys(fragmentObservers).forEach(function(fragmentId) {
		var [_fragment, fragmentObserver] = fragmentObservers[fragmentId];
		fragmentObserver.disconnect();
	});
	primaryObserver.disconnect();
	isPaused = true;
};

coreMutation.resume = () => {
	if (!isPaused) return;
	Object.keys(fragmentObservers).forEach(function(fragmentId) {
		var [fragment, fragmentObserver] = fragmentObservers[fragmentId];
		fragmentObserver.observe(fragment, observerOptions);
	});
	primaryObserver.observe(rootElement, observerOptions);
	isPaused = false;
};

module.exports = coreMutation;