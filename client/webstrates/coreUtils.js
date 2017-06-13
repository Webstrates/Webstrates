'use strict';
const coreUtilsModule = {};

let locationObject;
/**
 * Parses a query string and returns a more friendly object.
 * @param  {Location} location Location object.
 * @return {object}            Object with webstrateId, tagOrVersion and parameters.
 */
coreUtilsModule.getLocationObject = () => {
	if (locationObject) {
		return locationObject;
	}

	const pathRegex = /^\/([A-Z0-9\._-]+)\/(?:([A-Z0-9_-]+)\/)?/i.exec(window.location.pathname);
	const [ , webstrateId, tagOrVersion] = pathRegex;

	const parameters = {};
	const queryRegex =  /([^&=]+)=?([^&]*)/g;
	const query = window.location.search.substring(1);

	let match;
	while ((match = queryRegex.exec(query))) {
		const [, key, value] = match;
		parameters[key] = decodeURIComponent(value);
	}

	let tag, version;
	if (/^\d/.test(tagOrVersion) && Number(tagOrVersion)) {
		version = Number(tagOrVersion);
	} else {
		tag = tagOrVersion;
	}

	locationObject = {
		webstrateId,
		staticMode: !!tagOrVersion,
		tagOrVersion,
		tag, version, // Only one of tag/version will be set
		parameters
	};

	return locationObject;
};

/**
 * Checks for literal equality of objects. This is a stupid way, but it works.
 * @param  {obj} a First object to compare.
 * @param  {obj} b Second object to compare.
 * @return {bool}  True if objects are equal.
 * @public
 */
coreUtilsModule.objectEquals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Shallow clones an object.
 * @param  {obj} obj Object to be copied.
 * @return {obj}     Shallow clone.
 * @public
 */
coreUtilsModule.objectClone = (obj) => Object.assign({}, obj);

/**
 * Get random integer from interval [min, max). Unbiased and evenly distributed (or close to).
 * @param  {int} min Minimum number, inclusive.
 * @param  {int} max Maximum number, exclusive.
 * @return {int}     Random number in interval [min, max)
 * @public
 */
coreUtilsModule.random = (min, max) => {
	return Math.floor(min + Math.random() * (max - min));
};

/**
 * Get random string of size.
 * @param  {int}    size     Expected length of string (optional).
 * @param  {string} alphabet List of characters to be used in string (optional).
 * @return {string}          Generated string.
 * @public
 */
coreUtilsModule.randomString = (size = 8,
	// Does not include 0, O, o, 1, I, l for readability.
	alphabet = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ') => {
	const len = alphabet.length;
	let str = '';
	while (size--) {
		str += alphabet[coreUtilsModule.random(0, len)];
	}
	return str;
};

/**
 * Get child nodes of an element. If the element is a fragment, get the content's child nodes.
 * @param  {DOMElement} parentElement Element to get child nodes of.
 * @return {array}                    List of child nodes.
 */
coreUtilsModule.getChildNodes = function(parentElement) {
	if (parentElement.content && parentElement.content === document.DOCUMENT_FRAGMENT_NODE) {
		parentElement = parentElement.content;
	}
	return parentElement.childNodes;
};

/**
 * Traverses a node tree and applies a callback to each node.
 * @param {DOMNode}  node     Node tree to traverse.
 * @param {DOMNode}  parent   Initial parent node.
 * @param {Function} callback Callback.
 * @public
 */
coreUtilsModule.recursiveForEach = function(node, callback, parent = null) {
	callback(node, parent);

	Array.from(coreUtilsModule.getChildNodes(node)).forEach(child => {
		coreUtilsModule.recursiveForEach(child, callback, node);
	});
};

/**
 * Append a DOM element childElement to another DOM element parentElement. If the DOM element to
 * be appended is a script, prevent the execution of the script. If the parentElement is a
 * <template>, add the child to the parentElement's documentFragment instead. If a referenceNode
 * is specified, the element is inserted before the referenceNode.
 * @param {DOMNode} parentElement Parent element.
 * @param {DOMNode} childElement  Child element.
 * @public
 */
