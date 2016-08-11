/*
Webstrates ApplyOp (webstrates.applyop.js)

This module exposes the applyOp(op, rootElement) function on the Webstrates scope. This function
applies a subset of json0 OT operations (see https://github.com/ottypes/json0) to a DOM element.
The operations handled are list insertion and deletion (li and ld), as well as string insertion and
deletion (si and sd). These operations are generated on another client using the CreateOp module.
*/
var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";

	var jsonml = {
		TAG_NAME_INDEX: 0,
		ATTRIBUTE_INDEX: 1,
		ELEMENT_LIST_OFFSET: 2
	};

	/**
	 * Extract the XML namespace from a DOM element.
	 * @param  {DOMNode} element Element.
	 * @return {string}          Namespace string.
	 */
	var getNamespace = function(element) {
		if (!element || !element.getAttribute) {
			return undefined;
		}

		var namespace = element.getAttribute("xmlns");

		return namespace ? namespace : getNamespace(element.parent);
	};

	/**
	 * Recursively navigates an element using path to set the value as an attribute.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode. Last element of path is the attribute
	 *                                key.
	 * @param {string} value          Attribute value.
	 */
	var setAttribute = function(parentElement, path, value) {
		var [head, ...tail] = path;

		if (tail.length > 0) {
			var key = head - jsonml.ELEMENT_LIST_OFFSET;
			var childElement = parentElement.childNodes[key];
			return setAttribute(childElement, tail, webstrates.util.unescape(value));
		}

		var key = head;
		parentElement.setAttribute(key, webstrates.util.unescape(value));
	};

	/**
	 * Recursively navigates an element using path to remove the attribute at the end of the path.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to fllow on DOMNode. Last element of path is the attribute
	 *                                key.
	 */
	var removeAttribute = function(parentElement, path) {
		var [head, ...tail] = path;

		if (tail.length > 0) {
			var key = head - jsonml.ELEMENT_LIST_OFFSET;
			var childElement = parentElement.childNodes[key];
			return removeAttribute(childElement, tail);
		}

		var key = head;
		parentElement.removeAttribute(key);
	};

	/**
	 * Recursively navigates an element using path to insert an element.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode.
	 * @param {mixed} value           Element to insert, either a text string or JQML element.
	 */
	var insertNode = function(parentElement, path, value) {
		var [head, ...tail] = path;
		var key = head - jsonml.ELEMENT_LIST_OFFSET;
		var childElement = parentElement.childNodes[key];

		if (tail.length > 0) {
			return insertNode(childElement, tail, value);
		}

		var namespace = getNamespace(parentElement);
		var newElement = typeof value === 'string' ?
			document.createTextNode(value) : jqml(value, namespace);

		// childElement may be undefined, and if so we insert newElement at the end of the list. If
		// chidElement is defined, however, we insert the element before childElement.
		webstrates.util.appendChildWithoutScriptExecution(parentElement, newElement, childElement);

		var parentPathNode = webstrates.PathTree.getPathNode(parentElement);
		var childPathNode = new webstrates.PathTree(newElement, parentPathNode);
		parentPathNode.children.splice(key, 0, childPathNode);

		return parentPathNode.children;
	};

	/**
	 * Recursively navigates an element using path to delete an element.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode.
	 */
	var deleteNode = function(parentElement, path) {
		var [head, ...tail] = path;
		var key = head - jsonml.ELEMENT_LIST_OFFSET;
		var childElement = webstrates.util.getChildNodes(parentElement)[key];

		if (tail.length > 0) {
			return deleteNode(childElement, tail);
		}

		// Update PathTree to reflect the deletion.
		// TODO: Use PathTree.remove() instead.
		var parentPathNode = webstrates.PathTree.getPathNode(parentElement);
		var childPathNode = webstrates.PathTree.getPathNode(childElement, parentPathNode);
		parentPathNode.children.splice(key, 1);

		// And remove the actual DOM node.
		childElement.remove();
	};

	/**
	 * Replace a node, either a tag name, list of attributes or a regular node.
	 * Note that this is added for compatibility with a wider array of json0 operations such as those
	 * used by Webstrates file system. Webstrates itself does not create these kinds of operations.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode.
	 * @param {mixed} value           Element to insert, new tag name, or new set of attributes.
	 */
	var replaceNode = function(parentElement, path, value) {
		var [head, ...tail] = path;
		var key = head - jsonml.ELEMENT_LIST_OFFSET;
		var childElement = parentElement.childNodes[key];

		// We're renaming a tag, e.g. when <span>foo</span> should become <div>foo</div>.
		if (tail[0] === jsonml.TAG_NAME_INDEX) {
			var oldElement = childElement;
			var namespace = getNamespace(oldElement);
			var newElement = jqml([value], namespace);

			var parentPathNode = webstrates.PathTree.getPathNode(parentElement);
			if (!parentPathNode) {
				console.warn("No parentPathNode found, aborting. This shouldn't happen, but...");
				return;
			}
			var oldElementPathNode = webstrates.PathTree.getPathNode(oldElement);
			var newElementPathNode = new webstrates.PathTree(newElement, parentPathNode);

			// Move all children.
			while (oldElement.firstChild) {
				webstrates.util.appendChildWithoutScriptExecution(newElement, oldElement.firstChild);
			}
			// TODO: Is .slice() necessary? Probably not.
			newElementPathNode.children = oldElementPathNode.children.slice();

			// Copy all attributes.
			for (var i = 0; i < oldElement.attributes.length; i++) {
				var attr = oldElement.attributes.item(i);
				newElement.setAttribute(attr.nodeName, attr.nodeValue);
			}

			// Overwrite old node with new node.
			parentPathNode.children.splice(key, 1, newElementPathNode);
			webstrates.util.appendChildWithoutScriptExecution(parentElement, newElement, oldElement);
			oldElement.remove();
			return;
		}

		// We're replacing an entire object of attributes by writing all the new attributes and deleting
		// old ones.
		if (tail[0] === jsonml.ATTRIBUTE_INDEX) {
			var newAttributes = value;
			var oldAttributeKeys = Array.from(childElement.attributes).map(function(attribute) {
				return attribute.name;
			});
			var attributes = new Set([...Object.keys(newAttributes), ...oldAttributeKeys]);
			attributes.forEach(function(key) {
				if (key in newAttributes) {
					childElement.setAttribute(key, newAttributes[key]);
				} else {
					childElement.removeAttribute(key);
				}
			});
			return;
		}

		// We're just replacing a regular childNode.
		if (tail.length > 0) {
			return replaceNode(childElement, tail, value);
		}

		// Path now only contains the last index. Since we've reached this, we know that
		// index >= jsonml.ELEMENT_LIST_OFFSET, so the target element is a regular DOM Node.
		deleteNode(parentElement, path);
		insertNode(parentElement, path, value)
	};

	/**
	 * Recursively navigates an element using path to insert text at an index.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode.
	 * @param {int} charIndex         Index in existing string to insert new string at.
	 * @param {string} value          String to be inserted.
	 */
	var insertInText = function(parentElement, path, charIndex, value) {
		var [head, ...tail] = path;

		// If the head is at ATTRIBUTE_INDEX (1), we're possibly changing an attribute, in which case
		// the following element should be the attribute name. However, it may not always be an
		// attribute, becuase the the attribute object is optional in JsonML and may not exist.
		// Therefore, what should be at the ATTRIBUTE_INDEX may just be another object.
		if (head === jsonml.ATTRIBUTE_INDEX && typeof tail[0] === "string") {
			var key = tail[0];
			var oldString = parentElement.getAttribute(key);
			var newString = oldString.substring(0, charIndex) + value + oldString.substring(charIndex);
			parentElement.setAttribute(key, newString);
		}
		// Otherwise, we're just changing a text node.
		else {
			var key = head - jsonml.ELEMENT_LIST_OFFSET;
			var childElement = parentElement.childNodes[key];
			if (tail.length > 0) {
				return insertInText(childElement, tail, charIndex, value);
			}

			var isComment = parentElement.nodeType === document.COMMENT_NODE;
			var parentElement = isComment ? parentElement : childElement;
			var oldString = parentElement.data;
			var newString = oldString.substring(0, charIndex) + value + oldString.substring(charIndex);
			parentElement.data = newString;
		}

		// If the change is to an attribute, include the attribute name, otherwise undefined.
		var attributeName = typeof key === "string" ? key : undefined;

		// Create and dispatch deprecated events. This should be removed, eventually.
		var event = new CustomEvent("insertText", {
			detail: { position: charIndex, value: value, attributeName: attributeName }
		});
		parentElement.dispatchEvent(event);

		// Send out new events.
		parentElement.webstrate.fireEvent("insertText", charIndex, value, attributeName);

		return newString;
	};

	/**
	 * Recursively navigates an element using path to delete text at an index.
	 * @param {DOMNode} parentElement DOMNode used as root element for path navigation.
	 * @param {DOMPath} path          Path to follow on DOMNode.
	 * @param {int} charIndex         Index in existing string to remove string from.
	 * @param {string} value          String to be removed.
	 */
	var deleteInText = function(parentElement, path, charIndex, value) {
		var [head, ...tail] = path;

		// If the head is at ATTRIBUTE_INDEX (1), we're changing an attribute, otherwise a text node.
		if (head === jsonml.ATTRIBUTE_INDEX) {
			var key = tail[0];
			var oldString = parentElement.getAttribute(key);
			var newString = oldString.substring(0,
				charIndex) + oldString.substring(charIndex + value.length);
			parentElement.setAttribute(key, newString);
		}
		else {
			var key = head - jsonml.ELEMENT_LIST_OFFSET;
			var childElement = parentElement.childNodes[key];
			if (tail.length > 0) {
				return deleteInText(childElement, tail, charIndex, value);
			}

			var parentElement = childElement;
			var oldString = parentElement.data;
			var newString = oldString.substring(0,
				charIndex) + oldString.substring(charIndex + value.length);
			parentElement.data = newString;
		}

		// If the change is to an attribute, include the attribute name, otherwise undefined.
		var attributeName = typeof key === "string" ? key : undefined;

		// Create and dispatch deprecated events. This should be removed, eventually.
		var event = new CustomEvent("deleteText", {
			detail: { position: charIndex, value: value, attributeName: attributeName }
		});
		parentElement.dispatchEvent(event);

		// Send out new events.
		parentElement.webstrate.fireEvent("deleteText", charIndex, value, attributeName);

		return newString;
	};

	/**
	 * Apply an operation to an element.
	 * @param  {Op} op   Operation to be applied. Contains path and op type.
	 * @param  {DOMNode} DOMNode used as root element for path navigation.
	 */
	var applyOp = function(op, rootElement) {
		var path = op.p;
		if (path.length === 0) {
			return;
		}

		// We have to use "prop in obj" syntax, because not all properties have a value, necessarily
		// (i.e. `oi`).
		if ("si" in op || "sd" in op) {
			// For string insertions and string deletions, we extract the character index from the path.
			var charIndex = path.pop();
		}

		if ("oi" in op || "od" in op) {
			// For object insertion and deletions, the second-to-last element in the path is the
			// attribute's index in the attribute list, but attributes don't have indices, so we just
			// delete it. This is a remnant of JsonML.
			path.splice(path.length - 2, 1);
		}

		// Attribute insertion (object insertion). Also catches replace operations, i.e. operations with
		// both `oi` and `od`.
		if ("oi" in op) {
			return setAttribute(rootElement, path, op.oi);
		}

		// Attribute removal (object deletion)
		if ("od" in op) {
			return removeAttribute(rootElement, path);
		}

		// String deletion.
		if ("sd" in op) {
			return deleteInText(rootElement, path, charIndex, op.sd);
		}

		// String insertion.
		if ("si" in op) {
			return insertInText(rootElement, path, charIndex, op.si);
		}

		// Node replacement, either a regular node, tag renaming, or a complete replacement of
		// attributes.
		if ("li" in op && "ld" in op) {
			return replaceNode(rootElement, path, op.li);
		}

		// Element deletion operation (list deletion).
		if ("ld" in op) {
			return deleteNode(rootElement, path);
		}

		// Element insertion operation (list insertion).
		if ("li" in op) {
			return insertNode(rootElement, path, op.li);
		}
	};

	webstrates.applyOp = applyOp;

	return webstrates;

})(root.webstrates || {});