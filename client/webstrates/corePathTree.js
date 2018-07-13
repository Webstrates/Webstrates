'use strict';
const coreUtils = require('./coreUtils');
/*
Webstrates PathTree (webstrates.pathree.js)

PathTree is a tree data structure mapping to the DOM, but with some extended attributes. Each node
in a PathTree consists of a unique id, a list of children, a parent, and the node's mapped DOM
element.

The primary purposes of the PathTree are to:
  1) Maintain a copy of the DOM tree's structure pre-mutation, so operations on the pre-mutation DOM
     tree can be rewritten to work on the post-mutation DOM tree.
  2) Facilitate lightweight creation of JsonML which is used when creating operations that are to be
     sent to the Webstrates server.
  3) Allow for verifying the integrity of the document by comparing every DOM node to its respective
     PathTree node.
*/

/**
 * Generate a unique identifier (UUID4).
 * @return {UUID}
 */
function generateUUID() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		var r = Math.random() * 16 | 0;
		var v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Create a PathTree from a DOM element. If a parentPathTree is provided, the created
 * PathTree will be a subtree of the parent.
 * @param {DOMNode} DOMNode	DOMNode to create PathTree from.
 * @param {PathTree} parentPathTree	PathTree to add as parent.
 * @param {bool} overwrite	Whether existing PathTree on the DOMNode should be overwritten by the
 * new PathTree or just appended to it.
 * @return {PathTree} Created PathTree.
 */
function PathTree(DOMNode, parentPathTree, overwrite) {
	this.id = generateUUID();
	this.children = [];
	this.parent = parentPathTree;
	this.DOMNode = DOMNode;

	// When moving an element around, a node may exist in two places at once for a brief moment.
	// __pathNodes therefore has to be a list.
	if (overwrite || !DOMNode.__pathNodes || DOMNode.__pathNodes.length === 0) {
		DOMNode.__pathNodes = [this];
	} else {
		DOMNode.__pathNodes.push(this);
	}

	var childNodes = DOMNode.hasChildNodes() ? DOMNode.childNodes :
		(DOMNode.content && DOMNode.content.childNodes) || [];
	Array.from(childNodes).forEach(function(childNode) {
		var childPathNode = PathTree.create(childNode, this, overwrite);
		if (childPathNode) {
			this.children.push(childPathNode);
		}
	}.bind(this));
}

/**
 * Check whether a DOM Node should be persisted on the server (i.e. whether it's transient or not).
 * For a DOM Node to be transient, it has to be an element (i.e. not a text node), exist outside of
 * a template tag, as well as not be in the list of transient elements (config.transientElements).
 * @param  {DOMNode} DOMNode DOM Node to check.
 * @return {boolean}         True if the DOM Node is transient.
 * @private
 */
function isTransientElement(DOMNode) {
	// Only elements can be transient
	return DOMNode.nodeType === document.ELEMENT_NODE
		// Nothing in templates can be transient
		&& !coreUtils.elementIsTemplateDescendant(DOMNode)
		// Only elements passing a function defined in config.isTransientElement are transient.
		&& config.isTransientElement && config.isTransientElement(DOMNode);
}

/**
 * Add PathNode to node if the node isn't a <transient> element.
 * @param  {[type]} DOMNode        [description]
 * @param  {[type]} parentPathTree [description]
 * @param  {[type]} overwrite      [description]
 * @return {[type]}                [description]
 */
PathTree.create = function(DOMNode, parentPathTree, overwrite) {
	// Transient elements are not supposed to be persisted, and should thus not be part of the
	// PathTree. Unless the transient element is in a <template>.
	if (isTransientElement(DOMNode) || (!parentPathTree && DOMNode !== document.documentElement)) {
		return;
	}

	return new PathTree(DOMNode, parentPathTree, overwrite);
};
/**
 * Creates a JsonML representation of the PathTree.
 * @return {JsonML} JsonML representation of PathTree.
 */
PathTree.prototype.toPath = function() {
	if (!this.parent) {
		return [];
	}

	var childIndex = this.parent.children.findIndex(function(sibling) {
		return sibling.id === this.id;
	}.bind(this));

	// In the JsonML representation, the list elements start at position 2 in the object:
	//   [tag-name, attributes, ...element-list]
	var ELEMENT_LIST_OFFSET = 2;
	return [...this.parent.toPath(), ELEMENT_LIST_OFFSET + childIndex];
};

/**
 * Remove a PathTree by removing itself from parent as well as removing all children.
 * @param {bool} shallow Does not remove itself from parent if true (deletion if shallow).
 * @return {PathTree}    The deleted PathTree, consisting only of an object with an id.
 */
PathTree.prototype.remove = function(shallow) {
	// TODO: Why can't we do this EVERY time? If we do this on the children as well, the integrity
	// check fails.
	if (!shallow) {
		// Remove ourselves from our parent.
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
	}
	this.parent = null;

	// Remove ourselves from our DOMNode.
	this.DOMNode.__pathNodes.splice(this.DOMNode.__pathNodes.indexOf(this), 1);
	this.DOMNode = null;

	// Remove all our children.
	this.children.forEach(function(child) {
		child.remove(true);
	});
	this.children = null;
};

