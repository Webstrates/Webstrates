/*
	jsonml-dom.js
	DOM to JsonML utility

	Created: 2007-02-15-2235
	Modified: 2008-08-31-2206

	Copyright (c)2006-2010 Stephen M. McKamey
	Distributed under The MIT License: http://jsonml.org/license
*/

var JsonML = JsonML || {};

/*JsonML*/ JsonML.parseDOM = function(/*DOM*/ elem, /*function*/ filter) {
	if (!elem || !elem.nodeType) {
		// free references
		return (elem = null);
	}

	function addChildren(/*DOM*/ elem, /*function*/ filter, /*JsonML*/ jml) {
		if (elem.hasChildNodes()) {
			for (var i=0; i<elem.childNodes.length; i++) {
				var child = elem.childNodes[i];
				child = JsonML.parseDOM(child, filter);
				if (child) {
					jml.push(child);
				}
			}
			return true;
		}
		return false;
	}

	var i, jml;
	switch (elem.nodeType) {
		case 1:  // element
		case 9:  // document
		case 11: // documentFragment
			jml = [elem.tagName||""];

			var attr = elem.attributes,
				props = {},
				hasAttrib = false;

			for (i=0; attr && i<attr.length; i++) {
				if (attr[i].specified) {
					if (attr[i].name === "style") {
						props.style = elem.style.cssText || attr[i].value;
					} else if ("string" === typeof attr[i].value) {
						props[attr[i].name] = attr[i].value;
					}
					hasAttrib = true;
				}
			}
			//if (hasAttrib) {
				jml.push(props);
			//}

			var child;
			switch (jml[0].toLowerCase()) {
				case "frame":
				case "iframe":
					try {
						if ("undefined" !== typeof elem.contentDocument) {
							// W3C
							child = elem.contentDocument;
						} else if ("undefined" !== typeof elem.contentWindow) {
							// Microsoft
							child = elem.contentWindow.document;
						} else if ("undefined" !== typeof elem.document) {
							// deprecated
							child = elem.document;
						}

						child = JsonML.parseDOM(child, filter);
						if (child) {
							jml.push(child);
						}
					} catch (ex) {}
					break;
				case "style":
					child = elem.styleSheet && elem.styleSheet.cssText;
					if (child && "string" === typeof child) {
						// unwrap comment blocks
						child = child.replace("<!--", "").replace("-->", "");
						jml.push(child);
					} else if (elem.hasChildNodes()) {
						for (i=0; i<elem.childNodes.length; i++) {
							child = elem.childNodes[i];
							child = JsonML.parseDOM(child, filter);
							if (child && "string" === typeof child) {
								// unwrap comment blocks
								child = child.replace("<!--", "").replace("-->", "");
								jml.push(child);
							}
						}
					}
					break;
				case "input":
					addChildren(elem, filter, jml);
					child = (elem.type !== "password") && elem.value;
					if (child) {
						if (!hasAttrib) {
							// need to add an attribute object
							jml.shift();
							props = {};
							jml.unshift(props);
							jml.unshift(elem.tagName||"");
						}
						props.value = child;
					}
					break;
				case "textarea":
					if (!addChildren(elem, filter, jml)) {
						child = elem.value || elem.innerHTML;
						if (child && "string" === typeof child) {
							jml.push(child);
						}
					}
					break;
				default:
					addChildren(elem, filter, jml);
					break;
			}
			
			// filter result
			if ("function" === typeof filter) {
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
			jml = ["!"];

			var type = ["DOCTYPE", (elem.name || "html").toLowerCase()];

			if (elem.publicId) {
				type.push("PUBLIC", '"' + elem.publicId + '"');
			}

			if (elem.systemId) {
				type.push('"' + elem.systemId + '"');
			}

			jml.push(type.join(" "));

			// filter result
			if ("function" === typeof filter) {
				jml = filter(jml, elem);
			}

			// free references
			elem = null;
			return jml;
		case 8: // comment node
			if ((elem.nodeValue||"").indexOf("DOCTYPE") !== 0) {
				// free references
				elem = null;
				return null;
			}

			jml = ["!",
					elem.nodeValue];

			// filter result
			if ("function" === typeof filter) {
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

/*JsonML*/ JsonML.parseHTML = function(/*string*/ html, /*function*/ filter) {
	var elem = document.createElement("div");
	elem.innerHTML = html;
	var jml = JsonML.parseDOM(elem, filter);

	// free references
	elem = null;

	if (jml.length === 2) {
		return jml[1];
	}

	// make wrapper a document fragment
	jml[0] = "";
	return jml;
};
