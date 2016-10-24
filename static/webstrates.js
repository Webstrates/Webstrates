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

		// Every webstrate object needs a unique ID. There is only one webstrate instance, so "document"
		// will do.
		module.id = "document";

		var COLLECTION_NAME = "webstrates";

		// One-to-one mapping from nodeIds to their nodes.
		var nodeIds = {};

		// Holds current tag label if it exists.
		var currentTag;

		// Holds a list of all tags.
		var allTags;

		// Holds a list of future tags in case we have received tags before our own document has been
		// synchronized to this version.
		var futureTags = {};

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

		// Lists containing callbacks for events that the user may subscribe to.
		var callbackLists = { // Callbacks are triggered when:
			loaded: [],         // the document has been loaded.
			transcluded: [],    // the document has been transcluded.
			clientJoin: [],     // a client connects to the webstrate.
			clientPart: [],     // a client disconnects from the webstrate.
			signal: [],         // a client sends a signal.
			tag: [],            // a new tag has been set.
			untag: []           // a tag has been removed.
		};

		// All elements get a Webstrate object attached after they enter the DOM. It may, however, be
		// useful to access the Webstrate object before the element has been added to the DOM.
		// Therefore, we add Webstrate objects to all elements created with document.createElement and
		// document.createElementNS immediately here.
		document.__createElementNS = document.createElementNS;
		document.createElementNS = function(namespaceURI, qualifiedName) {
			var element = document.__createElementNS(namespaceURI, qualifiedName);
			attachWebstrateObjectToNode(element);
			return element;
		};

		document.__createElement = document.createElement;
		document.createElement = function(tagName, options) {
			var element = document.__createElement(tagName, options);
			attachWebstrateObjectToNode(element);
			return element;
		};

		// Setup event listeners for events coming both from ourselves, but also anything coming
		// from a transcluded webstrate. Note that these are being added before we override
		// addEventListener. If it had been after, we should have used __addEventListener to circumvent
		// the deprecation warning.
		document.addEventListener("loaded", function(event) {
			triggerCallbacks(callbackLists.loaded,
				event.detail.webstrateId, event.detail.clientId, event.detail.user);
		});

		document.addEventListener("transcluded", function(event) {
			triggerCallbacks(callbackLists.transcluded,
				event.detail.webstrateId, event.detail.clientId, event.detail.user);
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

		// Mapping from tokens to callback functions.
		var tokenCallbackMap = {};

		/**
		 * Send message through the websocket.
		 * @param  {Object}   obj      Any object to be sent over the websocket.
		 * @param  {Function} callback Function to be called when we get a reply to the message.
		 * @private
		 */
		var websocketSend = function(msgObj, callback) {
			if (callback) {
				var token = webstrates.util.randomString();
				msgObj.token = token;
				tokenCallbackMap[token] = function(...args) {
					// Wrap the callback in another function, so the token gets deleted from the table when
					// it's being run.
					delete tokenCallbackMap[token];
					callback(...args);
				};

				// Call the callback function with a timeout error after 2 seconds if we haven't gotten a
				// reply from the server.
				setTimeout(function() {
					// If the token still exists in the map, it means the callback function hasn't been
					// removed.
					if (tokenCallbackMap[token]) {
						callback(new Error("Request timed out"));
					}
				}, 2000);

			}
			msgObj.d = msgObj.d || module.webstrateId;
			websocket.send(JSON.stringify(msgObj));
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

			if (data.token) {
				var callback = tokenCallbackMap[data.token];
				if (!callback) {
					console.error("Received callback for token that doesn't exist", data);
				} else {
					callback(data.error || null, data.reply, data.token);
				}
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
					var clientId = data.id;
					module.clientId = clientId;
					module.user = Object.keys(data.user).length > 0 ? data.user : undefined;
					module.clients = data.clients;
					module.clients.push(clientId);
					break;
				case "clientJoin":
					var clientId = data.id;
					module.clients.push(clientId);
					triggerCallbacks(callbackLists.clientJoin, clientId);
					break;
				case "clientPart":
					var clientId = clientId;
					module.clients.splice(module.clients.indexOf(clientId), 1);
					triggerCallbacks(callbackLists.clientPart, clientId);
					break;
				case "publish":
					var nodeId = data.id;
					var node = nodeIds[nodeId];
					if (!node && nodeId !== "document") {
						return;
					}
					var senderId = data.s;
					var message = data.m;
					webstrate.fireEvent("signal", message, senderId, node);
					if (node) {
						node.webstrate.fireEvent("signal", message, senderId, node);
					}
					break;
				case "tags":
					allTags = {};
					data.tags.forEach(function(tag) {
						if (tag.v === module.version) {
							currentTag = tag.label;
						}
						allTags[tag.v] = tag.label;
					});
					break;
				case "tag":
					var label = data.l;
					var version = data.v;

					// The label may already be in use, but since labels are unique, we should remove it.
					var existingVersion = Object.keys(allTags).find(function(candidateVersion) {
						return allTags[candidateVersion] === label;
					});
					if (existingVersion) {
						delete allTags[existingVersion];
					}

					allTags[version] = label;
					if (module.version === version) {
						currentTag = label;
					} else if (version > module.version) {
						futureTags[version] = label;
					}
					triggerCallbacks(callbackLists.tag, version, label);
					break;
				case "untag":
					var label = data.l;
					var version = data.v;
					if (!version && label) {
						version = Object.keys(allTags).find(function(candidateVersion) {
							return allTags[candidateVersion] === label;
						});
					}
					delete allTags[version];
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
			currentTag = allTags[doc.version];
			populateElementWithDocument(webstrateId, doc, targetElement, function documentPopulated() {
				rootElement = targetElement.childNodes[0];
				pathTree = webstrates.PathTree.create(rootElement, null, true);
				setupMutationObservers(doc, rootElement, function afterMutationCallback() {
					pathTree.check();
				});
				setupOpListener(doc, rootElement, pathTree);
				notifyListeners(webstrateId);
			});
		});

		/**
		 * Populates an element with a document. Empties the element before populating it. If the
		 * document is empty, the element is instead populated with a basic template.
		 * @param {string} webstrateId    Name of webstrate.
		 * @param {ShareDBDocument} doc  ShareDB document to use for population.
		 * @param {DOMNode} targetElement Element to be populated.
		 * @private
		 */
		var populateElementWithDocument = function(webstrateId, doc, targetElement, callback) {
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

			// In order to execute scripts synchronously, we insert them all without execution, and then
			// execute them in order afterwards.
			var scripts = [];
			webstrates.util.appendChildWithoutScriptExecution(targetElement,
				jqml(doc.data, undefined, scripts));

			webstrates.util.executeScripts(scripts, callback);
		};

		/**
		 * Add callback to a callback list or execute immediately if event has already occured.
		 * @param {string}   event          Event name (loaded, transcluded, clientJoin, clientPart).
		 * @param {Function} callback       Callback function to be registered.
		 * @param {object}   callbackLists  Object containing callback lists for different events.
		 * @param {window}   context        Window object housing the webstrate object.
		 * @param {DOMNode}  node           Related node if any (used with signaling).
		 * @private
		 */
		var addCallbackToEvent = function(event, callback, callbackLists, context, node) {
			if (!callbackLists[event]) {
				console.error("On-event '" + event + "' does not exist");
				return;
			}

			var webstrate = context.webstrate;
            if (webstrate) {
                if ((event === "loaded" && webstrate.loaded) ||
                    (event === "transcluded" && webstrate.transcluded)) {
                    callback(webstrate.webstrateId, webstrate.clientId, webstrate.user);
                }
                // Trigger transcluded event on main document webstrate object for those iframes that have
                // already been transcluded.
                else if (context === window && webstrate.loaded && event === "transcluded") {
                    var iframes = document.querySelectorAll("iframe");
                    Array.from(iframes).forEach(function(iframe) {
                        var context = iframe.contentWindow;
                        var webstrate = context.webstrate;

                        if (webstrate && webstrate.transcluded) {
                            callback(webstrate.webstrateId, webstrate.clientId, webstrate.user);
                        }
                    });
                }
            }

			// The server needs to be informed that we are now subscribed to signaling events, otherwise
			// we won't recieve the events at all.
			if (event === "signal" && callbackLists.signal.length === 0) {
				websocketSend({
					wa: "subscribe",
					d: webstrateId,
					id: (node || context).webstrate.id
				});
			}

			callbackLists[event].push(callback);
		};

		/**
		 * Remove callback from a callback list.
		 * @param {string}   event          Event name
		 * @param {Function} callback       Callback function.
		 * @param {object}   callbackLists  Object containing callback lists for different events.
		 * @param {DOMNode}  node           Related node if any (used with signaling).
		 * @private
		 */
		var removeCallbackFromEvent = function(event, callback, callbackLists, node) {
			if (!callbackLists[event]) {
				console.error("On-event '" + event + "' does not exist");
				return;
			}

			var callbackIdx = callbackLists[event].indexOf(callback);
			if (callbackIdx !== -1) {
				callbackLists[event].splice(callbackIdx, 1);
			}

			// If we're just removed the last signaling event listener, we should tell the server we
			// unsubscribed, so we no longer recieve events.
			if (event === "signal" && callbackLists.signal.length === 0) {
				websocketSend({
					wa: "unsubscribe",
					d: webstrateId,
					id: (node || context).webstrate.id
				});
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

            // Set webstrate loaded.
            webstrate.loaded = true;

			// Trigger a loaded event on the document.
			document.dispatchEvent(new CustomEvent("loaded", {
				detail: {
					webstrateId: webstrateId,
					clientId: module.clientId,
					user: module.user
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
						clientId: module.clientId,
						user: module.user
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
				fragment.id = webstrates.util.randomString();
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
				// When an op comes in, the document version changes and so does the tag. In rare cases, we
				// may have received a tag for a version we were yet to be in at the time, in which case we
				// may already know the tag of the new version, but most likely, this will set currentTag
				// to undefined.
				currentTag = futureTags[module.version];
				// Move all futureTags that are no longer "future" into allTags.
				Object.keys(futureTags).forEach(function(futureVersion) {
					if (futureVersion <= module.version) {
						allTags[futureVersion] = futureTags[futureVersion];
						delete futureTags[futureVersion];
					}
				});

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

		var jsonml = {
			TAG_NAME_INDEX: 0,
			ATTRIBUTE_INDEX: 1,
			ELEMENT_LIST_OFFSET: 2
		};

		var sendSignal = function(nodeId, msg, recipients) {
			var msgObj = {
				wa: "publish",
				d: webstrateId,
				id: nodeId,
				m: msg
			};
			if (recipients) {
				msgObj.recipients = recipients;
			}
			websocketSend(msgObj);
		};

		/**
		 * Attach a webstrate object (with an `on` event attacher) to a Node. The `on` event attacher
		 * has different hooks, depending on the type of node.
		 * @param  {Node} node Node to work on.
		 * @return {Node}      Modified node.
		 * @private
		 */
		var attachWebstrateObjectToNode = function(node) {
			// Nodes are given a webstrate object once they're added into the DOM, but elements created
			// with document.createElement() and document.createElementNS() have had webstrate objects
			// since before they were added to the DOM. Therefore, we need to make sure the current node
			// doesn't already have a webstrate object, lest we overwrite it.
			// We can't just return prematurely here, because elements that already have a Webstrate
			// object won't have a unique ID, which we will add after this block.
			if (!node.webstrate) {
				node.webstrate = {};

				var callbackLists = {
					insertText: [],
					deleteText: [],
					nodeAdded: [],
					nodeRemoved: [],
					attributeChanged: [],
					signal: []
				};

				/**
				 * Register event listeners on events defined in callbackLists.
				 * @param  {string}   event    Event name.
				 * @param  {Function} callback Callback function to be registered.
				 * @public
				 */
				node.webstrate.on = function(event, callback) {
					// Use iframe's window to trigger event when node is an actual iframe element.
					var context = node.tagName.toLowerCase() === "iframe" ? node.contentWindow : window;
					addCallbackToEvent(event, callback, callbackLists, context, node);
				};

				/**
				 * Unregister event listeners.
				 * @param {string}   event    Event name.
				 * @param {Function} callback Callback function to be unregistered.
				 * @public
				 */
				node.webstrate.off = function(event, callback) {
					removeCallbackFromEvent(event, callback, callbackLists, node);
				};

				/**
				 * Trigger events.
				 * @param {string} event      Event name.
				 * @param {...[*]} parameters Any parameters that should be passed to the callback.
				 * @public
				 */
				node.webstrate.fireEvent = function(event, ...parameters) {
					triggerCallbacks(callbackLists[event], ...parameters);
				};

				/**
				 * Signal a message on the element to all subscribers or a list of recipients.
				 * @param {*} msg            Message to be signalled.
				 * @param {array} recipients (optional) List of recipient client IDs. If no recipients are
				 *                           specified, all listening clients will receive the message.
				 * @public
				 */
				node.webstrate.signal = function(msg, recipients) {
					sendSignal(node.webstrate.id, msg, recipients);
				};

				if (node.nodeType === Node.ELEMENT_NODE) {
					// Setup callback for iframe.
					if (node.tagName.toLowerCase() === "iframe") {
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
								triggerCallbacks(callbackLists.transcluded, webstrateId, clientId, module.user);
							}
						});
					}
				}
			};

			var pathNode = webstrates.PathTree.getPathNode(node);
			// Create a unique ID for each element.
			// If the node doesn't have a path node, it either hasn't been added to the DOM yet, so we
			// can't create an op for other clients, or the element isn't being tracked by Webstrates.
			// Either way, we don't care about adding a unique ID.
			if (!node.webstrate.id && node.nodeType === Node.ELEMENT_NODE && pathNode) {
				var nodePath = pathNode.toPath();
				var jml = webstrates.util.elementAtPath(doc.data, nodePath);
				var rawAttributes = jml[jsonml.ATTRIBUTE_INDEX];
				if (typeof rawAttributes === "object") {
					if (rawAttributes.__wid) {
						node.webstrate.id = rawAttributes.__wid;
					} else {
						var __wid = webstrates.util.randomString();
						node.webstrate.id = __wid;
						doc.submitOp([{ oi: __wid, p: [...nodePath, jsonml.ATTRIBUTE_INDEX, "__wid" ]}]);
					}
					nodeIds[node.webstrate.id] = node;
				}
			}
		};

		/**
		 * Tag a document with a label at a specific version. Triggered by `webstrate.tag(label,
		 * version)`.
		 * @param  {string} label    Tag label.
		 * @param  {integer} version Version.
		 * @private
		 */
		var tagDocument = function(label, version) {
			if (/^\d/.test(label)) {
				throw new Error("Tag name should not begin with a number");
			}
			if (!version) {
				version = module.version;
			}
			if (isNaN(version)) {
				throw new Error("Version must be a number");
			}
			if (allTags[module.version] === label) return;
			allTags[module.version] = label;
			websocketSend({
				wa: "tag",
				d: webstrateId,
				v: version,
				l: label
			});
		};

		/**
		 * Remove a tag from a version of the document. Triggered by `webstrate.untag(label, version)`.
		 * @param  {integer} version Version.
		 * @private
		 */
		var untagDocument = function(tagOrVersion) {
			if (!tagOrVersion) {
				throw new Error("Tag label or version number must he provided");
			}

			var msgObj = {
				wa: "untag",
				d: webstrateId,
			};

			if (/^\d/.test(tagOrVersion)) {
				msgObj.v = tagOrVersion;
				if (!allTags[tagOrVersion]) {
					throw new Error("No tag exists for provided version");
				}
				var version = tagOrVersion;
			} else {
				msgObj.l = tagOrVersion;
				var version = Object.keys(allTags).find(function(candidateVersion) {
					return allTags[candidateVersion] === tagOrVersion;
				});
				if (!version) {
					throw new Error("Provided tag does not exist");
				}
			}

			delete allTags[version];
			websocketSend(msgObj);
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
		 * Register event listeners on events defined in callbackLists.or execute immediately if event
		 * has already occured (loaded, transcluded).
		 * @param {string}   event    Event name.
		 * @param {Function} callback Callback function to be registered.
		 * @public
		 */
		module.on = function(event, callback) {
			return addCallbackToEvent(event, callback, callbackLists, window);
		};

		/**
		 * Unregister event listeners.
		 * @param {string}   event    Event name.
		 * @param {Function} callback Callback function to be unregistered.
		 * @public
		 */
		module.off = function(event, callback) {
			return removeCallbackFromEvent(event, callback, callbackLists);
		};

		/**
		 * Trigger events
		 * @param {string} event        Event name.
		 * @param {...[*]} parameters   Any parameters that should be passed to the callback.
		 * @public
		 */
		module.fireEvent = function(event, ...parameters) {
			triggerCallbacks(callbackLists[event], ...parameters);
		};

		/**
		 * Signal a message on the element to all subscribers or a list of recipients.
		 * @param {*} msg            Message to be signalled. Can
		 * @param {array} recipients (optional) List of recipient client IDs. If no recipients are
		 *                           specified, all listening clients will recieve the mesasge.
		 * @public
		 */
		module.signal = function(msg, recipients) {
			sendSignal(module.id, msg, recipients);
		};

		/**
		 * Restore document to a previous version, either by version number or tag label.
		 * Labels cannot begin with a digit whereas versions consist only of digits, so distinguishing
		 * is easy.
		 * @param  {string} tagOrVersion Tag label or version number.
		 */
		module.restore = function(tagOrVersion, callback) {
			if (!tagOrVersion) {
				throw new Error("Tag label or version number must he provided");
			}

			var msgObj = {
				wa: "restore",
				d: webstrateId,
			};

			if (/^\d/.test(tagOrVersion)) {
				msgObj.v = tagOrVersion;
			} else {
				msgObj.l = tagOrVersion;
			}

			websocketSend(msgObj, callback);
		};

		/**
		 * Tag a document with a label at a specific version.
		 * @param  {string} label    Tag label.
		 * @param  {integer} version Version.
		 * @public
		 */
		module.tag = function(label, version) {
			if (!label && !version) {
				return currentTag;
			}
			tagDocument(label, version);
		};

		module.untag = function(tagOrVersion) {
			untagDocument(tagOrVersion)
		};

		module.tags = function() {
			return allTags;
		}

		/**
		 * Exposes document version through getter.
		 * @return {Number} Document version
		 * @public
		 */
		Object.defineProperty(module, "version", {
			get: function getVersion() {
				return doc.version;
			},
			set: function setVersion(v) {
				throw new Error("Version is read-only");
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