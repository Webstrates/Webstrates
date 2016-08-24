/*
Webstrates Util (webstrates.util.js)

This file exposes the util object on the Webstrates scope. This object contains functions with common functionality
used by the other Webstrates modules.
*/
var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";

	var util = {};

	/**
	 * Get the element at a given path in a JsonML document.
	 * @param  {JsonML} snapshot ShareJS Context (a JsonML document).
	 * @param  {JsonMLPath} path    Path to follow in snapshot.
	 * @return {JsonML}          Element at path in snapshot.
	 * @public
	 */
	util.elementAtPath = function(snapshot, path) {
		if (path.length > 0 && typeof path[path.length-1] === "string") {
			return null;
		}

		var [head, ...tail] = path;
		if (!head) {
			return snapshot;
		}

		return util.elementAtPath(snapshot[head], tail);
	}

	/**
	 * Append a DOM element childElement to another DOM element parentElement. If the DOM element to
	 * be appended is a script, prevent the execution of the script. If the parentElement is a
	 * <template>, add the child to the parentElement's documentFragment instead. If a referenceNode
	 * is specified, the element is inserted before the referenceNode.
	 * @param {DOMNode} parentElement Parent element.
	 * @param {DOMNode} childElement  Child element.
	 */
	util.appendChildWithoutScriptExecution = function(parentElement, childElement, referenceNode) {
		if (childElement.tagName && childElement.tagName.toLowerCase() === "script") {
			var script = childElement.innerHTML;
			childElement.innerHTML = "// Execution prevention";
			parentElement.insertBefore(childElement, referenceNode || null);
			childElement.innerHTML = script;
		} else {
			// If parentElement.content exists, parentElement contains a documentFragment, and we should
			// be adding the content to this documentFragment instead. This happens when parentElement is
			// a <template>.
			if (parentElement.content && parentElement.content === document.DOCUMENT_FRAGMENT_NODE) {
				parentElement = parentElement.content;
			}
			parentElement.insertBefore(childElement, referenceNode || null);
		}
	};

	util.getChildNodes = function(parentElement) {
		if (parentElement.content && parentElement.content === document.DOCUMENT_FRAGMENT_NODE) {
			parentElement = parentElement.content;
		}
		return parentElement.childNodes;
	}

	/**
	 * Traverses an element tree and applies a callback to each element.
	 * @param {DOMNode}   element Element tree to traverse.
	 * @param {Function} callback Callback.
	 * @public
	 */
	util.recursiveForEach = function(element, callback) {
		callback(element);

		Array.from(util.getChildNodes(element)).forEach(function(childNode) {
			util.recursiveForEach(childNode, callback);
		});
	};

	/**
	 * Removes illegal characters from tag names.
	 * @param  {string} tagName Unsanitized tag name.
	 * @return {string}         Sanitized tag name.
	 */
	util.sanitizeTagName = function(tagName) {
		// Defined according to the specification (https://www.w3.org/TR/REC-xml/#NT-Name), but does not
		// support some special characters, because the regex won't accept them.
		var NAME_START_CHAR_REGEX = /\:|[A-Z]|\_|[a-z]/;
		var NAME_CHAR_REGEX = /\-|\.|[0-9]/;

		return tagName.split("").map(function(char, index) {
			if (NAME_START_CHAR_REGEX.test(char) || (index > 0 && NAME_CHAR_REGEX.test(char))) {
				return char;
			}
			return "_";
		}).join("");
	};

	/**
	 * Replaces ampersands (&) and double-quotes (") with their respective HTML entities.
	 * @param  {string} value Unescaped string.
	 * @return {string}       Escaped string.
	 * @public
	 */
	util.escape = function(value) {
		if (!value) return value;
		return value.replace(/&/g, '&amp;').replace(/\"/g, "&quot;");
	}

	/**
	 * Replaces HTML entities for ampersands (&) and double-quotes (") with their actual character
	 * representations.
	 * @param  {string} value Escaped string.
	 * @return {string}       Unescaped string.
	 * @public
	 */
	util.unescape = function(value) {
		if (!value) return value;
		return value.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
	}

	/**
	 * Get random integer from interval [min, max). Unbiased and evenly distributed (or close to).
	 * @param  {int} min Minimum number, inclusive.
	 * @param  {int} max Maximum number, exclusive.
	 * @return {int}     Random number in interval [min, max);
	 * @private
	 */
	var random = function(min, max) {
		return Math.floor(Math.random() * (max - min) + min);
	};

	/**
	 * Get random string of size.
	 * @param  {int} size        Expected length of string (optional).
	 * @param  {string} alphabet List of characters to be used in string (optional).
	 * @return {string}          Generated string.
	 * @public
	 */
	util.randomString = function(size = 8,
		alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-") {
		var len = alphabet.length;
		var str = "";
		while (size--) {
			str += alphabet[random(0, len)];
		}
		return str;
	};

	webstrates.util = util;

	return webstrates;

})(root.webstrates || {});