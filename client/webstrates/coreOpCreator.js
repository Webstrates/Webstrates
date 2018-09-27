'use strict';
const coreConfig = require('./coreConfig');
const coreEvents = require('./coreEvents');
const coreDatabase = require('./coreDatabase');
const corePathTree = require('./corePathTree');
const coreUtils = require('./coreUtils');
const coreJsonML = require('./coreJsonML');
const diffMatchPatch = require('diff-match-patch');
const json0 = require('ot-json0/lib/json0');

const coreOpCreator = {};

coreEvents.createEvent('createdOps');

// The 'idempotent' option allows these events to be created even if they already
// exists. We do this, because these events also are used (and created) in coreOpApplier.
coreEvents.createEvent('DOMAttributeSet', { idempotent: true });
coreEvents.createEvent('DOMAttributeRemoved', { idempotent: true });
coreEvents.createEvent('DOMNodeInserted', { idempotent: true });
coreEvents.createEvent('DOMNodeDeleted', { idempotent: true });
coreEvents.createEvent('DOMAttributeTextInsertion', { idempotent: true });
coreEvents.createEvent('DOMTextNodeInsertion', { idempotent: true });
coreEvents.createEvent('DOMAttributeTextDeletion', { idempotent: true });
coreEvents.createEvent('DOMTextNodeDeletion', { idempotent: true });

// The attribute's index into a JsonML element array.
const ATTRIBUTE_INDEX = 1;

// Instantiate the DiffMatchPatch library used for creating ops from text mutations.
const dmp = new diffMatchPatch();

/**
 * Convert a number of string patches to OT operations.
 * @param  {JsonMLPath} path Base path for patches to apply to.
 * @param  {string} oldValue Old value.
 * @param  {string} newValue New value.
 * @return {Ops}             List of resulting operations.
 */
function patchesToOps(path, oldValue, newValue) {
	const ops = [];

	var patches = dmp.patch_make(oldValue, newValue);

	Object.keys(patches).forEach(function(i) {
		var patch = patches[i], offset = patch.start1;
		patch.diffs.forEach(function([type, value]) {
			switch (type) {
				case diffMatchPatch.DIFF_DELETE:
					ops.push({ sd: value, p: [...path, offset] });
					break;
				case diffMatchPatch.DIFF_INSERT:
					ops.push({ si: value, p: [...path, offset] });
					// falls through intentionally
				case diffMatchPatch.DIFF_EQUAL:
					offset += value.length;
					break;
				default: throw Error(`Unsupported operation type: ${type}`);
			}
		});
	});

	return ops;
}

/**
 * Creates attribute operation (object insertion) from mutation.
 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
 *                                   mutation.
 */
function attributeMutation(mutation, targetPathNode) {
	if (!targetPathNode || config.isTransientAttribute(mutation.target, mutation.attributeName)) {
		return;
	}

	// MongoDB doesn't support periods (.) in keys, so we store them as &dot; instead.
	const cleanAttributeName = coreUtils.escapeDots(mutation.attributeName);
	const targetPathNodeJsonML = targetPathNode.toPath();
	const path = [...targetPathNodeJsonML, ATTRIBUTE_INDEX, cleanAttributeName];
	const oldValue = mutation.oldValue;
	const newValue = coreUtils.escape(mutation.target.getAttribute(mutation.attributeName));
	const jsonmlAttrs = coreDatabase.elementAtPath([...targetPathNodeJsonML, ATTRIBUTE_INDEX]);

	// If the new value is null, we are removing the attribute.
	if (newValue === null) {
		coreEvents.triggerEvent('DOMAttributeRemoved', mutation.target, mutation.attributeName,
			oldValue, newValue, true);
		return [{ od: oldValue, p: path }];
	}

	if (newValue === jsonmlAttrs[cleanAttributeName]) {
		return [];
	}

	// dmp.patch_make does not accept empty strings, so if we are creating a new attribute (or
	// setting an attribute's value for the first time), we have to create the operation manually.
	// The second condition should not be true without the first one, but it will if the changes
	// happen so rapidly, that the browser skipped a MutationRecord. Or that's my theory, at least.
	// Also, if the newValue is short, it's easier and faster to just send it rather than patch it.
	// And lastly, if we're throttling ops (meaning we're not sending all of them), we can't create
	// diffs as diffs only work between two known states, but we won't know the previous state if we
	// have left out some ops. Just replacing a string with a new one doesn't require any knowledge
	// about the current state.
	let ops;
	if (oldValue === null || newValue.length < 50 || !jsonmlAttrs[cleanAttributeName]
		|| !coreConfig.attributeValueDiffing || mutation.target.hasAttribute('op-throttle')) {
		ops = [{ od: oldValue, oi: newValue, p: path }];
	} else {
		ops = patchesToOps(path, jsonmlAttrs[cleanAttributeName], newValue);
	}

	coreEvents.triggerEvent('DOMAttributeSet', mutation.target, mutation.attributeName, oldValue,
		newValue, true);
	return ops;
}