/**
 * Checks the integrity of the document by recursively comparing the elements of the PathTree to
 * that of the DOM node.
 * @return {Array of results}
 */
PathTree.prototype.check = function() {
	if (this.DOMNode.__pathNodes.length > 1) {
		console.log(this.DOMNode, this.DOMNode.__pathNodes);
		window.alert('Webstrates has encountered an error. Please reload the page.');
		throw 'Node has multiple paths';
	}

	var domNodePathNode = this.DOMNode.__pathNodes[0];
	if (domNodePathNode.id !== this.id) {
		console.log(this.DOMNode, this);
		window.alert('Webstrates has encountered an error. Please reload the page.');
		throw 'No id match';
	}

	var definedChildNodesInDom = (function() {
		var ref, ref1;
		ref = this.DOMNode.hasChildNodes() ? this.DOMNode.childNodes
			: (this.DOMNode.content && this.DOMNode.content.childNodes) || [];
		var results = [];
		for (var j = 0, len = ref.length; j < len; j++) {
			var childNode = ref[j];
			if (((ref1 = childNode.__pathNodes) != null ? ref1.length : void 0) > 0) {
				results.push(childNode);
			}
		}
		return results;
	}.bind(this))();

	if (definedChildNodesInDom.length !== this.children.length) {
		console.log(definedChildNodesInDom, this.children, this);
		window.alert('Webstrates has encountered an error. Please reload the page.');
		throw 'Different amount of children';
	}

	var childNodes = this.DOMNode.hasChildNodes() ? this.DOMNode.childNodes
		: (this.DOMNode.content && this.DOMNode.content.childNodes) || [];
	childNodes = Array.from(childNodes).filter(function(childNode) {
		return !childNode.tagName || childNode.tagName.toLowerCase() !== 'transient'
			|| coreUtils.elementIsTemplateDescendant(childNode);
	});
	if (definedChildNodesInDom.length !== childNodes.length) {
		console.log(definedChildNodesInDom, childNodes);
		console.warn('Warning: Found zombie nodes in DOM.');
	}

	var results = [];
	for (var i = 0, j = 0, len = definedChildNodesInDom.length; j < len; i = ++j) {
		results.push(this.children[i].check());
	}

	return results;
};

/**
 * Returns the last added pathNode of an element. If a parent DOM element is provided, we search
 * for the pathNode that matches on parent.
 * @param  {DOMNode} elem       Element to get pathNode of.
 * @param  {DOMNode} parentElem Parent of Element (optional).
 * @return {PathTree}           PathNode found or null.
 */
PathTree.getPathNode = function(elem, parentElem) {
	if (!elem || !elem.__pathNodes) {
		return null;
	}

	if (!parentElem || !parentElem.__pathNodes) {
		return elem.__pathNodes[elem.__pathNodes.length - 1];
	}

	var matchingElement = null;
	parentElem.__pathNodes.some(function(parentPathNode) {
		return (matchingElement = elem.__pathNodes.find(function(pathNode) {
			return pathNode.parent.id === parentPathNode.id;
		}));
	});

	return matchingElement;
};

var jsonml = {
	TAG_NAME_INDEX: 0,
	ATTRIBUTE_INDEX: 1,
	ELEMENT_LIST_OFFSET: 2
};

/**
 * Returns the DOM element at the end of the path.
 * @param  {HTMLElement|PathTree} parentElement The element used to nagivate to the path from. May
 *                                              be either a DOM element or a PathTree.
 * @param  {JsonMLPath} path                    Path to follow on parentElement.
 * @return {[DOMElement, int, DOMElement, int]} The DOM element found, including its index on its
 *                                              parent, the parent DOM element, as possibly a
 *                                              JsonML index in case the path doesn't at a DOM
 *                                              element (it may end at a tag name or attribute
 *                                              object).
 */
PathTree.elementAtPath = function(parentElement, path) {
	var parentPathNode = parentElement instanceof PathTree ? parentElement
		: PathTree.getPathNode(parentElement);

	var jsonmlIndex = path[0];
	if (jsonmlIndex === jsonml.ATTRIBUTE_INDEX) {
		// An attribute's parent could arguably be the element it's defined on, so the childElement
		// and parentElement are the same. Therefore, there also can't be a childIndex.
		return [parentElement, undefined, parentElement, jsonmlIndex];
	}

	var childIndex = jsonmlIndex - jsonml.ELEMENT_LIST_OFFSET;
	var childPathNode = parentPathNode && parentPathNode.children[childIndex];

	var nextJsonmlIndex = path[1];
	if (path.length === 1
		|| nextJsonmlIndex === jsonml.TAG_NAME_INDEX
		|| nextJsonmlIndex === jsonml.ATTRIBUTE_INDEX) {
		var childElement = childPathNode && childPathNode.DOMNode;
		parentElement = parentPathNode.DOMNode;
		return [childElement, childIndex, parentElement, nextJsonmlIndex];
	}
	return PathTree.elementAtPath(childPathNode, path.slice(1));
};

module.exports = PathTree;