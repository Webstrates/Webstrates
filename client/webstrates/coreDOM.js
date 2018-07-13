'use strict';
/**
 * This modules allows other modules a more convenient way of overriding certain document
 * properties, specifically by preventing accidental infinite recursive calls and scope-binding
 * issues. On top of that, it allows modules  to override certain properties only internally, i.e.
 * so other modules will use some overriden property (e.g. document.createElement), while code
 * written in userland still will use the "regular" document.createElement.
 *
 * This module was particularly written to be used with protected mode, so elements created by
 * other modules automatically will be pre-approved while elements created in userland will not.
 */

// Directives to ESLint, so it'll allow us to use documentProxyObj and _document, which appears to
// be undefined, as they rather unorthodoxly is defined in wrapper-header.js. Also prevent ESLint
// from complaining that documentProxyObj is never used.
/* global _document documentProxyObj */
/* exported documentProxyObj */

const coreDOMModule = {};

// This object should be passed in as the last parameter by all other modules to Element
// prototype methods, so all modules can detect when a call to one of these comes from another
// module rather than from userland. It would be better to override the Element object like we
// override the document object, but it seems to be impossible to do this meaningfully.
coreDOMModule.elementOptions = {};

coreDOMModule.internalDocument = document;
coreDOMModule.externalDocument = _document;

const contexts = {
	INTERNAL: 0,
	BOTH: 1
};

coreDOMModule.CONTEXT = new Proxy(contexts, {
	get: (target, name) => {
		if (name in target) return target[name];
		throw new Error(`Invalid context ${name}, must be INTERNAL or BOTH`);
	}
});

const internalDocumentOverrides = new Map();


/**
 * Override a property on the document object, either internally or internally and externally.
 * @param  {string} property Name of property to override on document.
 * @param  {enum} context    Context, either CONTEXT.INTERNAL or CONTEXT.BOTH.
 * @param  {any} value       Any value.
 * @public
 */
coreDOMModule.overrideDocument = (property, context, value) => {
	// If the user is trying to override a property on the internal document, we save the property to
	// a map, so we can find it when it's being requested on the proxy document. If we did a
	// 'primitive' override on the document object, the override would also be active
	if (context === coreDOMModule.CONTEXT.INTERNAL) {
		if (internalDocumentOverrides.has(property))
			throw new Error('Property has already been overriden');

		return internalDocumentOverrides.set(property, value);
	}

	if (context === coreDOMModule.CONTEXT.BOTH) {
		if (typeof value === 'function') {
			// If the requested value is a function, bind the document's context to it and bind the
			// original function as the first argument. This, for instance, allows somebody to override
			// document.createElement and still have access to the original createElement function from
			// within the new implementation.
			const originalProperty = coreDOMModule.externalDocument[property]
				.bind(coreDOMModule.externalDocument);
			coreDOMModule.externalDocument[property] = value.bind(coreDOMModule.externalDocument,
				originalProperty);
		} else {
			coreDOMModule.externalDocument[property] = value;
		}
		return;
	}

	throw new Error('Invalid context', context);
};

/**
 * Proxy object for document. The proxy is actually defined in wrapper-header.js using an empty
 * object (documentProxyObj), which we now override with our own get trap.
 * @param  {Object} obj  Object the property is to be accessed on. Will always be document.
 * @param  {string} prop Name of property.
 * @return {mixed}       The property's value. Can be anything.
 */
documentProxyObj.get = (obj, prop) => {
	if (prop === 'PROXY_DOCUMENT') return true;

	if (internalDocumentOverrides.has(prop)) {
		// If the requested value is a function, bind the document's context to it and bind the
		// original function as the first argument. This, for instance, allows somebody to override
		// document.createElement and still have access to the original createElement function from
		// within the new implementation.
		return typeof internalDocumentOverrides.get(prop) === 'function'
			? internalDocumentOverrides.get(prop).bind(obj, coreDOMModule.externalDocument[prop])
			: internalDocumentOverrides.get(prop);
	}

	// If the requested value is a function, bind the document's context to it.
	return typeof obj[prop] === 'function'
		? obj[prop].bind(obj)
		: obj[prop];
};

module.exports = coreDOMModule;