/**
 * Creates string insertion and string deletion operations from mutation.
 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
 *                                   mutation.
 */
function characterDataMutation(mutation, targetPathNode) {
	// No pathNode means transient, therefore not in the JsonML, so creating an op isn't possible and
	// also doesn't make sense.
	if (!targetPathNode) {
		return;
	}

	const isComment = mutation.target.nodeType === document.COMMENT_NODE;
	const path = targetPathNode.toPath();

	const pathElement = coreDatabase.elementAtPath(path);
	// The old value at the path must be a string for us to be able to create patches. However, if
	// nothing exists there, we'll get the parent element.
	let oldValue = (typeof pathElement === 'string' && pathElement) || '';

	const newValue = mutation.target.data.replace(/ /g, ' ');

	/*if (!isComment && coreDatabase.elementAtPath(path) !== oldValue) {
		// This should not happen, but it will if a text node is inserted and then altered right
		// after. If this happens, we can ignore it.
		return;
	}*/

	let ops;
	if (mutation.target.parentElement && mutation.target.parentElement.hasAttribute('op-compose')) {
		oldValue = mutation.target.futureContents || oldValue;
		mutation.target.futureContents = newValue;
	}

	ops = patchesToOps(path, oldValue, newValue);
	if (isComment) {
		ops[0].p.splice(ops[0].p.length - 1, 0, 1);
	}

	// In most cases, we could use mutation.target.parentElement to determine the parentElement, but
	// when deleting a node from the DOM, the target will no longer have a parentElement. Therefore,
	// we instead look at our path tree.
	const parentElement = targetPathNode.parent.DOMNode;

	ops.forEach((op) => {
		let type, value, charIndex = op.p[op.p.length - 1];
		if ('si' in op) {
			type = 'DOMTextNodeInsertion';
			value = op.si;
		} else if ('sd' in op) {
			type = 'DOMTextNodeDeletion';
			value = op.sd;
		} else if ('od' in op) {
			type = 'DOMNodeDeleted';
			value = op.od;
		} if ('oi' in op) {
			type = 'DOMNodeInserted';
			value = op.oi;
		}

		coreEvents.triggerEvent(type, mutation.target, parentElement, charIndex, value, true);
	});

	return ops;
}

/**
 * Creates node insertion and deletion operations from mutation.
 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
 *                                   mutation.
 */
