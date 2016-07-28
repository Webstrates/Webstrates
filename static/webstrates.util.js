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
	 * @param  {DOMPath} path    Path to follow in snapshot.
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
	 * Traverses an element tree and applies a callback to each element.
	 * @param {DOMNode}   element Element tree to traverse.
	 * @param {Function} callback Callback.
	 * @public
	 */
	util.recursiveForEach = function(element, callback) {
		callback(element);

		var childNodes = element.content ? element.content.childNodes : element.childNodes;
		Array.from(childNodes).forEach(function(childNode) {
			util.recursiveForEach(childNode, callback);
		});
	};

	/**
	 * Replaces ampersands (&) and double-quotes (") with their respective HTML entities.
	 * @param  {string} value Unescaped string.
	 * @return {string}       Escaped string.
	 * @public
	 */
	util.escape = function(value) {
		if (!value) return "";
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
		if (!value) return "";
		return value.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
	}

	webstrates.util = util;

	return webstrates;

})(root.webstrates || {});