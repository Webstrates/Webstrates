'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');

const coreMutation = {};

//coreEvents.createEvent('premutation');
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
				value: () => fragmentParentMap[mutation.target.id]
			});
		}

		// The global mutation observer does not observe on changes to documentFragments within the
		// document, so we have to manually create and manage individual observers for each
		// documentFragment manually.
		if (mutation.type === 'childList') {
			Array.from(mutation.addedNodes).forEach(function(addedNode) {
				coreUtils.recursiveForEach(addedNode, (node) => {
					if (node.content && node.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
						setupFragmentObserver(node.content, node);
					}
				});
			});
			Array.from(mutation.removedNodes).forEach(function(removedNode) {
				coreUtils.recursiveForEach(removedNode, function(node) {
					if (node.content && node.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
						teardownFragmentObserver(node.content);
					}
				});
			});
		}

		coreEvents.triggerEvent('mutation', mutation);
	});
}

let isPaused = true;
Object.defineProperty(coreMutation, 'isPaused', {
	get: function() { return isPaused; }
});


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
	fragment.id = coreUtils.util.randomString();
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

coreMutation.emitMutationsFrom = (_rootElement) => {
	rootElement = _rootElement;
	primaryObserver.observe(rootElement, observerOptions);
	isPaused = false;
};

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