function childListMutation(mutation, targetPathNode) {
	let ops = [];

	Array.from(mutation.addedNodes).forEach(function(addedNode) {
		// Sanitizes all nodes (i.e. ensures valid tag names and attributes) and set wids on all nodes.
		const parentNode = mutation.target;

		let addedPathNode = corePathTree.getPathNode(addedNode, parentNode);

		// If an element already has a pathNode, it means it's already in the DOM. This could still
		// generate an op if the element is being moved. However, if the element is already in the DOM,
		// and it has the same parent as before, then it hasn't moved, so there's no reason to generate
		// an op.
		//
		// NOTE: I think there might be a bug here: If moving a text node around, it could have a
		// pathNode, but also have the same parent, in which case the move wouldn't create an op.
		// I am, however, unable to reproduce this...
		if (addedPathNode && targetPathNode.id === addedPathNode.parent.id) {
			return;
		}

		coreUtils.recursiveForEach(addedNode, (childNode, parentNode) => {
			if (childNode.nodeType === document.ELEMENT_NODE) {
				let sanitizedTagName = coreUtils.sanitizeString(childNode.tagName);
				// If the name is unsanitized, we remove the element and replace it with an identical
				// element with a sanitized tag name.
				if (sanitizedTagName !== childNode.tagName) {
					let replacementNode = document.createElementNS(childNode.tagName.namespaceURI,
						sanitizedTagName);

					// Move all children.
					while (childNode.firstChild) {
						coreUtils.appendChildWithoutScriptExecution(replacementNode, childNode.firstChild);
					}

					// Copy all attributes and sanitize them as well.
					for (let i = 0; i < childNode.attributes.length; i++) {
						let attr = childNode.attributes[i];
						replacementNode.setAttribute(coreUtils.sanitizeString(attr.nodeName),
							attr.nodeValue);
					}

					// Insert the element before childNode.
					coreUtils.appendChildWithoutScriptExecution(childNode.parentElement,
						replacementNode, childNode);
					childNode.remove();
					childNode = replacementNode;
				} else {
					// If we haven't replaced the element, we still have to sanitize the attributes.
					for (let i = 0; i < childNode.attributes.length; i++) {
						let attr = childNode.attributes[i];
						let sanitizedNodeName = coreUtils.sanitizeString(attr.nodeName);
						if (sanitizedNodeName !== attr.nodeName) {
							childNode.removeAttribute(attr.nodeName);
							childNode.setAttribute(sanitizedNodeName, attr.nodeValue);
						}
					}
				}

				// The element may being moved, and thus already is in the DOM and has a wid. We don't want
				// to redefine this. Also, the element can't be transient, i.e. its parent has to be in
				// the JsonML (targetPathNode must exist) and the element itself can't be transient.
				if (!childNode.__wid && targetPathNode && !config.isTransientElement(childNode)) {
					const wid = coreUtils.randomString();
					coreUtils.setWidOnElement(childNode, wid);
				}
			}
		}, parentNode);

		// The above wid/sanitization, we do recursively on each node, so one might naturally wonder why
		// we don't need to do the same here: Creating a PathTree (as below) happens recursively on all
		// child nodes automatically. When it comes to inserting the newly created PathTree afterwards,
		// that shouldn't happen recursively; we just need to add the newly created PathTree one place
		// in the existing tree.

		// If we can't create path node, it can't been registered in the JsonML at all, so creating
		// an op for it doesn't make sense. This happens for instance with transient elements.
		const newPathNode = corePathTree.create(addedNode, targetPathNode);
		if (!newPathNode) {
			coreEvents.triggerEvent('DOMNodeInserted', addedNode, mutation.target, true);
			return;
		}

		// We use the previous sibling to insert the new element in the correct position in the path
		// tree. However, if the previous sibling doesn't have a webstrate object, it won't be in the
		// path tree, so it will appear that the element has no previous element. Therefore, we
		// traverse the list of previous siblings until we find one that does have a webstrate object.
		// Transient elements (outside of template tags) will righfully be absent from the pathtree,
		// and thus not have webstrate objects.
		// We have to use addedNode.previousSibling and not mutation.previousSibling, as this will
		// refer to the previousSibling when the element was inserted. If multiple elements (B, C) have
		// been inserted after element A, one after the each other, in one tick,
		// mutation.previousSibling will refer to A for both mutations, but mutation.previousSibling
		// will refer to A and B, respectively.
		let previousSibling = addedNode.previousSibling;
		let previousSiblingPathNode = corePathTree.getPathNode(previousSibling, parentNode);
		while (previousSibling && !previousSiblingPathNode) {
			previousSibling = previousSibling.previousSibling;
			previousSiblingPathNode = corePathTree.getPathNode(previousSibling, parentNode);
		}

		if (previousSibling) {
			const previousSiblingIndex = targetPathNode.children.indexOf(previousSiblingPathNode);
			targetPathNode.children.splice(previousSiblingIndex + 1, 0, newPathNode);
		} else if (addedNode.nextSibling) {
			targetPathNode.children.unshift(newPathNode);
		} else {
			targetPathNode.children.push(newPathNode);
		}
		const path = corePathTree.getPathNode(addedNode, parentNode).toPath();
		const op = { li: coreJsonML.fromHTML(addedNode), p: path };
		ops.push(op);

		coreEvents.triggerEvent('DOMNodeInserted', addedNode, mutation.target, true);
	});

	Array.from(mutation.removedNodes).forEach(function(removedNode) {
		var removedPathNode = corePathTree.getPathNode(removedNode, mutation.target);

		// If an element has no path node, it hasn't been registered in the JsonML at all, so it won't
		// exist on other clients, and therefore creating an op to delete it wouldn't make sense.
		if (!removedPathNode) {
			coreEvents.triggerEvent('DOMNodeDeleted', removedNode, mutation.target, true);
			return;
		}

		const path = removedPathNode.toPath();
		removedPathNode.remove();
		var jsonmlElement = coreDatabase.elementAtPath(path);
		// If the element doesn't exist in the JsonML, we can't create an op for its deletion, and we
		// shouldn't either, so we return. This happens when we replace an unsanitized tag with a
		// sanitized one.
		if (!jsonmlElement) {
			return;
		}

		const op = { ld: jsonmlElement, p: path };
		ops.push(op);

		coreEvents.triggerEvent('DOMNodeDeleted', removedNode, mutation.target, true);
	});

	return ops;
}

