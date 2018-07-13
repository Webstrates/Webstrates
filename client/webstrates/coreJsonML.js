'use strict';
/* JsonML <-> HTML library by Kristian B. Antonsen
 * This library is based on jQuery JSONML Plugin by Trevor Norris.
 * This document is licensed as free software under the terms of the
 * MIT License: http://www.opensource.org/licenses/mit-license.php
 */
const coreUtils = require('./coreUtils');
const coreDOM = require('./coreDOM');

const coreJsonML = {};

function isPlainObject(obj) {
	return obj && typeof obj === 'object'
	// Previously, we did comparison like: Object.getPrototypeOf(obj) === Object.prototype, but we
	// can no longer do that, because if we use the parent's ShareDB Connection, plain objects created
	// in the outer frame will have used that frame's Object.prototype, which is not the same as the
	// Object.prototype in the inner frame, even though they're identical. Basically:
	// window.Object !== iframe.contentWindow.Object.
	&& Object.prototype.toString.call(obj) === '[object Object]';
}

function toHTML(elem, xmlNs, scripts) {
	const fragment = document.createDocumentFragment();
	let i = 0;
	let name = null;
	let selector;

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
			// children of foreignobject element should use the default XHTML namespace
			// ('http://www.w3.org/1999/xhtml'), so we set it to undefined. Curiously enough, if we
			// actually do `xmlNs = "http://www.w3.org/1999/xhtml"`, stuff won't be rendered properly.
			if (name.toLowerCase() === 'foreignobject') {
				xmlNs = undefined;
			}

			fragment.appendChild(toHTML(elem[i], xmlNs, scripts));

			// If object set element attributes
		} else if (isPlainObject(elem[i])) {
			if (name) {

				name = coreUtils.sanitizeString(name);

				// When loading a website with an SVG element without a namespace attribute, Chrome will
				// guess the namespace itself. When adding it like we do with Webstrates, it won't. So
				// to have Webstrates give us a more normal browser experience, we add the namespace
				// manually.
				if (name.toLowerCase() === 'svg') {
					xmlNs = 'http://www.w3.org/2000/svg';
				}

				// As also mentioned in regards to foreignobject, setting the namspace to the default
				// ("http://www.w3.org/1999/xhtml") causes stuff to not render properly.
				if (xmlNs && xmlNs !== 'http://www.w3.org/1999/xhtml') {
					selector = document.createElementNS(xmlNs, name);
				} else {
					selector = document.createElement(name);
				}

				// Add attributes to the element.
				for (let index in elem[i]) {
					// The __wid attribute is a unique ID assigned each node and should not be in the DOM, but
					// instead be a property on the DOM element.
					if (index.toLowerCase() === '__wid') {
						coreUtils.setWidOnElement(selector, elem[i][index]);
						continue;
					}
					const value = coreUtils.unescape(elem[i][index]);
					index = coreUtils.sanitizeString(index);
					if (xmlNs === 'http://www.w3.org/2000/svg') {
						if (index === 'href' || index === 'xlink:href') {
							selector.setAttributeNS('http://www.w3.org/1999/xlink', index, value,
								coreDOM.elementOptions);
						}
					}
					const isSvgPath = selector.tagName.toLowerCase() === 'path' && index === 'd';
					if (isSvgPath) {
						selector.__d = value;
					}
					selector.setAttribute(coreUtils.unescapeDots(index), value, coreDOM.elementOptions);
				}

				// Add scripts to our scripts list, so we can execute them later synchronously.
				if (selector.tagName.toLowerCase() === 'script') {
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
	const childNodes = coreUtils.getChildNodes(elem);
	if (childNodes.length === 0) return false;

	for (let i=0; i<childNodes.length; i++) {
		const child = fromHTML(childNodes[i], filter);
		if (child) {
			jml.push(child);
		}
	}

	return true;
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

	let i, jml;
	switch (elem.nodeType) {
		case document.ELEMENT_NODE:
		case document.DOCUMENT_NODE:
		case document.DOCUMENT_FRAGMENT_NODE: {
			jml = [elem.tagName||''];

			const attr = elem.attributes;
			let props = {};
			let hasAttrib = false;

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
				props.__wid = elem.__wid;
				hasAttrib = true;
			}

			jml.push(props); //Webstrates always assumes that an element has attributes.

			let child, childNodes;
			switch (jml[0].toLowerCase()) {
				case 'frame':
				case 'iframe':
					break; //Do not recursively serialize content in iFrames (CNK)
				case 'style':
					child = elem.styleSheet && elem.styleSheet.cssText;
					if (child && 'string' === typeof child) {
						// unwrap comment blocks
						child = child.replace('<!--', '').replace('-->', '');
						jml.push(child);
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
		}
		case Node.TEXT_NODE: // text node
		case Node.CDATA_SECTION_NODE: { // CDATA node
			const str = String(elem.nodeValue);
			// free references
			elem = null;
			return str;
		}
		case Node.DOCUMENT_TYPE_NODE: { // doctype
			jml = ['!'];

			const type = ['DOCTYPE', (elem.name || 'html').toLowerCase()];

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
		}
		case Node.COMMENT_NODE: { // comment node
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
		}
		default: { // etc.
			// free references
			return (elem = null);
		}
	}
}

coreJsonML.fromHTML = fromHTML;

module.exports = coreJsonML;