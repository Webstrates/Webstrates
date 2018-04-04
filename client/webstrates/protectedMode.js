'use strict';
/**
 * Protected mode is enabled by adding data-protected as an attribute on the body tag and reloading
 * the page. Afterwards, all attributes set and elements inserted will automatically be transient.
 * To create an element that's approved to be in the DOM (i.e. not transient), the element should
 * be created with:
 *     document.createElement(tagName, { approved: true });
 *
 * Likewise, for setting a non-transient attribute:
 *     Element.setAttribute(name, value, { approved: true });
 *
 * Elements created by other modules will automatically be approved. Attributes set by other
 * modules will also automatically be approved, as long as they pass in the mandatory
 * coreDOM.elementOptions object as the last parameter to all setAttribute/setAttributeNS calls.
 */
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreDOM = require('./coreDOM');

const protectedModeModule = {};

coreEvents.addEventListener('receivedDocument', (doc, options) => {
	const dataProtectedAttribute = doc.data && doc.data[1] && doc.data[1]['data-protected'];
	const elementsProtected = ['all', 'elements', ''].includes(dataProtectedAttribute);
	const attributesProtected = ['all', 'attributes', ''].includes(dataProtectedAttribute);
	// Changes to static documents aren't persisted, so no reason to enforce any protection. Also we
	// should only try to protect the document if the `data-protected` attribute has been set on the
	// <html> tag.
	if (options.static || (!elementsProtected && !attributesProtected)) return;

	const protectedParts = (elementsProtected && attributesProtected) ? 'the document'
		: (elementsProtected ? 'elements' : 'attributes');
	console.warn('This document is protected. Any changes made to ' + protectedParts + ' through ' +
		'the DOM editor in the Developer Tools will be perceived as transient.');

	/**
	 * Checks whether a DOMNode is allowed to be persisted (i.e. non-transient).
	 */
	const isApprovedNode = DOMNode => !elementsProtected || !!DOMNode.__approved;

	/**
	 * Checks whether an attribute is allowed to be peristed (i.e. non-transient).
	 */
	const isApprovedAttribute = (DOMNode, attributeName) => !attributesProtected
		|| (DOMNode.__approvedAttributes && DOMNode.__approvedAttributes.has(attributeName));

	// Overwrite config.isTransientElement, so nodes with the `__approved` property are transient. We
	// also pass on the call to the original isTransientElement function defined in the client config.
	const _isTransientElement = config.isTransientElement;
	config.isTransientElement = DOMNode =>
		!isApprovedNode(DOMNode) || _isTransientElement(DOMNode);

	// Overwrite config.isTransientAttribute to make approved attribute in APPROVAL_TYPE.ATTRIBUTE
	// transient, otherwise that attribute gets synchronized to the server
	const _isTransientAttribute = config.isTransientAttribute;
	config.isTransientAttribute = (DOMNode, attributeName) =>
		!(isApprovedAttribute(DOMNode, attributeName) && !_isTransientAttribute(DOMNode,
			attributeName));

	/**
	 * Checks if the options parameter is an object, if it has the approved property, and
	 * if the approved property is set to true.
	 * @param {*} options An object eventually having a property approved set to true.
	 * @returns True if the options object has a property approved and set to true.
	 */
	const approveNode = node => {
		node.__approved = true;
		// overriding the innerHTML property of the node to approve its children when
		// innerHTML is used
		if (node.nodeType === Node.ELEMENT_NODE) {
			const innerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');

			Object.defineProperty(node, 'innerHTML', {
				set: value => {
					const returnValue = innerHTMLDescriptor.set.call(node, value);
					// Approve all children.
					coreUtils.recursiveForEach(node, approveNode);
					return returnValue;
				},
				get: () => innerHTMLDescriptor.get.call(node),
				configurable: true
			});
		}
	};

	const approveNodeAttribute = (node, attrName) => {
		if (!node.__approvedAttributes) {
			node.__approvedAttributes = new Set();
		}

		if (!node.__approvedAttributes.has(attrName)) {
			node.__approvedAttributes.add(attrName);
		}
	};

	const removeApproveNodeAttribute = (node, attrName) => {
		if (!node.__approvedAttributes) {
			return;
		}

		node.__approvedAttributes.delete(attrName);
	};

	// Override some internal functions, so elements created by other modules will be pre-approved.
	coreDOM.overrideDocument('createElementNS', coreDOM.CONTEXT.INTERNAL, (createElementNS,
		namespaceURI, qualifiedName, options = {}, ...unused) => {
		options.approved = true;
		return createElementNS(namespaceURI, qualifiedName, options, ...unused);
	});

	coreDOM.overrideDocument('createElement', coreDOM.CONTEXT.INTERNAL, (createElement, tagName,
		options = {}, ...unused) => {
		options.approved = true;
		return createElement(tagName, options, ...unused);
	});

	coreDOM.overrideDocument('importNode', coreDOM.CONTEXT.INTERNAL, (importNode, externalNode, deep,
		options = {}, ...unused) => {
		options.approved = true;
		return importNode(externalNode, deep, options, ...unused);
	});

	coreDOM.overrideDocument('createElementNS', coreDOM.CONTEXT.BOTH, (createElementNS, namespaceURI,
		qualifiedName, options = {}, ...unused) => {
		const element = createElementNS(namespaceURI, qualifiedName, options, ...unused);
		if (options && options.approved) approveNode(element);
		else element.setAttribute('unapproved', '');
		return element;
	});

	coreDOM.overrideDocument('createElement', coreDOM.CONTEXT.BOTH, (createElement, tagName,
		options = {}, ...unused) => {
		const element = createElement(tagName, options, ...unused);
		if (options && options.approved) approveNode(element);
		else element.setAttribute('unapproved', '');
		return element;
	});

	coreDOM.overrideDocument('importNode', coreDOM.CONTEXT.BOTH, (importNode, externalNode, deep,
		options = {}, ...unused) => {
		const element = importNode(externalNode, deep, ...unused);
		coreUtils.recursiveForEach(element, childNode => {
			if (options && options.approved) approveNode(childNode);
			else element.setAttribute('unapproved', '');
		});
		return element;
	});

	// The elementOptions object should get passed into all prototype function calls (e.g.
	// Element.setAttribute) made by other modules. This allows us to inject a setting on the object,
	// so we can make all calls from other modules pre-approved.
	coreDOM.elementOptions.approved = true;

	const cloneNode = Node.prototype.cloneNode;
	Node.prototype.cloneNode = function(deep, options, ...unused) {
		const node = cloneNode.call(this, deep, ...unused);
		delete node.approved;
		if (options && options.approved) approveNode(node);
		return node;
	};

	const setAttributeNS = Element.prototype.setAttributeNS;
	Element.prototype.setAttributeNS = function(namespace, name, value, options, ...unused) {
		if (options && options.approved) approveNodeAttribute(this, name);
		setAttributeNS.call(this, namespace, name, value, options, ...unused);
	};

	const setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function(name, value, options, ...unused) {
		if (options && options.approved) approveNodeAttribute(this, name);
		setAttribute.call(this, name, value, options, ...unused);
	};

	const removeAttribute = Element.prototype.setAttribute;
	Element.prototype.removeAttribute = function(name, options, ...unused) {
		removeAttribute.call(this, name, options, ...unused);
		if (options && options.approved) removeApproveNodeAttribute(this, name);
	};

}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = protectedModeModule;