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

		var fragmentObservers = {};
		var fragmentParentMap = {};
		var observer, doc, rootElement, pathTree;
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

		//////////////////////////////////////////////////////////////
		// BEGIN keepAlive Handling
		//////////////////////////////////////////////////////////////

		var keepAliveMessage = JSON.stringify({
			type: 'alive'
		});

		var keepAliveInterval;

		var enableKeepAlive = function() {
			// Make sure to disable any previous keep alive interval.
			disableKeepAlive();

			keepAliveInterval = setInterval(function() {
				websocket.send(keepAliveMessage);
			}, 10000);
		}

		var disableKeepAlive = function() {
			if (keepAliveInterval) {
				clearInterval(keepAliveInterval);
				keepAliveInterval = null;
			}
		}

		var sdbOpenHandler = websocket.onopen;
		websocket.onopen = function(event) {
			sdbOpenHandler(event);
			enableKeepAlive();
		}

		var sdbCloseHandler = websocket.onclose;
		websocket.onclose = function(event) {
			sdbCloseHandler(event);
			disableKeepAlive();
		}

		var sdbErrorHandler = websocket.onerror;
		websocket.onerror = function(event) {
			sdbErrorHandler(event);
			disableKeepAlive();
		}

		//////////////////////////////////////////////////////////////
		// END keepAlive Handling
		//////////////////////////////////////////////////////////////

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
		doc = conn.get(COLLECTION_NAME, webstrateId);

		// Subscribe to remote operations (changes to the ShareDB document).
		doc.subscribe(function(error) {
			if (error) {
				throw error;
			}
			populateElementWithDocument(webstrateId, doc, targetElement);
			rootElement = targetElement.children[0];
			pathTree = new webstrates.PathTree(rootElement, null, true);
			setupMutationObservers(doc, rootElement, function afterMutationCallback() {
				pathTree.check();
			});
			setupOpListener(doc, rootElement, pathTree);
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
		};

		var removeCallbackFromEvent = function(event, callback, callbackLists) {
			if (!callbackLists[event]) {
				console.error("On-event '" + event + "' does not exist");
				return;
			}

			var callbackIdx = callbackLists[event].indexOf(callback);
			if (callbackIdx !== -1) {
				callbackLists[event].splice(callbackIdx, 1);
			}
		};

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
		 * Also sets up mutation observers on existing and future documentFragments created.
		 * @param  {ShareDBDocument} doc           Document to submit operations on.
		 * @param  {DOMElement} rootElement         Element to listen for mutations on.
		 * @param  {Callback} afterMutationCallback Function to be called after each op had applied.
		 * @return {MutationObserver}               Created observer.
		 * @private
		 */
		var setupMutationObservers = function(doc, rootElement, afterMutationCallback) {

			/**
			 * Set ups a Mutation Observer on a Document Fragment.
			 * @param {DocumentFragment} fragment Fragment to observe.
			 * @param {DOMElement} element        Element containing fragment.
			 * @private
			 */
			var setupFragmentObserver = function(fragment, element) {
				if (fragment.id) {
					return;
				}
				fragment.id = Math.random().toString(36).substr(2, 8);
				var fragmentObserver = new MutationObserver(mutationToOps);
				fragmentObserver.observe(fragment, observerOptions);
				fragmentObservers[fragment.id] = [fragment, fragmentObserver];
				fragmentParentMap[fragment.id] = element;
			};

			/**
			 * Removes a Mutation Observer from a Document Fragment.
			 * @param {DocumentFragment} fragment Fragment to remove observer from.
			 * @private
			 */
			var teardownFragmentObserver = function(fragment) {
				if (!fragment.id || !fragmentParentMap[fragment.id]) {
					return;
				}
				var [fragment, fragmentObserver] = fragmentObservers[fragment.id];
				fragmentObserver.disconnect();
				delete fragmentObservers[fragment.id];
				delete fragmentParentMap[fragment.id];
			};

			/**
			 * Loops over mutations, creates and sends ops.
			 * @param {List of MutationRecords} mutations List of mutations.
			 * @private
			 */
			var mutationToOps = function(mutations) {
				mutations.forEach(function forEachMutation(mutation) {
					var ops = webstrates.createOps(mutation, doc, fragmentParentMap);
					// In rare cases, what happens doesn't amount to an operation, so we ignore it. See the
					// CreateOps module for details.
					if (!ops || ops.length === 0) {
						return;
					}

					try {
						doc.submitOp(ops);
					} catch (error) {
						// window.alert("Webstrates has encountered an error. Please reload the page.");
						console.error(ops, error, error.stack);
					}
				});
				afterMutationCallback();
			};

			/**
			 * Recursively traverses a DOM Node and sets up additional `mutationToOps` Mutation
			 * Observers on Document Fragments, as well as adding webstrate objects to all nodes.
			 * @param {DOMNode} element Node to traverse.
			 * @private
			 */
			var maintainElement = function(element) {
				// We want to add a webstrate object to every element to make it possible to attach
				// `on` event listeners.
				attachWebstrateObjectToNode(element);

				// The global mutation observer does not observe on changes to documentFragments
				// within the document, so we have to create and manage individual observers for
				// each documentFragment manually.
				if (element.content && element.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
					setupFragmentObserver(element.content, element);
				}
			};

			/**
			 * Continuously runs `maintainElement` on all newly created elements, as well as removing
			 * mutation observer on Document Fragments that no longer exist.
			 */
			var documentMaintainer = function(mutations) {
				mutations.forEach(function forEachMutation(mutation) {
					if (mutation.type === "childList") {
						Array.from(mutation.addedNodes).forEach(function(addedNode) {
							webstrates.util.recursiveForEach(addedNode, maintainElement);
						});
						Array.from(mutation.removedNodes).forEach(function(removedNode) {
							webstrates.util.recursiveForEach(removedNode, function(element) {
								if (element.content &&
									element.content.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
									teardownFragmentObserver(element.content);
								}
							});
						});
					}
				});
			};

			// Set up `mutationToOps` mutation observer.
			observer = new MutationObserver(mutationToOps);
			observer.observe(rootElement, observerOptions);

			// Set up `documentMaintainer` mutation observer.
			var maintainerObserver = new MutationObserver(documentMaintainer);
			maintainerObserver.observe(rootElement, observerOptions);
			// And run the maintainer on the just-initialized document.
			webstrates.util.recursiveForEach(rootElement, maintainElement);
		};

		/**
		 * Sets up listener for operations on a document.
		 * @param  {ShareDBDocument} doc      Document to listen for operations on.
		 * @param  {DOMElement} rootElement    Element to listen for mutations on.
		 * @private
		 */
		var setupOpListener = function(doc, rootElement, pathTree) {
			doc.on('op', function onOp(ops, source) {
				// If source is truthy, it is our own op, which should not be applied (again).
				if (source) {
					return;
				}

				// We disable the mutation observers before applying the operations. Otherwise, applying the
				// operations would cause new mutations to be created, which in turn would cause the
				// creation of new operations, leading to a livelock for all clients.
				Object.keys(fragmentObservers).forEach(function(fragmentId) {
					var [fragment, fragmentObserver] = fragmentObservers[fragmentId];
					fragmentObserver.disconnect();
				});
				observer.disconnect();

				// Apply operations to document.
				ops.forEach(function forEachOp(op) {
					webstrates.applyOp(op, rootElement);
				});
				pathTree.check();

				// And reenable MuationObservers.
				Object.keys(fragmentObservers).forEach(function(fragmentId) {
					var [fragment, fragmentObserver] = fragmentObservers[fragmentId];
					fragmentObserver.observe(fragment, observerOptions);
				});
				observer.observe(rootElement, observerOptions);
			});
		};

		doc.on('del', function onDelete(data) {
			module.destroy();
			alert("Document has been deleted.");
			window.location = "/";
		});

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
			var callbackLists = {
				insertText: [],
				deleteText: []
			};
			node.webstrate = {};

			// Make it possible to registers event listeners on events defined in callbackLists.
			node.webstrate.on = function(event, callback) {
				addCallbackToEvent(event, callback, callbackLists, window);
			};

			// Make it possible to unregister event listeners.
			node.webstrate.off = function(event, callback) {
				removeCallbackFromEvent(event, callback, callbackLists);
			};

			// Make it possible to trigger insertText and deleteText events on text nodes and attributes.
			node.webstrate.fireEvent = function(event, ...parameters) {
				triggerCallbacks(callbackLists[event], ...parameters);
			};

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
			Object.keys(fragmentObservers).forEach(function(fragmentId) {
				var [fragment, fragmentObserver] = fragmentObservers[fragmentId];
				fragmentObserver.disconnect();
			});
			// We may be destroying our document before the observer has even been created.
			if (observer) {
				observer.disconnect();
			}
			doc.unsubscribe(function() {
				doc.destroy();
				doc.connection.close();
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

		module.off = function(event, callback) {
			return removeCallbackFromEvent(event, callback, callbackLists);
		}

		/**
		 * Exposes document version through getter.
		 * @return {Number} Document version
		 * @public
		 */
		Object.defineProperty(module, "version", {
			get: function getVersion() {
				return doc.version;
			}
		});

		/**
		 * Exposes an object with references to objects useful for testing.
		 * @return {object} Object
		 * @public
		 */
		module.debug = function() {
			return { observer, doc, rootElement, pathTree }
		};

		return module;
	};

	webstrates.Webstrate = Webstrate;

	return webstrates;

})(root.webstrates || {});