/*
Webstrates Util (webstrates.util.js)

This file exposes the util object on the Webstrates scope. This object contains functions with common functionality
used by the other Webstrates modules.
*/
var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";

	/**
	 * Get the element at a given path in a JsonML document.
	 * @param  {JsonML} snapshot ShareJS Context (a JsonML document).
	 * @param  {DOMPath} path    Path to follow in snapshot.
	 * @return {JsonML}          Element at path in snapshot.
	 */
	var elementAtPath = function(snapshot, path) {
		if (path.length > 0 && typeof path[path.length-1] === "string") {
			return null;
		}

		var [head, ...tail] = path;
		if (!head) {
			return snapshot;
		}

		return elementAtPath(snapshot[head], tail);
	}

	/**
	 * Replaces ampersands (&) and double-quotes (") with their respective HTML entities.
	 * @param  {string} value Unescaped string.
	 * @return {string}       Escaped string.
	 * @public
	 */
	var escape = function(value) {
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
	var unescape = function(value) {
		if (!value) return "";
		return value.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
	}

	webstrates.util = {
		elementAtPath, escape, unescape
	};

	return webstrates;

})(root.webstrates || {});