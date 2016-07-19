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

	webstrates.util = {
		elementAtPath
	};

	return webstrates;

})(root.webstrates || {});