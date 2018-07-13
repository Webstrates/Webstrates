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

	const pathRegex = /^\/([A-Z0-9._-]+)\/(?:([A-Z0-9_-]+)\/)?/i.exec(window.location.pathname);
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
 * Creates a throttled version of a function, i.e. one that only runs at most once every N
 * milliseconds.
 * @param  {Function} fn         Source function.
 * @param  {Number}   limit      Execution delay in milliseconds.
 * @return {Function}            Throttled source function.
 * @public
 */
coreUtilsModule.throttleFn = (fn, limit) => {
	let timeout, lastCall = 0;
	return function(...args) {
		let now = Date.now();
		let delay = lastCall + limit - now;
		if (delay <= 0) {
			fn(...args);
			lastCall = now;
		} else {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				fn(...args);
				lastCall = now;
			}, delay);
		}
	};
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
coreUtilsModule.objectClone = (obj) => Array.isArray(obj) ? obj.slice(0) : Object.assign({}, obj);

/**
 * Returns a locked, shallow clone of an object.
 * @param  {obj} obj Object to lock and clone.
 * @return {obj}     Cloned object.
 * @public
 */
coreUtilsModule.objectCloneAndLock = (obj) => Object.freeze(coreUtilsModule.objectClone(obj));

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
	// This will be the case for <template> tags.
	if (parentElement.content && parentElement.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
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
 * @param {DOMNode} referenceNode Node to insert before.
 * @public
 */
coreUtilsModule.appendChildWithoutScriptExecution = (parentElement, childElement, referenceNode) =>
{
	// We just insert text nodes right away, we're only interested in doing fancy stuff with elements
	// that may have scripts as children.
	if (!(childElement instanceof HTMLElement)) {
		return parentElement.insertBefore(childElement, referenceNode || null);
	}

	// To prevent scripts from being executed when inserted, we use a little hack. Before inserting
	// the script, we replace the actual script with dummy content, causing that to be executed
	// instead of the actual script. If it's an inline script, we insert a script with dummy content
	// ('// Execution prevention'), and then replace the innerHTML afterwards.
	// To prevent issues with any other attributes (e.g. crossorigin and integrity), we also remove
	// all those attributes and insert them later.
	const scriptMap = new Map();
	const scripts = (childElement instanceof HTMLScriptElement) ? [ childElement ]
		: [ ...childElement.querySelectorAll('script') ];

	scripts.forEach(script => {
		const attrs = [];
		Array.from(script.attributes).forEach(attr => {
			attrs.push([ attr.nodeName, attr.nodeValue ]);
			script.removeAttribute(attr.nodeName);
		});
		const text = script.innerHTML;
		script.innerHTML = '// Execution prevention';
		scriptMap.set(script, [ attrs, text ]);
	});

	parentElement.insertBefore(childElement, referenceNode || null);

	scripts.forEach(script => {
		const [ attrs, text ] = scriptMap.get(script);
		attrs.forEach(attr => {
			const [nodeName, nodeValue] = attr;
			script.setAttribute(nodeName, nodeValue);
		});
		script.innerHTML = text;
	});
};

/**
 * Reinsert and execute an array of scripts in order.
 * @param {array}    scripts  Array of script DOM elements.
 * @param {Function} callback Function to call once all scripts have been executed.
 * @public
 */
coreUtilsModule.executeScripts = (scripts, callback) => {
	const script = scripts.shift();
	if (!script) {
		return callback();
	}

	// Scripts in templates shouldn't get executed. If we didn't do this, we could also run into
	// issues a little later in the function when we'd attempt to reinsert the element into its
	// parent if the script is a direct child of the template, as such children don't actually have
	// parents.
	if (coreUtilsModule.elementIsTemplateDescendant(script)) {
		return coreUtilsModule.executeScripts(scripts, callback);
	}

	const executeImmediately = !script.src;
	const newScript = document.createElementNS(script.namespaceURI, 'script');
	if (!executeImmediately) {
		newScript.onload = newScript.onerror = function() {
			coreUtilsModule.executeScripts(scripts, callback);
		};
	}

	// Copy over all attribtues.
	for (let i = 0; i < script.attributes.length; i++) {
		const attr = script.attributes[i];
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
 * Check whether a DOM Node is a descendant of a template tag (or actually a documentFragment).
 * One might assume this could be done with `element.closest("template")`, but that won't be the
 * case, because a documentFragment technically isn't a parent (and also doesn't have any parent),
 * so there will be no tree to search upwards through after we reach the documentFragment.
 * @param  {DOMNode} DOMNode DOM Node to check.
 * @return {boolean}         True if the DOM Node is a descendant of a template.
 * @private
 */
coreUtilsModule.elementIsTemplateDescendant = element =>
	document.documentElement.ownerDocument !== element.ownerDocument;

/**
 * Check if the current page has been transcluded (i.e. is an iframe)
 * @return {bool} True if this frame is transcluded.
 * @public
 */
coreUtilsModule.isTranscluded = () => window.frameElement && window.parent !== window;

/**
 * Check whether the current frame shares domain with the outer frame. Only useful when called
 * when transcluded (i.e. called from an iframe). This is used to determine whether accessing the
 * outer frame will cause CORS errors.
 * @return {bool} True if current and outer frame share domain.
 * @public
 */
coreUtilsModule.sameParentDomain = () => {
	const a = document.createElement('a');
	a.href = document.referrer;
	return a.host === location.host;
};

/**
 * Removes characters that are illegal in attributes and tag names.
 * @param  {string} tagName Unsanitized string.
 * @return {string}         Sanitized string.
 * @public
 */
coreUtilsModule.sanitizeString = (string) => {
	// See https://www.w3.org/TR/html5/syntax.html#tag-name and
	// https://www.w3.org/TR/html5/syntax.html#elements-attributes
	// These regex test does not fully adhere to either, but is more stringent to avoid serialization
	// issues.
	var NAME_START_CHAR_REGEX = /:|[A-Z]|_|[a-z]/;
	var NAME_CHAR_REGEX = /-|\.|[0-9]/;

	return string.split('').map(function(char, index) {
		if (NAME_START_CHAR_REGEX.test(char) || (index > 0 && NAME_CHAR_REGEX.test(char))) {
			return char;
		}
		return '_';
	}).join('');
};

/**
 * Replaces ampersands (&) and double-quotes (") with their respective HTML entities.
 * @param  {string} value Unescaped string.
 * @return {string}       Escaped string.
 * @public
 */
coreUtilsModule.escape = value => value && value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Replaces &amp; and &quot; with their respective characters (& and ").
 * @param  {string} value Escaped string.
 * @return {string}       Unescaped string.
 * @public
 */
coreUtilsModule.unescape = value => value && value.replace(/&amp;/g, '&').replace(/&quot;/g, '"');

/**
 * Replaces "." with &dot;.
 * @param  {string} value Unescaped string.
 * @return {string}       Escaped string.
 * @public
 */
coreUtilsModule.escapeDots = value => value && value.replace(/\./g, '&dot;');

/**
 * Replaces &dot; with ".".
 * @param  {string} value Escaped string.
 * @return {string}       Unescaped string.
 * @public
 */
coreUtilsModule.unescapeDots = value => value && value.replace(/&dot;/g, '.');

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

/**
 * Remove element from wid map. Bye, bye, memory leak!
 * @param  {string} wid wid.
 * @public
 */
coreUtilsModule.removeWidFromElement = wid => widMap.delete(wid);

/**
 * Get element by wid.
 * @param  {string} wid wid.
 * @return {DOMNode}     DOM Element with given wid.
 * @public
 */
coreUtilsModule.getElementByWid = wid => widMap.get(wid);

module.exports = coreUtilsModule;