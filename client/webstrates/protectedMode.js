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
const globalObject = require('./globalObject');

const protectedModeModule = {};

coreEvents.addEventListener('receivedDocument', (doc, options) => {
	const dataProtectedAttribute = doc.data && doc.data[1] && doc.data[1]['data-protected'];
	const elementsProtected = ['all', 'elements', ''].includes(dataProtectedAttribute);
	const attributesProtected = ['all', 'attributes', ''].includes(dataProtectedAttribute);
	// Changes to static documents aren't persisted, so no reason to enforce any protection.
	if (options.static) return;

	// Either elements, attributes, or both are protected in this webstrate.
	const isProtected = elementsProtected || attributesProtected;

	// Define webstrate.isProtected. Returns true if elements, attributes, or the document is
	// protected and returns false otherwise.
	Object.defineProperty(globalObject.publicObject, 'isProtected', {
		get: () => isProtected,
		set: () => { throw new Error('isProtected cannot be modified.'); },
		enumerable: true
	});

	// We should only try to protect the document if the `data-protected` attribute has been set on
	// the <html> tag.
	if (!isProtected) return;

	// Warn the user that any changes made in the DOM editor in the Developer Tools will not persist.
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
	config.isTransientElement = DOMNode => _isTransientElement(DOMNode)
		// The [contenteditable] part below is a hack. There's no way to allow only certain sources
		// to write in a contenteditable field, so we have to allow everything to make it possible to
		// use contenteditable fields at all in protected mode.
		|| !(isApprovedNode(DOMNode) || DOMNode.closest('[contenteditable]'));

	// Overwrite config.isTransientAttribute to make approved attribute in APPROVAL_TYPE.ATTRIBUTE
	// transient, otherwise that attribute gets synchronized to the server
	const _isTransientAttribute = config.isTransientAttribute;
	config.isTransientAttribute = (DOMNode, attributeName) =>
		!(isApprovedAttribute(DOMNode, attributeName) && !_isTransientAttribute(DOMNode,
			attributeName));

	/**
	 * Approves a node to make it perist on the server. Also, overriding innerHTML of the node to
	 * approve all descendents when set through innerHTML.
	 * 
	 * @param {Node} node An object eventually having a property approved set to true.
	 */
	const approveNode = node => {

		// No need to reapprove node, and no need to override innerHTML again.
		if (node.__approved) return;

		// Use defineProperty and enumerable false to disallow overriding it and
		// hide it during enumeration.
		Object.defineProperty(node, '__approved', {
			get: () => { return true; },
			enumerable: false
		});

		// overriding the innerHTML property of the node to approve its children when
		// innerHTML is used
		if (node.nodeType === Node.ELEMENT_NODE) {
			const innerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');

			Object.defineProperty(node, 'innerHTML', {
				set: value => {
					const returnValue = innerHTMLDescriptor.set.call(node, value);

					// Approve all children and their attributes.
					// Combine approveNode and approveElementAttribute to avoid performing the
					// recursiveForEach twice.
					coreUtils.recursiveForEach(node, (childNode) => {
						approveNode(childNode);

						// Only an Element has attributes.
						if (childNode.nodeType === Node.ELEMENT_NODE) {
							Array.from(childNode.attributes).forEach(attr => {
								approveElementAttribute(childNode, attr.name);
							});
						}
					});

					return returnValue;
				},
				get: () => innerHTMLDescriptor.get.call(node),
				configurable: true
			});
		}
	};

	/**
	 * Approve an element's attribute to make it persist on the server.
	 * 
	 * @param {Element} element An element.
	 * @param {string} attrName Attribute name that will be approved.
	 */
	const approveElementAttribute = (element, attrName) => {
		if (!element.__approvedAttributes) {
			const approvedAttributes = new Set();

			// Use defineProperty and enumerable false to disallow overriding it and
			// hide it during enumeration.
			Object.defineProperty(element, '__approvedAttributes', {
				get: () => { return approvedAttributes; },
				enumerable: false
			});
		}

		if (!element.__approvedAttributes.has(attrName)) {
			element.__approvedAttributes.add(attrName);
		}
	};

	/**
	 * Removes an attribute from the list of approved attributes making it transient.
	 * 
	 * @param {Element} element An element. 
	 * @param {String} attrName Attribute name that will be removed from list of approved attribute
	 * names.
	 */
	const removeApproveElementAttribute = (element, attrName) => {
		if (!element.__approvedAttributes) {
			return;
		}

		element.__approvedAttributes.delete(attrName);
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
			if (options && options.approved) {
				approveNode(childNode);
				if (childNode.nodeType === Node.ELEMENT_NODE) {
					Array.from(childNode.attributes).forEach(attr => {
						approveElementAttribute(childNode, attr.name);
					});
				}
			}
			else childNode.nodeType === document.ELEMENT_NODE && childNode.setAttribute('unapproved', '');
		});
		return element;
	});

	// The elementOptions object should get passed into all prototype function calls (e.g.
	// Element.setAttribute) made by other modules. This allows us to inject a setting on the
	// object, so we can make all calls from other modules pre-approved.
	coreDOM.elementOptions.approved = true;

	const cloneNode = Node.prototype.cloneNode;
	Node.prototype.cloneNode = function (deep, options, ...unused) {
		const node = cloneNode.call(this, deep, ...unused);
		delete node.approved;
		if (options && options.approved) approveNode(node);
		return node;
	};

	const setAttributeNS = Element.prototype.setAttributeNS;
	Element.prototype.setAttributeNS = function (namespace, name, value, options, ...unused) {
		if (options && options.approved) approveElementAttribute(this, name);
		setAttributeNS.call(this, namespace, name, value, options, ...unused);
	};

	const setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name, value, options, ...unused) {
		// Approve any attribute set on an approved element by checking 'this.__approved'.
		// Although, third-party libraries can still get their attributes approved by this loose
		// check, it will still protect browser extensions from spamming DOM elements with attributes.
		if (this.__approved || (options && options.approved)) approveElementAttribute(this, name);
		setAttribute.call(this, name, value, options, ...unused);
	};

	const removeAttribute = Element.prototype.removeAttribute;
	Element.prototype.removeAttribute = function (name, options, ...unused) {
		removeAttribute.call(this, name, options, ...unused);
		if (options && options.approved) removeApproveElementAttribute(this, name);
	};

	// Proxy all configurable properties with a set function to intercept calls to properties
	// and approve their corresponding element attributes.
	const proxyDescriptors = (prototype, properties) => {
		properties.forEach(propertyName => {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
			// Check if descriptor is configurable and has a set function already
			if (descriptor.configurable && typeof descriptor.set === 'function') {
				Object.defineProperty(prototype, propertyName, {
					configurable: descriptor.configurable,
					enumerable: descriptor.enumerable,
					set: function (value) {
						// The approved attributes need to be lower-case in order to be approved
						// properly in the isTransientAttribute check.
						if (this.__approved) approveElementAttribute(this, propertyName.toLowerCase());
						return descriptor.set.call(this, value);
					},
					get: descriptor.get
				});
			}
		});
	};

	// Proxy Element.prototype and HTMLElement.prototype to approve attribute, e.g.,
	// Element.prototype.id -> 'id' or HTMLElement.prototype.contentEditable -> 'contenteditable'.
	proxyDescriptors(Element.prototype, ['id']);
	proxyDescriptors(HTMLElement.prototype, ['accessKey', 'contentEditable', 'dir', 'draggable',
		'hidden', 'lang', 'tabIndex', 'title', 'translate']);

	// Convert Strings from camelCase to kebab-case.
	const camelToKebab = (input) => {
		return input.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
	};

	/**
	 * Applies function hook when the target object returns a function for the property name, and
	 * a hook was defined for the property name. It will return the target's default value if no
	 * hook was defined or the returned value is not a function.
	 * 
	 * @param {*} element The element associated with the property calls.
	 * @param {*} target The proxied object.
	 * @param {*} propName The property name.
	 */
	const applyHookWhenPropertyIsFunction = function (element, target, propName) {
		// Apply hook only if returned value is a function
		let returnValue = target[propName];
		if (typeof returnValue === 'function') {
			const hook = this.functions[propName];
			if (hook) {
				const hookReturnValue = hook.call(element, returnValue, target, propName);
				if (hookReturnValue) {
					returnValue = hookReturnValue;
				}
			}
			// Bind to target, otherwise it'll throw an "TypeError: Illegal invocation"
			return returnValue.bind(target);
		}

		// Return original value when no hook was applied.
		return returnValue;
	};

	// Proxy definitions for 'classList', 'dataset', and 'style'.
	const propertiesElement = [
		{
			propertyName: 'classList',
			prototype: Element.prototype,
			get: function (element, target, propName) {
				return applyHookWhenPropertyIsFunction.call(this, element, target, propName);
			},
			functions: {
				add: function (nativeAddFunc, tokenList, propName) {
					return (...tokens) => {
						if (this.__approved) approveElementAttribute(this, 'class');
						return nativeAddFunc.call(tokenList, ...tokens);
					};
				},
				toggle: function (nativeToggleFunc, tokenList, propName) {
					return (token, force, ...unused) => {
						if (this.__approved) approveElementAttribute(this, 'class');
						return nativeToggleFunc.call(tokenList, token, force, ...unused);
					};
				},
				replace: function (nativeReplaceFunc, tokenList, propName) {
					return (oldToken, newToken, ...unused) => {
						if (this.__approved) approveElementAttribute(this, 'class');
						return nativeReplaceFunc.call(tokenList, oldToken, newToken, ...unused);
					};
				}
			}
		},
		{
			propertyName: 'dataset',
			prototype: HTMLElement.prototype,
			set: function (element, target, propName, value) {
				target[propName] = value;
				const attributeName = camelToKebab(propName);
				if (element.__approved) approveElementAttribute(element, `data-${attributeName}`);
				return true;
			}
		},
		{
			propertyName: 'style',
			prototype: HTMLElement.prototype,
			get: function (element, target, propName) {
				return applyHookWhenPropertyIsFunction.call(this, element, target, propName);
			},
			set: function (element, target, propName, value) {
				target[propName] = value;
				if (element.__approved) approveElementAttribute(element, 'style');
				return true;
			},
			functions: {
				setProperty: function (nativeSetPropertyFunc, cssStyleDeclaration, propName) {
					return (propertyName, value, priority, ...unused) => {
						if (this.__approved) approveElementAttribute(this, 'style');
						return nativeSetPropertyFunc.call(cssStyleDeclaration, propertyName, value, priority,
							...unused);
					};
				}
			}
		}
	];

	// Proxy each property defined in the properties array. A property definition looks like:
	//
	// {
	// 		// The name of the property that will get a new descriptor.
	// 		propertyName: 'classList',
	// 		// The object object or prototype that will get a new descriptor.
	// 		prototype: HTMLElement.prototype,
	// 		// This is the same as Proxy.prototype.get but with element as first parameter and 'this'
	// 		// refers the definition itself.
	// 		get: function(element, target, propName) {
	// 			return target[propName];
	// 		},
	// 		This is the same as Proxy.prototype.set but with element as first parameter and 'this'
	// 		// refers the definition itself.
	// 		set: function(element, target, propName, value) {
	// 			target[propName] = value;
	// 			return true;
	// 		}
	// }
	const proxyDescriptorsAndvanced = (propertyDefinitions) => {

		propertyDefinitions.forEach((definition) => {
			const descriptor = Object.getOwnPropertyDescriptor(definition.prototype,
				definition.propertyName);
			Object.defineProperty(definition.prototype, definition.propertyName, {
				configurable: descriptor.configurable,
				enumerable: descriptor.enumerable,
				set: function (value) {
					return descriptor.set.call(this, value);
				},
				get: function () {
					const element = this;
					const result = descriptor.get.call(element);

					// Proxy property with either get, set, or both. This means that each call
					// to a child property will be forwarded to the get or set respectively. In
					// case not get or set is defined, the default get/set behavior applies.
					if (definition.get || definition.set) {
						return new Proxy(result, {
							get: function (target, propName) {
								if (definition.get) {
									return definition.get.call(definition, element, target, propName);
								}
								return target[propName];
							},
							set: function (target, propName, value) {
								if (definition.set) {
									return definition.set.call(definition, element, target, propName, value);
								}
								target[propName] = value;
								return true;
							}
						});
					}

					return result;
				}
			});
		});
	};

	// Proxy properties like 'classList', 'dataset', and 'style'.
	proxyDescriptorsAndvanced(propertiesElement);

}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = protectedModeModule;