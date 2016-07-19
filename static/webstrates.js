var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";

	/**
	 * Webstrate constructor. Creates a webstrate instance.
	 * @param {WebSocket} websocket   WebSocket for ShareDB to use for transmitting operations.
	 * @param {string} webstrateId    Name of ShareDB document.
	 * @param {DOMNode} targetElement Element that the current webstrate should bind to.
	 * @constructor
	 */
	var Webstrate = function(websocket, webstrateId, targetElement) {
		var module = {};

		module.webstrateId = webstrateId;

		var COLLECTION_NAME = "webstrates";

		var observer, sdbDoc, rootElement, pathTree;
		var observerOptions = {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
			attributeOldValue: true,
			characterDataOldValue: true
		};

		// Whether the webstrate has been loaded or transcluded yet. Used for immediately triggering on
		// loaded/transcluded events if the action has already occurred.
		var loaded = false;
		var transcluded = false;

		// Lists containing callbacks for events that the user may subscribe to.
		var callbackLists = {
			loaded: [],      // Callbacks triggered when the document has been loaded.
			transcluded: [], // Callbacks triggered when the document has been transcluded.
			clientJoin: [],  // Callbacks triggered when a client connects to the webstrate.
			clientPart: []   // Callbacks triggered when a client disconnects from the webstrate.
		};

		// Setup event listeners for events coming both from ourselves, but also anything coming
		// from a transcluded webstrate. Note that these are being added before we override
		// addEventListener. If it had been after, we should have used __addEventListener to circumvent
		// the deprecation warning.
		document.addEventListener("loaded", function(event) {
			triggerCallbacks(callbackLists.loaded,
				event.detail.webstrateId, event.detail.clientId);
		});

		document.addEventListener("transcluded", function(event) {
			triggerCallbacks(callbackLists.transcluded,
				event.detail.webstrateId, event.detail.clientId);
		});

		// Element webstrates should work on - uses document as default.
		var targetElement = targetElement || document;

		// Hand WebSocket connection to ShareDB.
		var conn = new sharedb.Connection(websocket);

		var sdbConnectHandler = websocket.onopen;
		websocket.onopen = function(event) {
			sdbConnectHandler(event);
		}

		// We want to use ShareDB's websocket connection for emitting our own events, specifically
		// events for when clients join and leave the webstrate. ShareDB attaches itself as listener on
		// the websocket, but we need to intercept the messages and filter out our own first. So we save
		// ShareDB's on-message handler, attach our own, and then forward messages that aren't for us to
		// ShareDB.
		var sdbMessageHandler = websocket.onmessage;
		websocket.onmessage = function(event) {
			var data = JSON.parse(event.data);
			if (!data.wa) {
				sdbMessageHandler(event);
				return;
			}

			// The websocket may be used for other webstrates. We want to make sure that the message is
			// intended for this particular webstrate by verifying that the message was addressed to the
			// current collection (c) and webstrate document (d).
			if (data.c !== COLLECTION_NAME || data.d !== webstrateId) {
				return;
			}

			switch (data.wa) {
				case "hello":
					module.clientId = data.id;
					module.clients = data.clients;
					module.clients.push(data.id);
					break;
				case "clientJoin":
					module.clients.push(data.id);
					triggerCallbacks(callbackLists.clientJoin, data.id);
					break;
				case "clientPart":
					module.clients.splice(module.clients.indexOf(data.id), 1);
					triggerCallbacks(callbackLists.clientPart, data.id);
					break;
				default:
					console.warn("Unknown event", data);
			}
		};

		// Get ShareDB document for ID webstrateId.
		sdbDoc = conn.get(COLLECTION_NAME, webstrateId);

		// Subscribe to remote operations (changes to the ShareDB document).
		sdbDoc.subscribe(function(error) {
			if (error) {
				throw error;
			}
			populateElementWithDocument(webstrateId, sdbDoc, targetElement);
			rootElement = targetElement.children[0];
			pathTree = new webstrates.PathTree(rootElement, null, true);
			setupMutationObserver(sdbDoc, rootElement, function afterMutationCallback() {
				pathTree.check();
			});
			setupOpListener(sdbDoc, rootElement);
			notifyListeners(webstrateId);
		});

		/**
		 * Populates an element with a document. Empties the element before populating it. If the
		 * document is empty, the element is instead populated with a basic template.
		 * @param {string} webstrateId    Name of webstrate.
		 * @param {ShareDBDocument} doc  ShareDB document to use for population.
		 * @param {DOMNode} targetElement Element to be populated.
		 * @private
		 */
		var populateElementWithDocument = function(webstrateId, doc, targetElement) {
			// Empty the document, so we can use it.
			while (targetElement.firstChild) {
				targetElement.removeChild(targetElement.firstChild);
			}

			// A typeless document is not a document at all. Let's create one.
			if (!doc.type || doc.data.length === 0) {
				if (!doc.type) {
					console.log(`Creating new sharedb document: "${webstrateId}".`);
					doc.create('json0');
				} else {
					console.log("Document exists, but was empty. Recreating basic document.");
				}

				// TODO: is causing issues: https://github.com/cklokmose/Webstrates/issues/3
				var op = targetElement.parentNode
						? [{ "p": [], "oi": [ "div", { id: "doc_" + webstrateId, "class": "document" }]}]
						: [{ "p": [], "oi": [ "html", {}, [ "body", {} ]]}];
				doc.submitOp(op);
			}

			// All documents are persisted as JsonML, so we only know how to work with JSON documents.
			if (doc.type.name !== 'json0') {
				throw `Unsupported document type: ${sjsDocument.type.name}`;
			}
			targetElement.appendChild(jqml(doc.data));
		};

		/**
		 * Add callbacks to a callback list or execute immediately if event has already occured.
		 * @param {string}   event          Event name (loaded, transcluded, clientJoin, clientPart).
		 * @param {Function} callback       Function to be called when event occurs.
		 * @param {object}   callbackLists  Object containing callback lists for different events.
		 * @param {window}   context        Window object housing the webstrate object.
		 * @private
		 */
		var addCallbackToEvent = function(event, callback, callbackLists, context) {
			if (!callbackLists[event]) {
				console.error("On-event '" + event + "' does not exist");
				return;
			}
			if (context.webstrate) {
				if ((event === "loaded" && context.webstrate.loaded) ||
					(event === "transcluded" && context.webstrate.transcluded)) {
					callback();
					return;
				}
			}
			callbackLists[event].push(callback);
		}


		/**
		 * Notify potential parent windows (if we are loaded in an iframe) that we have finished
		 * loading a specific webstrate.
		 * @param {string} webstrateId Name of webstrate.
		 * @private
		 */
		var notifyListeners = function(webstrateId) {
			// Redispatch DOMContentLoaded.
			// This can cause infinite recursive calls. Bad.
			/*var contentLoadedEvent = document.createEvent("Event");
			contentLoadedEvent.initEvent("DOMContentLoaded", true, true);
			document.dispatchEvent(contentLoadedEvent);*/

			// Trigger a loaded event on the document.
			document.dispatchEvent(new CustomEvent("loaded", {
				detail: {
					webstrateId: webstrateId,
					clientId: module.clientId
				}
			}));

			// If the parent window is this window, we are not contained in an iframe, so we return.
			if (window === window.parent) {
				return;
			}

			// If we are in an iframe and the referrer domain and domain does not match, we assume the
			// parent frame is from a different domain and we return to not violate cross-domain
			// restrictions on iframes.
			var referrerDomain = (function() {
				var a = document.createElement("a");
				a.href = document.referrer;
				return a.host;
			})();
			var ownDomain = location.host;
			if (referrerDomain !== ownDomain) {
				return;
			}

			// If webstrate is transcluded in an iframe, raise an event on the frame element in the
			// parent document.
			if (window.frameElement) {
				webstrate.transcluded = true;
				window.frameElement.dispatchEvent(new CustomEvent("transcluded", {
					detail: {
						webstrateId: webstrateId,
						clientId: module.clientId
					},
					bubbles: true,
					cancelable: true
				}));
			}
		};

		/**
		 * Sets up mutation observer on element to generate ops and submit them on a document.
		 * @param  {ShareDBDocument} doc           Document to submit operations on.
		 * @param  {DOMElement} rootElement         Element to listen for mutations on.
		 * @param  {Callback} afterMutationCallback Function to be called after each op had applied.
		 * @return {MutationObserver}               Created observer.
		 * @private
		 */
		var setupMutationObserver = function(doc, rootElement, afterMutationCallback) {
			observer = new MutationObserver(function MutationObserverLoop(mutations) {
				mutations.forEach(function forEachMutation(mutation) {
					var op = webstrates.createOp(mutation, doc);
					// In rare cases, what happens doesn't amount to an operation, so we ignore it. See the
					// CreateOp module for details.
					if (!op) {
						return;
					}
					try {
						doc.submitOp(op);
					} catch (error) {
						// window.alert("Webstrates has encountered an error. Please reload the page.");
						throw error;
					}
				});
				afterMutationCallback();
			});

			observer.observe(rootElement, observerOptions);
		};

		/**
		 * Sets up listener for operations on a document.
		 * @param  {ShareDBDocument} doc      Document to listen for operations on.
		 * @param  {DOMElement} rootElement    Element to listen for mutations on.
		 * @private
		 */
		var setupOpListener = function(doc, rootElement) {
			doc.on('op', function onOp(ops, source) {
				// If source is truthy, it is our own op, which should not be applied (again).
				if (source) {
					return;
				}

				observer.disconnect();
				ops.forEach(function forEachOp(op) {
					webstrates.applyOp(op, rootElement);
				});
				observer.observe(rootElement, observerOptions);
			});
		};

		/**
		 * Runs all callbacks in a list.
		 * @param {CallbackList} callbackList List of callbacks to be run.
		 * @param {array}        parameters   List of parameters to be given to the callbacks.
		 * @private
		 */
		var triggerCallbacks = function(callbackList) {
			// We should use function(callbackList, ...parameters), but Safari will have none of that.
			var parameters = Array.from(arguments).slice(1);
			callbackList.forEach(function(callback) {
				callback(...parameters);
			})
		};

		/**
		 * Attach a webstrate object (with an `on` event attacher) to a Node. The `on` event attacher
		 * has different hooks, depending on the type of node.
		 * @param  {Node} node Node to work on.
		 * @return {Node}      Modified node.
		 * @private
		 */
		var attachWebstrateObjectToNode = function(node) {
			var callbackLists = {};
			node.webstrate = {};

			node.webstrate.on = function(event, callback) {
				addCallbackToEvent(event, callback, callbackLists, window);
			};

			if (node.nodeType === Node.TEXT_NODE) {
				callbackLists.insertText = [];
				callbackLists.deleteText = [];

				// If we are working with a text node, we want to be able to trigger insertText and
				// deleteText events ourselves, so we expose a fireEvent method.
				node.webstrate.fireEvent = function(event, ...parameters) {
					triggerCallbacks(callbackLists[event], ...parameters);
				};

				return node;
			}

			if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "iframe") {
				callbackLists.transcluded = [];

				// We need to sent transcluded events on the iframes, so we listen to all transcluded
				// events on the DOM, see if it's for this iframe, and if so dispatches it on the DOM
				// element.
				module.on("transcluded", function(webstrateId, clientId) {
					// If `contentWindow` isn't set on this iframe, this can't be the iframe that has just
					// been transcluded.
					if (!node.contentWindow) {
						return;
					}

					var webstrate = node.contentWindow.webstrate;
					// `webstrate` may not be set if what we transclude is just a regular iframe, not an
					// iframe with webstrates running in it.
					if (webstrate && webstrate.clientId === clientId &&
						webstrate.webstrateId === webstrateId) {
						triggerCallbacks(callbackLists.transcluded, webstrateId, clientId);
					}
				});

				return node;
			}

			// If the node is neither an iframe, nor a text node, we don't do anything more.
			return node;
		}

		/**
		 * Override document.createElement, document.createElementNS and document.createTextNode. These
		 * are being overriden, so we can intercept every creation of nodes to attach a webstrates
		 * objects.
		 */
		document.__createElement = document.createElement;
		document.createElement = function(tagName) {
			var elementNode = document.__createElement(tagName);
			attachWebstrateObjectToNode(elementNode);
			return elementNode;
		};

		document.__createElementNS = document.createElementNS;
		document.createElementNS = function(namespaceURI, tagName) {
			var elementNode = document.__createElementNS(namespaceURI, tagName);
			attachWebstrateObjectToNode(elementNode);
			return elementNode;
		};

		document.__createTextNode = document.createTextNode;
		document.createTextNode = function(data) {
			var textNode = document.__createTextNode(data);
			attachWebstrateObjectToNode(textNode);
			return textNode;
		};

		/**
		 * Override addEventListener to show warnings when using it to listen for Webstrates events,
		 * because this has been deprecated. Users should instead use DOMNode.on(...).
		 */
		Node.prototype.__addEventListener = Node.prototype.addEventListener;
		Node.prototype.addEventListener = function() {
			var parameters = Array.from(arguments);
			if (["loaded", "transcluded", "insertText", "deleteText"].indexOf(parameters[0]) !== -1) {
				console.warn("The use of native event listeners has been deprecated. Please use " +
					"DOMNode.on('" + parameters[0] + "', fn) instead.", new Error().stack.substring(5));
			}
			this.__addEventListener(...parameters);
		};

		/**
		 * Terminates the instantiated webstrate.
		 * @public
		 */
		module.destroy = function() {
			// We may be destroying our document before the observer has even been created.
			if (observer) {
				observer.disconnect();
			}
			sdbDoc.unsubscribe(function() {
				sdbDoc.destroy();
				sdbDoc.connection.close();
			});
		};

		/**
		 * Add callbacks to a the webstrate's callback list or execute immediately if event has already
		 * occured.
		 * @param {string}   event          Event name (loaded, transcluded, clientJoin, clientPart).
		 * @param {Function} callback       Function to be called when event occurs.
		 * @public
		 */
		module.on = function(event, callback) {
			return addCallbackToEvent(event, callback, callbackLists, window);
		};

		/**
		 * Exposes an object with references to objects useful for testing.
		 * @return {object} Object
		 * @public
		 */
		module.debug = function() {
			return { observer, sdbDoc, rootElement, pathTree }
		};

		return module;
	};

	webstrates.Webstrate = Webstrate;

	return webstrates;

})(root.webstrates || {});