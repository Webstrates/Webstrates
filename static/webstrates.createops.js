/*
Webstrates CreateOps (webstrates.createops.js)

This file exposes the createOps(mutation, sjsDoc) function on the Webstrates scope. This function
takes a MutationRecord (created by the MutationObserver) and returns a list of json0 OT operations
(see https://github.com/ottypes/json0) that can be applied to a DOM element using the ApplyOp
module.
*/
var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";

	// Instantiate the DiffMatchPatch library used for creating ops from text mutations.
	var dmp = new diff_match_patch();

	/**
	 * Convert a number of string patches to OT operations.
	 * @param  {JsonMLPath} path Base path for patches to apply to.
	 * @param  {string} oldValue Old value.
	 * @param  {string} newValue New value.
	 * @return {Ops}             List of resulting operations.
	 */
	var patchesToOps = function(path, oldValue, newValue) {
		var DIFF_DELETE = -1, DIFF_INSERT = 1, DIFF_EQUAL = 0;
		var ops = [];

		var patches = dmp.patch_make(oldValue, newValue);

		Object.keys(patches).forEach(function(i) {
			var patch = patches[i], offset = patch.start1;
			patch.diffs.forEach(function([type, value]) {
				switch (type) {
					case DIFF_DELETE: ops.push({ sd: value, p: [...path, offset] }); break;
					case DIFF_INSERT: ops.push({ si: value, p: [...path, offset] }); // fall-through.
					case DIFF_EQUAL: offset += value.length; break;
					default: throw Error(`Unsupported operation type: ${type}`);
				}
			});
		});

		return ops;
	};

	/**
	 * Creates attribute operation (object insertion) from mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
	 *                                   mutation.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     Operation created from mutation wrapped in a list.
	 */
	var attributeMutation = function(mutation, target, targetPathNode, sjsDoc) {
		var ATTRIBUTE_INDEX = 1;
		var targetPathNodeJsonML = targetPathNode.toPath();
		var path = [...targetPathNodeJsonML, ATTRIBUTE_INDEX, mutation.attributeName];
		var oldValue = mutation.oldValue;
		var newValue = webstrates.util.escape(target.getAttribute(mutation.attributeName));

		// dmp.patch_make does not accept empty strings, so if we are creating a new attribute (or
		// setting an attribute's value for the first time), we have to create the operation manually.
		if (oldValue === null) {
			var op = { oi: newValue, p: path };
			return [op];
		}

		// If the new value is null, we are removing the attribute. dmp_patch_make is also not needed
		// here.
		if (newValue === null) {
			var op = { od: mutation.attributeName, p: path };
			return [op];
		}

		var pathTreeNode = webstrates.util.elementAtPath(sjsDoc.data,
			[...targetPathNodeJsonML, ATTRIBUTE_INDEX]);

		var ops = patchesToOps(path, pathTreeNode[mutation.attributeName], newValue);
		return ops;
	};

	/**
	 * Creates string insertion and string deletion operations from mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
	 *                                   mutation.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     Operation created from mutation wrapped in a list.
	 */
	var characterDataMutation = function(mutation, target, targetPathNode, sjsDoc) {
		var isComment = target.nodeType === document.COMMENT_NODE;
		var path = targetPathNode.toPath();
		var oldValue = mutation.oldValue;
		var newValue = target.data;

		if (!isComment && webstrates.util.elementAtPath(sjsDoc.data, path) !== oldValue) {
			// This should not happen, but it will if a text node is inserted and then altered right
			// after. If this happens, we can ignore it.
			return;
		}

		var ops = patchesToOps(path, oldValue, newValue);
		if (isComment) {
			ops[0].p.splice(ops[0].p.length - 1, 0, 1);
		}

		return ops;
	};

	/**
	 * Creates node insertion and deletion operations from mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
	 *                                   mutation.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     List of operations created from mutation.
	 */
	var childListMutation = function(mutation, target, targetPathNode, sjsDoc) {
		var ops = [];

		Array.from(mutation.addedNodes).forEach(function(addedNode) {
			var addedPathNode = webstrates.PathTree.getPathNode(addedNode, target);
			if (addedPathNode && targetPathNode.id === addedPathNode.parent.id) {
				return;
			}

			if (addedNode.nodeType === document.ELEMENT_NODE) {
				var sanitizedTagName = webstrates.util.sanitizeString(addedNode.tagName);
				// If the name is unsanitized, we remove the element and replace it with an identical
				// element with a sanitized tag name.
				if (sanitizedTagName !== addedNode.tagName) {
					var replacementNode = document.createElementNS(addedNode.tagName.namespaceURI,
						sanitizedTagName);

					// Move all children.
					while (addedNode.firstChild) {
						webstrates.util.appendChildWithoutScriptExecution(replacementNode,
							addedNode.firstChild);
					}

					// Copy all attributes and sanitize them as well.
					for (var i = 0; i < addedNode.attributes.length; i++) {
						var attr = addedNode.attributes[i];
						replacementNode.setAttribute(webstrates.util.sanitizeString(attr.nodeName),
							attr.nodeValue);
					}

					// Insert the element before addedNode.
					webstrates.util.appendChildWithoutScriptExecution(addedNode.parentElement,
						replacementNode, addedNode);
					addedNode.remove();
					addedNode = replacementNode;
				} else {
					// If we haven't replaced the element, we still have to sanitize the attributes.
					for (var i = 0; i < addedNode.attributes.length; i++) {
						var attr = addedNode.attributes[i];
						var sanitizedNodeName = webstrates.util.sanitizeString(attr.nodeName);
						if (sanitizedNodeName !== attr.nodeName) {
							addedNode.removeAttribute(attr.nodeName);
							addedNode.setAttribute(sanitizedNodeName, attr.nodeValue);
						}
					}
				}
			}

			var newPathNode = webstrates.PathTree.create(addedNode, targetPathNode);

			if (!newPathNode) {
				return;
			}

			// We use the previous sibling to insert the new element in the correct position in the path
			// tree. However, if the previous sibling is a transient element, it won't be in the path
			// tree, so it will appear that the element has no previous element. Therefore, we traverse
			// the list of previous siblings until we find one that's not a transient element (if such
			// exists).
			var previousSibling = addedNode.previousSibling;
			while (previousSibling && previousSibling.tagName
				&& previousSibling.tagName.toLowerCase() === "transient") {
				previousSibling = previousSibling.previousSibling;
			}

			if (previousSibling) {
				var previousSiblingPathNode = webstrates.PathTree.getPathNode(previousSibling,
					target);
				var previousSiblingIndex = targetPathNode.children.indexOf(previousSiblingPathNode);
				targetPathNode.children.splice(previousSiblingIndex + 1, 0, newPathNode);
				previousSibling = addedNode;
			} else if (mutation.nextSibling) {
				targetPathNode.children.unshift(newPathNode);
			} else {
				targetPathNode.children.push(newPathNode);
			}

			mutation.target.webstrate.fireEvent("nodeAdded", addedNode, true);

			var path = webstrates.PathTree.getPathNode(addedNode, target).toPath();
			var op = { li: JsonML.fromHTML(addedNode), p: path };
			ops.push(op);
		});

		Array.from(mutation.removedNodes).forEach(function(removedNode) {
			var removedPathNode = webstrates.PathTree.getPathNode(removedNode, target);
			// If an element has no path node, it hasn't been registered in the JsonML at all, so it won't
			// exist on other clients, and therefore creating an op to delete it wouldn't make sense.
			if (!removedPathNode) {
				return;
			}

			mutation.target.webstrate.fireEvent("nodeRemoved", removedNode, true);

			var path = removedPathNode.toPath();
			removedPathNode.remove();
			var element = webstrates.util.elementAtPath(sjsDoc.data, path);
			// If the element doesn't exist in the DOM, we can't create an op for its deletion, and we
			// shouldn't either, so we return. This happens when we replace an unsanitized tag with a
			// sanitized one.
			if (!element) {
				return;
			}

			var op = { ld: element, p: path };
			ops.push(op);
		});

		return ops;
	};

	/**
	 * Creates operations from a mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     List of operations created from mutation.
	 */
	var createOps = function(mutation, sjsDoc, fragmentParentMap) {
			// DocumentFragments (as per the specification) can't have parents, even if they actually do.
			// Therefore, they also can't exist in the PathTree. Instead, we pretend that they *are*
			// their parents. Since this is only used with <template>s, whose only children are a single
			// documentFragment, this makes sense. The JsonML also does not store the documentFragment,
			// but it is automatically created when creating a <template> tag.
			var target = mutation.target.nodeType === document.DOCUMENT_FRAGMENT_NODE ?
				fragmentParentMap[mutation.target.id] : mutation.target;

			var targetPathNode = webstrates.PathTree.getPathNode(target);
			// It doesn't make sense to create operation for a node that doesn't exist, so we return.
			// This may happen if another user performs an operation on an element that we have just
			// deleted.
			if (!targetPathNode) {
				return;
			}

			switch (mutation.type) {
				case "attributes":
					return attributeMutation(mutation, target, targetPathNode, sjsDoc); break;
				case "characterData":
					return characterDataMutation(mutation, target, targetPathNode, sjsDoc); break;
				case "childList":
					return childListMutation(mutation, target, targetPathNode, sjsDoc); break;
				default: throw `Unsupported mutation type: ${type}`;
			}
	};

	webstrates.createOps = createOps;

	return webstrates;

})(root.webstrates || {});
