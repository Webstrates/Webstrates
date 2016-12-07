/* jqml - jQuery JSONML Plugin
 * Author: Trevor Norris
 * This document is licensed as free software under the terms of the
 * MIT License: http://www.opensource.org/licenses/mit-license.php
 * Adapted to work with Webstrates by Clemens N. Klokmose and
 * Kristian B. Antonsen
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

	function createObj(elem, xmlNs, scripts) {
		var fragment = document.createDocumentFragment();
		var i = 0;
		var selector;
		var name = null

		// Check if is an element or array of elements
		if (typeof elem[0] == 'string') {
			name = elem[0];
			i = 1;
		}

		if (elem[0] === "!" || elem[0] === "#comment") {
			return document.createComment(elem.slice(typeof elem[1] === "string" ? 1 : 2).join(""));
		}

		for (; i < elem.length; i++) {
			// If array create new element
			if (isArray(elem[i])) {
				fragment.appendChild(createObj(elem[i], xmlNs, scripts));

				// If object set element attributes
			} else if (isPlainObject(elem[i])) {
				if (name) {
					name = webstrates.util.sanitizeString(name);
					if (!xmlNs) {
						xmlNs = getNs(elem[i]);
					}

					// When loading a website with an SVG element without a namespace attribute, Chrome will
					// guess the namespace itself. When adding it like we do with Webstrates, it won't. So
					// to have Webstrates give us a more normal browser experience, we add the namespace
					// manually.
					if (!xmlNs && name === "svg") {
						xmlNs = "http://www.w3.org/2000/svg";
					}

					if (xmlNs) {
						selector = document.createElementNS(xmlNs, name);
					} else {
						selector = document.createElement(name);
					}

					// Add attributes to the element.
					for (var index in elem[i]) {
						// The __wid attribute is a unique ID assigned each node and should not be in the DOM.
						if (index.toLowerCase() === "__wid") {
							continue;
						}
						var value = elem[i][index] && elem[i][index]
							.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
						index = webstrates.util.sanitizeString(index);
						if (xmlNs) {
							if (index === "href" || index === "xlink:href") {
								selector.setAttributeNS('http://www.w3.org/1999/xlink', index, value);
							}
						}
						var isSvgPath = selector.tagName.toLowerCase() === "path" && index === "d";
						if (isSvgPath) {
							selector.__d = value;
						}
						selector.setAttribute(index, value);
					}

					// Add scripts to our scripts list, so we can execute them later synchronously. Only add
					// JavaScripts, i.e. scripts either without a type attribute, or with "text/javascript" as
					// the type attribute.
					if (selector.tagName.toLowerCase() === "script" && (!selector.getAttribute("type") ||
						selector.getAttribute("type") === "text/javascript")) {
						selector.async = false;
						scripts && scripts.push(selector);
					}
				}

				// If string or number insert text node
			} else if (typeof elem[i] == 'number' || typeof elem[i] == 'string') {
				fragment.appendChild(document.createTextNode(elem[i]));

				// If is an element append to fragment
			} else if (elem[i].nodeType) {
				fragment.appendChild(elem[i]);
			}
		}

		if (!selector && name) {
			name = webstrates.util.sanitizeString(name);
			selector = document.createElement(name);
		}

		// If a selector is set append children and return
		if (selector) {
			// When creating <templates>, we need the document to actually contain an documentFragment.
			// If we just add a documentFragment to an element, the children of documentFragment will
			// actually be added instead. To prevent this, we add the children to the `content` property
			// if it exists.
			if (selector.content && selector.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
				selector = selector.content;
			}
			selector.appendChild(fragment);
			return selector;
		}

		// Otherwise return children of fragment
		return fragment.childNodes;
	}

	global.jqml = function(arg, namespace, scripts) {
		return createObj(arg, namespace, scripts);
	};

})(document, this);