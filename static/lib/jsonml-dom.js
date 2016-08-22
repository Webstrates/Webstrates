/*
	jsonml-dom.js
	HTML to JsonML utility

	Created: 2007-02-15-2235
	Modified: 2012-11-03-2051

	Copyright (c) 2006-2012 Stephen M. McKamey
	Distributed under The MIT License: http://jsonml.org/license

	Adapted to work with Webstrates by Clemens N. Klokmose and Kristian B. Antonsen
*/

var JsonML = JsonML || {};

(function(JsonML, document){
	'use strict';

	var addChildren = function(/*DOM*/ elem, /*function*/ filter, /*JsonML*/ jml) {
		var childNodes;
		if (childNodes = webstrates.util.getChildNodes(elem)) {
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
	};

	/**
	 * @param {Node} elem
	 * @param {function} filter
	 * @return {array} JsonML
	 */
	var fromHTML = JsonML.fromHTML = function(elem, filter) {
		// If an element doesn't have a PathTree, we don't want it in the JsonML. This will be the case
		// for <transient> elements.
		if (!elem || !elem.nodeType || !elem.__pathNodes || elem.__pathNodes.length === 0) {
			// free references
			return (elem = null);
		}

		var i, jml;
		switch (elem.nodeType) {
			case 1:  // element
			case 9:  // document
			case 11: // documentFragment
				jml = [elem.tagName||''];

				var attr = elem.attributes,
					props = {},
					hasAttrib = false;

				for (i=0; attr && i<attr.length; i++) {
					if (attr[i].specified) {
						if (attr[i].name === 'style') {
							props.style = elem.style.cssText || attr[i].value;
						} else if ('string' === typeof attr[i].value) {
							props[attr[i].name] = attr[i].value;
						}
						hasAttrib = true;
					}
				}
				//if (hasAttrib) {
					jml.push(props); //Webstrates always assumes that an element has attributes.
                //}

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
						} else if (childNodes = webstrates.util.getChildNodes(elem)) {
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
	};

	/**
	 * @param {string} html HTML text
	 * @param {function} filter
	 * @return {array} JsonML
	 */
	JsonML.fromHTMLText = function(html, filter) {
		var elem = document.createElement('div');
		elem.innerHTML = html;

		var jml = fromHTML(elem, filter);

		// free references
		elem = null;

		if (jml.length === 2) {
			return jml[1];
		}

		// make wrapper a document fragment
		jml[0] = '';
		return jml;
	};

})(JsonML, document);