/*
Webstrates CreateOp (webstrates.createop.js)

This file exposes the createOp(mutation, sjsDoc) function on the Webstrates scope. This function
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
					default: throw `Unsupported operation type: ${type}`;
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
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     Operation created from mutation wrapped in a list.
	 */
	var attributeMutation = function(mutation, targetPathNode, sjsDoc) {
		var ATTRIBUTE_INDEX = 1;
		var targetPathNodeJsonML = targetPathNode.toPath();
		var path = [...targetPathNodeJsonML, ATTRIBUTE_INDEX, mutation.attributeName];
		var oldValue = mutation.oldValue;
		var newValue = mutation.target.getAttribute(mutation.attributeName);

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

		var pathTreeNode = webstrates.util.elementAtPath(sjsDoc.data, [...targetPathNodeJsonML, ATTRIBUTE_INDEX]);
		if (pathTreeNode[mutation.attributeName] !== oldValue) {
			// This should not happen, but it will if a text node is inserted and then altered right
			// after. If this happens, we can ignore it.
			return;
		}

		var ops = patchesToOps(path, oldValue, newValue);
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
	var characterDataMutation = function(mutation, targetPathNode, sjsDoc) {
		var isComment = mutation.target.nodeType === 8;
		var path = targetPathNode.toPath();
		var oldValue = mutation.oldValue;
		var newValue = mutation.target.data;

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
	}

	/**
	 * Creates node insertion and deletion operations from mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {PathNode} targetPathNode The PathNode from PathTree that is the target of the
	 *                                   mutation.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     List of operations created from mutation.
	 */
	var childListMutation = function(mutation, targetPathNode, sjsDoc) {
		var ops = [];

		var previousSibling = mutation.previousSibling;
		Array.from(mutation.addedNodes).forEach(function(addedNode) {
			var addedPathNode = webstrates.PathTree.getPathNode(addedNode, mutation.target);
			if (addedPathNode && targetPathNode.id === addedPathNode.parent.id) {
				return;
			}

			var newPathNode = new webstrates.PathTree(addedNode, targetPathNode);
			if (previousSibling) {
				var previousSiblingPathNode = webstrates.PathTree.getPathNode(previousSibling,
					mutation.target);
				var previousSiblingIndex = targetPathNode.children.indexOf(previousSiblingPathNode);
				targetPathNode.children.splice(previousSiblingIndex + 1, 0, newPathNode);
				previousSibling = addedNode;
			} else if (mutation.nextSibling) {
				targetPathNode.children.unshift(newPathNode);
			} else {
				targetPathNode.children.push(newPathNode);
			}

			var path = webstrates.PathTree.getPathNode(addedNode, mutation.target).toPath();
			var op = { li: JsonML.fromHTML(addedNode), p: path };
			ops.push(op);
		});

		Array.from(mutation.removedNodes).forEach(function(removedNode) {
			var removedPathNode = webstrates.PathTree.getPathNode(removedNode, mutation.target);
			if (removedPathNode == null) {
				return;
			}

			var path = removedPathNode.toPath()
			var op = { ld: webstrates.util.elementAtPath(sjsDoc.data, path), p: path };
			ops.push(op);
			removedPathNode.remove();
		});

		return ops;
	};

	/**
	 * Creates an operation from a mutation.
	 * @param  {MutationRecord} mutation MutationRecord created by MutationObserver.
	 * @param  {ShareDB Document} sjsDoc ShareDB Document.
	 * @return {Ops}                     List of operations created from mutation.
	 */
	var createOp = function(mutation, sjsDoc) {
			var targetPathNode = webstrates.PathTree.getPathNode(mutation.target);
			// It doesn't make sense to create operation for a node that doesn't exist, so we return. This may happen if
			// another user performs an operation on an element that we have just deleted.
			if (!targetPathNode) {
				return;
			}

			switch (mutation.type) {
				case "attributes": return attributeMutation(mutation, targetPathNode, sjsDoc); break;
				case "characterData": return characterDataMutation(mutation, targetPathNode, sjsDoc); break;
				case "childList": return childListMutation(mutation, targetPathNode, sjsDoc);	break;
				default: throw `Unsupported mutation type: ${type}`;
			}
	};

	webstrates.createOp = createOp

	return webstrates;

})(root.webstrates || {});
