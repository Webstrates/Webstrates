/* jqml - jQuery JSONML Plugin
 * Author: Trevor Norris
 * This document is licensed as free software under the terms of the
 * MIT License: http://www.opensource.org/licenses/mit-license.php
 * Adapted to work with Webstrates by Clemens N. Klokmose
 */
(function(document, global) {

	function getNs(elem) {
		if (!elem) return undefined;
		var ns;
		for (var index in elem) {
			if (index === 'xmlns') {
				ns = elem[index];
			}
		}

		if (ns !== undefined) {
			return ns;
		}

		if (elem.parent === elem) {
			return undefined;
		}

		return getNs(elem.parent);
	}

	var isArray = Array.isArray || function(arg) {
		return {}.toString.call(arg) === '[object Array]';
	};

	function isPlainObject(obj) {
		return obj && typeof obj === "object" &&
			Object.getPrototypeOf(obj) === Object.prototype && !obj.nodeType;
	}

	function createObj(elem, xmlNs) {
		var fragment = document.createDocumentFragment();
		var i = 0;
		var selector;
		var name = null

		// check if is an element or array of elements
		if (typeof elem[0] == 'string') {
			name = elem[0];
			i = 1;
		}

		if (elem[0] === "!") {
			return document.createComment(elem[1]);
		}

		for (; i < elem.length; i++) {
			// if array create new element
			if (isArray(elem[i])) {
				fragment.appendChild(createObj(elem[i], xmlNs));

				// if object set element attributes
			} else if (isPlainObject(elem[i])) {
				if (name) {
					if (xmlNs === undefined) {
						xmlNs = getNs(elem[i]);
					}
					if (xmlNs) {
						selector = document.createElementNS(xmlNs, name);
					} else {
						selector = document.createElement(name);
					};
					for (var index in elem[i]) {
						var value = elem[i][index].replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
						if (xmlNs !== undefined) {
							if (index === "href" || index === "xlink:href") {
								selector.setAttributeNS('http://www.w3.org/1999/xlink', index, value);
							}
						}
						selector.setAttribute(index, value);
					}
				}

				// if string or number insert text node
			} else if (typeof elem[i] == 'number' || typeof elem[i] == 'string') {
				fragment.appendChild(document.createTextNode(elem[i]));

				// if is an element append to fragment
			} else if (elem[i].nodeType) {
				fragment.appendChild(elem[i]);
			}
		}

		if (!selector && name) {
			selector = document.createElement(name);
		}

		// if a selector is set append children and return
		if (selector) {
			selector.appendChild(fragment);
			return selector;
		}

		// otherwise return children of fragment
		return fragment.childNodes;
	}

	global.jqml = function(arg, namespace) {
		// return new jQuery object of elements
		return createObj(arg, namespace);
	};

})(document, this);