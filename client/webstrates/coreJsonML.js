'use strict';
const coreUtils = require('./coreUtils');

/* JsonML <-> HTML library by Kristian B. Antonsen
 * This library is based on jQuery JSONML Plugin by Trevor Norris.
 * This document is licensed as free software under the terms of the
 * MIT License: http://www.opensource.org/licenses/mit-license.php
 */

const coreJsonML = {};

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

function isPlainObject(obj) {
	return obj && typeof obj === 'object' &&
		Object.getPrototypeOf(obj) === Object.prototype && !obj.nodeType;
}

function toHTML(elem, xmlNs, scripts) {
	var fragment = document.createDocumentFragment();
	var i = 0;
	var selector;
	var name = null;

	// Check if is an element or array of elements
	if (typeof elem[0] == 'string') {
		name = elem[0];
		i = 1;
	}

	if (elem[0] === '!' || elem[0] === '#comment') {
		return document.createComment(elem.slice(typeof elem[1] === 'string' ? 1 : 2).join(''));
	}

	for (; i < elem.length; i++) {
		// If array create new element
		if (Array.isArray(elem[i])) {
			fragment.appendChild(toHTML(elem[i], xmlNs, scripts));

			// If object set element attributes
		} else if (isPlainObject(elem[i])) {
			if (name) {
				name = coreUtils.sanitizeString(name);
				if (!xmlNs) {
					xmlNs = getNs(elem[i]);
				}

				// When loading a website with an SVG element without a namespace attribute, Chrome will
				// guess the namespace itself. When adding it like we do with Webstrates, it won't. So
				// to have Webstrates give us a more normal browser experience, we add the namespace
				// manually.
				if (!xmlNs && name === 'svg') {
					xmlNs = 'http://www.w3.org/2000/svg';
				}

				if (xmlNs) {
					selector = document.createElementNS(xmlNs, name);
				} else {
					selector = document.createElement(name);
				}

				// Add attributes to the element.
				for (var index in elem[i]) {
					// The __wid attribute is a unique ID assigned each node and should not be in the DOM, but
					// instead be a property on the DOM element.
					if (index.toLowerCase() === '__wid') {
						coreUtils.setWidOnElement(selector, elem[i][index]);
						continue;
					}
					var value = elem[i][index] && elem[i][index]
						.replace(/&quot;/g, '\'').replace(/&amp;/g, '&');
					index = coreUtils.sanitizeString(index);
					if (xmlNs) {
						if (index === 'href' || index === 'xlink:href') {
							selector.setAttributeNS('http://www.w3.org/1999/xlink', index, value);
						}
					}
					var isSvgPath = selector.tagName.toLowerCase() === 'path' && index === 'd';
					if (isSvgPath) {
						selector.__d = value;
					}
					selector.setAttribute(index, value);
				}

				// Add scripts to our scripts list, so we can execute them later synchronously. Only add
				// JavaScripts, i.e. scripts either without a type attribute, or with 'text/javascript' as
				// the type attribute.
				if (selector.tagName.toLowerCase() === 'script' && (!selector.getAttribute('type') ||
					selector.getAttribute('type') === 'text/javascript')) {
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
		name = coreUtils.sanitizeString(name);
		selector = document.createElement(name);
	}

	// If a selector is set append children and return
	if (selector) {
		// When creating <templates>, we need the document to actually contain an documentFragment.
		// If we just add a documentFragment to an element, the children of documentFragment will
		// actually be added instead. To prevent this, we add the children to the `content` property
		// if it exists.
		if (selector.content && selector.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			selector.content.appendChild(fragment);
		} else {
			selector.appendChild(fragment);
		}
		return selector;
	}

	// Otherwise return children of fragment
	return fragment.childNodes;
}

coreJsonML.toHTML = toHTML;

function addChildren(/*DOM*/ elem, /*function*/ filter, /*JsonML*/ jml) {
	var childNodes = coreUtils.getChildNodes(elem);
	if ((childNodes = coreUtils.getChildNodes(elem))) {
		for (var i=0; i<childNodes.length; i++) {
			var child = childNodes[i];
			child = fromHTML(child, filter);
			if (child) {
				jml.push(child);
			}
		}
		return true;
	}
	return false;
}

/**
 * @param {Node} elem
 * @param {function} filter
 * @return {array} JsonML
 */
function fromHTML(elem, filter) {
	// If an element doesn't have a PathTree, we don't want it in the JsonML. This will be the case
	// for <transient> elements.
	if (!elem || !elem.nodeType || !elem.__pathNodes || elem.__pathNodes.length === 0) {
		// free references
		return (elem = null);
	}

	var i, jml;
	switch (elem.nodeType) {
		case document.ELEMENT_NODE:
		case document.DOCUMENT_NODE:
		case document.DOCUMENT_FRAGMENT_NODE:
			jml = [elem.tagName||''];

			var attr = elem.attributes,
				props = {},
				hasAttrib = false;

			for (i=0; attr && i<attr.length; i++) {
				// Transient attributes should not be added to the JsonML.
				if (config.isTransientAttribute(elem, attr[i].name)) {
					continue;
				}
				if (attr[i].specified) {
					if (attr[i].name === 'style') {
						props.style = elem.style.cssText || attr[i].value;
					} else if ('string' === typeof attr[i].value) {
						if (elem.namespaceURI === 'http://www.w3.org/2000/svg') {
							props[attr[i].name.toLowerCase()] = attr[i].value;
						} else {
							props[attr[i].name] = attr[i].value;
						}
					}
					hasAttrib = true;
				}
			}

			if (elem.__wid) {
				props['__wid'] = elem.__wid;
				hasAttrib = true;
			}

			jml.push(props); //Webstrates always assumes that an element has attributes.

			var child, childNodes;
			switch (jml[0].toLowerCase()) {
				case 'frame':
				case 'iframe':
					break; //Do not recursively serialize content in iFrames (CNK)
			/*try {
				if ('undefined' !== typeof elem.contentDocument) {
					// W3C
					child = elem.contentDocument;
				} else if ('undefined' !== typeof elem.contentWindow) {
					// Microsoft
					child = elem.contentWindow.document;
				} else if ('undefined' !== typeof elem.document) {
					// deprecated
					child = elem.document;
				}

				child = fromHTML(child, filter);
				if (child) {
					jml.push(child);
				}
			} catch (ex) {}
			break;*/
				case 'style':
					child = elem.styleSheet && elem.styleSheet.cssText;
					if (child && 'string' === typeof child) {
				// unwrap comment blocks
						child = child.replace('<!--', '').replace('-->', '');
						jml.push(child);
			// elem.content may have childNodes if elem is a template (i.e. elem.content is a
			// document fragment).
					} else if ((childNodes = coreUtils.getChildNodes(elem))) {
						for (i=0; i<childNodes.length; i++) {
							child = childNodes[i];
							child = fromHTML(child, filter);
							if (child && 'string' === typeof child) {
						// unwrap comment blocks
								child = child.replace('<!--', '').replace('-->', '');
								jml.push(child);
							}
						}
					}
					break;
				case 'input':
					addChildren(elem, filter, jml);
					child = (elem.type !== 'password') && elem.value;
					if (child) {
						if (!hasAttrib) {
					// need to add an attribute object
							jml.shift();
							props = {};
							jml.unshift(props);
							jml.unshift(elem.tagName||'');
						}
						props.value = child;
					}
					break;
				case 'textarea':
					if (!addChildren(elem, filter, jml)) {
						child = elem.value || elem.innerHTML;
						if (child && 'string' === typeof child) {
							jml.push(child);
						}
					}
					break;
				default:
					addChildren(elem, filter, jml);
					break;
			}

		// filter result
			if ('function' === typeof filter) {
				jml = filter(jml, elem);
			}

		// free references
			elem = null;
			return jml;
		case 3: // text node
		case 4: // CDATA node
			var str = String(elem.nodeValue);
		// free references
			elem = null;
			return str;
		case 10: // doctype
			jml = ['!'];

			var type = ['DOCTYPE', (elem.name || 'html').toLowerCase()];

			if (elem.publicId) {
				type.push('PUBLIC', '"' + elem.publicId + '"');
			}

			if (elem.systemId) {
				type.push('"' + elem.systemId + '"');
			}

			jml.push(type.join(' '));

		// filter result
			if ('function' === typeof filter) {
				jml = filter(jml, elem);
			}
		// free references
			elem = null;
			return jml;
		case 8: // comment node
			if ((elem.nodeValue||'').indexOf('DOCTYPE') !== -1) {
			// free references
				elem = null;
				return null;
			}

			jml = ['!',
				elem.nodeValue];

		// filter result
			if ('function' === typeof filter) {
				jml = filter(jml, elem);
			}

		// free references
			elem = null;
			return jml;
		default: // etc.
		// free references
			return (elem = null);
	}
}

coreJsonML.fromHTML = fromHTML;

module.exports = coreJsonML;