coreOpCreator.emitOpsFromMutations = () => {
	coreEvents.addEventListener('mutation', (mutation) => {
		const targetPathNode = corePathTree.getPathNode(mutation.target);

		const elementTarget = mutation.target.nodeType === document.ELEMENT_NODE
			? mutation.target
			: mutation.target.parentElement;
		const elementPathNode = corePathTree.getPathNode(elementTarget);

		let ops;
		switch (mutation.type) {
			case 'attributes':
				ops = attributeMutation(mutation, targetPathNode); break;
			case 'characterData':
				ops = characterDataMutation(mutation, targetPathNode); break;
			case 'childList':
				ops = childListMutation(mutation, targetPathNode); break;
		}

		// In rare cases, what happens doesn't amount to an operation, so we ignore it.
		if (!ops || ops.length === 0) {
			return;
		}

		// When setting the op-throttle attribute on an element with a number N as the value, all
		// changes made to that element will be throttled to only send at most 1 op every N
		// milliseconds. The newest op is always the one to be sent. This can be useful intermediate
		// values aren't essential.
		if (elementTarget && elementTarget.hasAttribute('op-throttle')) {
			const throttleDelay = Number(elementTarget.getAttribute('op-throttle'));
			if (!targetPathNode.throttleFn || targetPathNode.throttleDelay !== throttleDelay) {
				targetPathNode.throttleDelay = throttleDelay;
				targetPathNode.throttleFn = coreUtils.throttleFn(
					coreEvents.triggerEvent.bind(coreEvents), throttleDelay);
			}

			targetPathNode.throttleFn('createdOps', ops);
			return;
		}

		// If we get here, op-throttle doesn't exist, so there's no need for a (potentially) old
		// throttle function that we're no longer using.
		if (targetPathNode) {
			targetPathNode.throttleFn = null;
		}

		// When setting the op-compose attribute on an element with a number N as the value, all
		// changes made to that element will be composed to only send ops at most every N
		// milliseconds. All mutations that have occured since the last trigger will be composed into
		// (hopefully) fewer ops that will be sent as a group, speeding up the processing of them.
		// This can be useful when a lot of essential (i.e. ones we can't throw out like with
		// op-throttle) ops are created and performance is suffering.
		if (elementTarget && elementTarget.hasAttribute('op-compose')) {
			const composeDelay = Number(elementTarget.getAttribute('op-compose'));

			targetPathNode.composedOps = targetPathNode.composedOps
				? json0.compose(targetPathNode.composedOps, ops)
				: ops;

			if (!elementPathNode.composeFn || elementPathNode.composeDelay !== composeDelay) {
				elementPathNode.composeDelay = composeDelay;
				targetPathNode.composedOps = ops;
				elementPathNode.composeFn = coreUtils.throttleFn((targetPathNode) => {
					if (targetPathNode.composedOps) {
						coreEvents.triggerEvent('createdOps',
							coreUtils.objectClone(targetPathNode.composedOps));
						targetPathNode.composedOps = null;
					}
				}, composeDelay);
			}

			elementPathNode.composeFn(targetPathNode);
			return;
		}

		// If we get here, op-compose doesn't exist, so there's no need for a a (potentially) old
		// compose function that we're no longer using.
		if (elementPathNode) {
			elementPathNode.composeFn = null;
		}

		coreEvents.triggerEvent('createdOps', ops);

	}, coreEvents.PRIORITY.IMMEDIATE);
};

coreOpCreator.addWidToElement = node => {
	if (node.nodeType === document.ELEMENT_NODE && !node.__wid) {
		const pathNode = corePathTree.getPathNode(node);

		// Anything without a pathNode is transient and therefore doesn't need a wid.
		if (!pathNode) {
			return;
		}

		// When inserting something into the DOM before the 'loaded' event has triggered, we will
		// be calling this function on a node that doesn't exist in the ShareDB document, resulting in
		// the submission of an op to add a wid to an element that doesn't exist, causing an error.
		// This oughtn't happen as nobody should touch the DOM before the 'loaded' event has triggered,
		// but some libraries (and users!) don't respect that. To mitigate this, we stop if the element
		// doesn't exist.
		// An alternative fix would be to create and submit and op that would create the element, but if
		// some script adds something to the DOM on every page load, we probably don't want to keep it
		// anyway, so it might actually be better to treat it as a wonky, broken transient element (
		// as we do now).
		const path = pathNode.toPath();
		const element = coreDatabase.getDocument(path);
		if (!Array.isArray(element)) {
			console.warn('Element was inserted before \'loaded\' event was triggered. This may cause ' +
				'undefined behaviour.', node);
			return;
		}

		const wid = coreUtils.randomString();
		coreUtils.setWidOnElement(node, wid);
		const ops = [{ oi: wid, p: [...path, ATTRIBUTE_INDEX, '__wid' ]}];
		coreEvents.triggerEvent('createdOps', ops);
	}
};

coreOpCreator.ensureExistenceOfWids = targetElement => {
	coreUtils.recursiveForEach(targetElement, node => coreOpCreator.addWidToElement(node));
};

coreEvents.addEventListener('DOMNodeInserted', (node, parentElement, local) => {
	// If local is set, this node was inserted by ourself and thus already has a wid (if it needs to).
	if (!local) coreOpCreator.addWidToElement(node);
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('DOMNodeDeleted', node => {
	if (node.__wid) {
		coreUtils.removeWidFromElement(node.__wid);
	}
});

module.exports = coreOpCreator;