coreUtilsModule.appendChildWithoutScriptExecution = (parentElement, childElement,
	referenceNode) => {
	// Remove all children, so we can later insert them. This way, we can prevent script execution.
	const childElementsChildren = [];
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
	if (childElement instanceof HTMLScriptElement) {
		// Save all attributes and innerHTML.
		const attrs = [];
		Array.from(childElement.attributes).forEach(function(attr) {
			attrs.push([ attr.nodeName, attr.nodeValue ]);
			childElement.removeAttribute(attr.nodeName);
		});

		const innerHTML = childElement.innerHTML;
		childElement.innerHTML = '// Execution prevention';

		// Now insert a bare script (dummy content and empty src).
		parentElement.insertBefore(childElement, referenceNode || null);

		// And re-add attributes and real content.
		attrs.forEach(function(attr) {
			const [nodeName, nodeValue] = attr;
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

	let childElemensChild;
	while ((childElemensChild = childElementsChildren.shift())) {
		coreUtilsModule.appendChildWithoutScriptExecution(childElement, childElemensChild);
	}
};

/**
 * Reinsert and execute an array of scripts in order.
 * @param {array}    scripts  Array of script DOM elements.
 * @param {Function} callback Function to call once all scripts have been executed.
 * @public
 */
coreUtilsModule.executeScripts = (scripts, callback) => {
	var script = scripts.shift();
	if (!script) {
		return callback();
	}

	var executeImmediately = !script.src;
	var newScript = document.createElementNS(script.namespaceURI, 'script');
	if (!executeImmediately) {
		newScript.onload = newScript.onerror = function() {
			coreUtilsModule.executeScripts(scripts, callback);
		};
	}

	// Copy over all attribtues.
	for (var i = 0; i < script.attributes.length; i++) {
		var attr = script.attributes[i];
		newScript.setAttribute(attr.nodeName, attr.nodeValue);
	}

	// Copy over all other properties.
	Object.assign(newScript, script);

	// We're defining the wid with defineProperty to make it non-modifiable, but assign will just copy
	// over the value, leaving it modifiable otherwise.
	coreUtilsModule.setWidOnElement(newScript, script.__wid);

	newScript.innerHTML = script.innerHTML;

	script.parentElement.insertBefore(newScript, script);
	script.remove();

	if (executeImmediately) {
		coreUtilsModule.executeScripts(scripts, callback);
	}
};

/**
 * Removes characters that are illegal in attributes and tag names.
 * @param  {string} tagName Unsanitized string.
 * @return {string}         Sanitized string.
 * @public
 */
coreUtilsModule.sanitizeString = (string) => {
	// See https://www.w3.org/TR/html5/syntax.html#syntax-tag-name and
	// https://www.w3.org/TR/html5/syntax.html#syntax-attribute-name
	var NAME_START_CHAR_REGEX = /\:|[A-Z]|\_|[a-z]/;
	var NAME_CHAR_REGEX = /\-|\.|[0-9]/;

	return string.split('').map(function(char, index) {
		if (NAME_START_CHAR_REGEX.test(char) || (index > 0 && NAME_CHAR_REGEX.test(char))) {
			return char;
		}
		return '_';
	}).join('');
};

const widMap = new Map();
/**
 * Add a wid to a node and make it (easily) non-modifiable.
 * @param  {DOMNode} node Node to set wid on.
 * @param  {string} wid  wid.
 * @public
 */
coreUtilsModule.setWidOnElement = (node, wid) => {
	widMap.set(wid, node);
	Object.defineProperty(node, '__wid', {
		value: wid,
		writable: false, // No overwriting
		enumerable: true, // Let iterators and Object.assign see the wid.
		configurable: true // Allow us to redefine it in rare race condition scenarios.
	});
};

coreUtilsModule.getElementByWid = (wid) => {
	return widMap.get(wid);
};

module.exports = coreUtilsModule;