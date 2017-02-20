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
	 * Extract a user's permissions from a permissions list.
	 * @param  {string} username        Username.
	 * @param  {string} provider        Login provider (Github, Facebook, OAuth, ...).
	 * @param  {list} permissionsList   Permissions List.
	 * @return {string}                 Docuemnt permissions (r, rw).
	 * @private
	 */
	function getUserPermissionsFromPermissionsList(username, provider, permissionsList) {
		var user = permissionsList.find(function(user) {
			return user.username === username
			    && user.provider === provider;
		});

		if (user) {
			return user.permissions;
		}

		var anonymous = permissionsList.find(function(user) {
			return user.username === "anonymous"
			    && user.provider === "";
		});

		return anonymous ? anonymous.permissions : "";
	};

	/**
	 * Get a user's permissions for a specific snapshot.
	 * @param  {string} username               Username.
	 * @param  {string} provider               Login provider (GitHub, Facebook, OAuth, ...).
	 * @param  {JsonML} snapshot               ShareDB document snapshot.
	 * @param  {obj}    defaultPermissionsList List of default permissions.
	 * @return {string}                        Document permissions (r, rw).
	 * @public
	 */
	util.getPermissionsFromSnapshot = function(username, provider, snapshot, defaultPermissionsList) {
		var permissionsList;

		if (snapshot && snapshot.data && snapshot.data[0] && snapshot.data[0] === "html" &&
			snapshot.data[1] && snapshot.data[1]['data-auth']) {
			try {
				permissionsList = JSON.parse(snapshot.data[1]['data-auth'].replace(/'/g, '"')
					.replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
			} catch (err) {
				console.warn("Couldn't parse document permissions for", snapshot.id);
				// We don't have to do anything. No valid document permissions.
			}

			if (!Array.isArray(permissionsList)) {
				permissionsList = undefined;
			}
		}

		// If we found no permissions, resort to default permissions.
		if (!permissionsList || Object.keys(permissionsList).length === 0) {
			// If there's also no default permissions, we pretend every user has read-write permissions
			// lest we lock everybody out. We append a question mark to let the system know that these are
			// last-resort permissions.
			if (!defaultPermissionsList) {
				return "rw?";
			}
			permissionsList = defaultPermissionsList;
		}

		return getUserPermissionsFromPermissionsList(username, provider, permissionsList);
	};

	/**
	 * Get the element at a given path in a JsonML document.
	 * @param  {JsonML} snapshot ShareJS Context (a JsonML document).
	 * @param  {JsonMLPath} path Path to follow in snapshot.
	 * @return {JsonML}          Element at path in snapshot.
	 * @public
	 */
	util.elementAtPath = function(snapshot, path) {
		if (path.length > 0 && typeof path[path.length-1] === "string") {
			return null;
		}

		var [head, ...tail] = path;
		if (!head || !snapshot[head]) {
			return snapshot;
		}

		return util.elementAtPath(snapshot[head], tail);
	};

	/**
	 * Get child nodes of an element. If the element is a fragment, get the content's child nodes.
	 * @param  {DOMElement} parentElement Element to get child nodes of.
	 * @return {array}                    List of child nodes.
	 */
	util.getChildNodes = function(parentElement) {
		if (parentElement.content && parentElement.content === document.DOCUMENT_FRAGMENT_NODE) {
			parentElement = parentElement.content;
		}
		return parentElement.childNodes;
	};

	/**
	 * Traverses an element tree and applies a callback to each element.
	 * @param {DOMNode}  element  Element tree to traverse.
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
	 * Append a DOM element childElement to another DOM element parentElement. If the DOM element to
	 * be appended is a script, prevent the execution of the script. If the parentElement is a
	 * <template>, add the child to the parentElement's documentFragment instead. If a referenceNode
	 * is specified, the element is inserted before the referenceNode.
	 * @param {DOMNode} parentElement Parent element.
	 * @param {DOMNode} childElement  Child element.
	 */
	util.appendChildWithoutScriptExecution = function(parentElement, childElement, referenceNode) {
		// Remove all children, so we can later insert them. This way, we can prevent script execution.
		var childElementsChildren = [];
		while (childElement.firstChild) {
			childElementsChildren.push(childElement.removeChild(childElement.firstChild));
		}

		// To prevent scripts from being executed when inserted, we use a little hack. Before inserting
		// the script, we replace the actual script with dummy content, causing that to be executed
		// instead of the actual script. If it's an inline script, we insert a script with dummy content
		// ("// Execution prevention"), and then replace the innerHTML afterwards. If the script is from
		// an external resource, set the src attribute "about:blank", and then set it to the actual src.
		// This way, only "about:blank" will be loaded.
		// To prevent issues with any other attributes (e.g. crossorigin and integrity), we also remove
		// all those attributes and insert them later.
		if (childElement.tagName && childElement.tagName.toLowerCase() === "script") {
			// Save all attributes and innerHTML.
			var src = childElement.src;
			var attrs = [];
			Array.from(childElement.attributes).forEach(function(attr) {
				attrs.push([ attr.nodeName, attr.nodeValue ]);
				childElement.removeAttribute(attr.nodeName);
			});

			var innerHTML = childElement.innerHTML;
			childElement.innerHTML = "// Execution prevention";

			// Now insert a bare script (dummy content and empty src).
			parentElement.insertBefore(childElement, referenceNode || null);

			// And re-add attributes and real content.
			attrs.forEach(function(attr) {
				var [nodeName, nodeValue] = attr;
				childElement.setAttribute(nodeName, nodeValue);
			});
			childElement.innerHTML = innerHTML;
		} else {
			// If parentElement.content exists, parentElement contains a documentFragment, and we should
			// be adding the content to this documentFragment instead. This happens when parentElement is
			// a <template>.
			if (parentElement.content &&
				parentElement.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
				parentElement = parentElement.content;
			}
			parentElement.insertBefore(childElement, referenceNode || null);
		}

		var childElemensChild;
		while (childElemensChild = childElementsChildren.shift()) {
			util.appendChildWithoutScriptExecution(childElement, childElemensChild);
		}
	};

	/**
	 * Reinsert and execute an array of scripts in order.
	 * @param {array}    scripts  Array of script DOM elements.
	 * @param {Function} callback Function to call once all scripts have been executed.
	 */
	util.executeScripts = function(scripts, callback) {
		var script = scripts.shift();
		if (!script) {
			return callback();
		}

		var executeImmediately = !script.src;
		var newScript = document.createElementNS(script.namespaceURI, "script");
		if (!executeImmediately) {
			newScript.onload = newScript.onerror = function() {
				util.executeScripts(scripts, callback);
			};
		}

		for (var i = 0; i < script.attributes.length; i++) {
			var attr = script.attributes[i];
			newScript.setAttribute(attr.nodeName, attr.nodeValue);
		}

		newScript.innerHTML = script.innerHTML;

		script.parentElement.insertBefore(newScript, script);
		script.remove();

		if (executeImmediately) {
			util.executeScripts(scripts, callback);
		}
	};

	/**
	 * Removes characters that are illegal in attributes and tag names.
	 * @param  {string} tagName Unsanitized string.
	 * @return {string}         Sanitized string.
	 */
	util.sanitizeString = function(string) {
		// See https://www.w3.org/TR/html5/syntax.html#syntax-tag-name and
		// https://www.w3.org/TR/html5/syntax.html#syntax-attribute-name
		var NAME_START_CHAR_REGEX = /\:|[A-Z]|\_|[a-z]/;
		var NAME_CHAR_REGEX = /\-|\.|[0-9]/;

		return string.split("").map(function(char, index) {
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
	};

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
	};

	/**
	 * Get random integer from interval [min, max). Unbiased and evenly distributed (or close to).
	 * @param  {int} min Minimum number, inclusive.
	 * @param  {int} max Maximum number, exclusive.
	 * @return {int}     Random number in interval [min, max);
	 * @private
	 */
	function random(min, max) {
		return Math.floor(Math.random() * (max - min) + min);
	};

	/**
	 * Get random string of size.
	 * @param  {int}    size     Expected length of string (optional).
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

	/**
	 * Clone an object by exploiting JSON parse/stringify.
	 * @param  {obj} obj Object to be cloned.
	 * @return {obj}     Cloned object.
	 * @public
	 */
	util.cloneObject = function(obj) {
		return JSON.parse(JSON.stringify(obj));
	};

	webstrates.util = util;

	return webstrates;

})(root.webstrates || {});