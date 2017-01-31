var root = typeof module === "object" && module.exports ? module.exports : window;

root.webstrates = (function(webstrates) {
	"use strict";
	/**
	 * Webstrate constructor. Creates a webstrate instance.
	 * @param {WebSocket} websocket   WebSocket for ShareDB to use for transmitting operations.
	 * @param {string} webstrateId    Name of ShareDB document.
	 * @param {bool} staticMode       Whether the webstrate should be served statically or not.
	 * @param {string} tagOrVersion   If being served statically, a specific tag or version may have
	 *                                been requested.
	 * @constructor
	 */
	var Webstrate = function(websocket, webstrateId, staticMode, tagOrVersion) {
		var module = {};

		module.webstrateId = webstrateId;

		// Every webstrate object needs a unique ID. There is only one webstrate instance, so "document"
		// will do.
		module.id = "document";

		var COLLECTION_NAME = "webstrates";

		// Default permissions for all webstrates.
		var defaultPermissionsList;

		// One-to-one mapping from nodeIds to their nodes.
		var nodeIds = {};

		// Current tag label if it exists.
		var currentTag;

		// Object of all tags, indexed by version number.
		var allTags;

		// List of all asset objects.
		var allAssets;

		// Cookie object assumed with user. This is not HTTP cookies.
		var cookies = {
			anywhere: {},
			here: {}
		};

		// List of future tags in case we have received tags before our own document has been
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
		var callbackLists = {       // Callbacks are triggered when:
			loaded: [],               //   the document has been loaded.
			transcluded: [],          //   the document has been transcluded.
			clientJoin: [],           //   client connects to the webstrate.
			clientPart: [],           //   client disconnects from the webstrate.
			cookieUpdateHere: [],     //   the cookie accessible only from this document has been updated.
			cookieUpdateAnywhere: [], //   the cookie accessible from every document has been updated.
			permissionsChanged: [],   //   the user's read/write permissions have changed.
			signal: [],               //   client sends a signal.
			tag: [],                  //   new tag has been set.
			untag: [],                //   tag has been removed.
			asset: [],                 //   new asset has been added.
			disconnect: [],           //   the user disconnects.
			reconnect: []             //   the user reconnects after having been disconnected.
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
		var targetElement = document;

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
						tokenCallbackMap[token](new Error("Request timed out"));
					}
				}, 2000);

			}
			websocket.send(JSON.stringify(msgObj));
		};

		/**
		 * Handles websocket messages that we don't want ShareDB to touch. This gets attached to
		 * `websocket.onmessage` elsewhere.
		 * @param  {Object} data JavaScript object with request data.
		 * @private
		 */
		var websocketMessageHandler = function(data) {
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
			// current collection (c) and webstrate document (d). However, some messages (namely
			// "anywhere" cookies) will not be addressed to a particular webstrate, but should still
			// make it through. Therefore, we also allow undefined d properties.
			if (data.c !== COLLECTION_NAME || (data.d && data.d !== webstrateId)) {
				return;
			}

			switch (data.wa) {
				case "hello":
					var clientId = data.id;
					module.clientId = clientId;
					module.user = data.user || {};
					defaultPermissionsList = data.defaultPermissions;
					module.user.permissions = webstrates.util.getPermissionsFromSnapshot(module.user.username,
						module.user.provider, doc, defaultPermissionsList);
					module.clients = data.clients;
					cookies = data.cookies || { here: {}, anywhere: {} };

					// Only allow cookies if the user object exists, i.e. is logged in with OAuth.
					if (module.user.userId) {
						module.user.cookies = {
							anywhere: {
								get: function(key) {
									if (!key) return cookies.anywhere;
									return cookies.anywhere[key];
								},
								set: function(key, value) {
									cookies.anywhere[key] = value;
									updateCookie(key, value, true);
								}
							},
							here: {
								get: function(key) {
									if (!key) return cookies.here;
									return cookies.here[key];
								},
								set: function(key, value, callback) {
									cookies.here[key] = value;
									updateCookie(key, value, false);
								}
							}
						}
					}
					break;

				case "clientJoin":
					var clientId = data.id;
					module.clients.push(clientId);
					triggerCallbacks(callbackLists.clientJoin, clientId);
					break;

				case "clientPart":
					var clientId = data.id;
					module.clients.splice(module.clients.indexOf(clientId), 1);
					triggerCallbacks(callbackLists.clientPart, clientId);
					break;

				case "cookieUpdate":
					if (data.d) {
						cookies.here[data.update.key] = data.update.value;
						triggerCallbacks(callbackLists.cookieUpdateHere, data.update.key,
							data.update.value);
					} else {
						cookies.anywhere[data.update.key] = data.update.value;
						triggerCallbacks(callbackLists.cookieUpdateAnywhere, data.update.key,
							data.update.value);
					}
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
					triggerCallbacks(callbackLists.untag, version);
					break;

				case "assets":
					allAssets = data.assets;
					break;

				case "asset":
					allAssets.push(data.asset);
					triggerCallbacks(callbackLists.asset, data.asset);
					break;

				case "delete":
					module.destroy();
					alert("Document has been deleted.");
					window.location = "/";
					break;
				default:
					console.warn("Unknown event", data);
			}
		};

		/**
		 * Attaches listeners to the websocket connection that trigger disconnect and reconnect events.
		 * @param  {WebSocket} websocket Websocket.
		 * @private
		 */
		var setupWebsocketListeners = function(websocket) {
			module.connectionState = websocket.readyState;
			var previouslyConnected = websocket.readyState === WebSocket.OPEN;

			var existingOpenHandler = websocket.onopen;
			websocket.onopen = function(event) {
				// Only trigger reconnect if we've previously been connected.
				if (previouslyConnected) {
					module.connectionState = websocket.readyState;
					triggerCallbacks(callbackLists.reconnect);
				}
				previouslyConnected = true;
				existingOpenHandler(event);
			};

			var existingCloseHandler = websocket.onclose;
			websocket.onclose = function(event) {
				module.connectionState = websocket.readyState;
				triggerCallbacks(callbackLists.disconnect);
				existingCloseHandler(event);
			};

			var existingErrorHandler = websocket.onerror;
			websocket.onerror = function(event) {
				module.connectionState = websocket.readyState;
				existingErrorHandler(event);
			};
		};

		/**
		 * Attaches keep alive manager to a websocket connetion that continuously sends messages to the
		 * server to ensure that the websocket connection isn't being terminated for inactivity.
		 * @param  {WebSocket} websocket Websocket.
		 * @private
		 */
		var setupKeepAlive = function(websocket) {
			// Keep alive message.
			var keepAliveMessage = JSON.stringify({
				type: 'alive'
			});

			var KEEP_ALIVE_TIMER = 45 * 1000; // 45 seconds between keep alive messages.
			var keepAliveInterval;

			var enableKeepAlive = function() {
				// Make sure to disable any previous keep alive interval.
				disableKeepAlive();

				keepAliveInterval = setInterval(function() {
					websocket.send(keepAliveMessage);
				}, KEEP_ALIVE_TIMER);
			};

			var disableKeepAlive = function() {
				if (keepAliveInterval) {
					clearInterval(keepAliveInterval);
					keepAliveInterval = null;
				}
			};

			var existingOpenHandler = websocket.onopen;
			websocket.onopen = function(event) {
				existingOpenHandler(event);
				enableKeepAlive();
			};

			var existingCloseHandler = websocket.onclose;
			websocket.onclose = function(event) {
				existingCloseHandler(event);
				disableKeepAlive();
			};

			var existingErrorHandler = websocket.onerror;
			websocket.onerror = function(event) {
				existingErrorHandler(event);
				disableKeepAlive();
			};
		};

		if (!staticMode) {
			// Hand WebSocket connection to ShareDB.
			var conn = new sharedb.Connection(websocket);

			// We want to use ShareDB's websocket connection for emitting our own events, specifically
			// events for when clients join and leave the webstrate. ShareDB attaches itself as listener
			// on the websocket, but we need to intercept the messages and filter out our own first. So we
			// save ShareDB's on-message handler, attach our own, and then forward messages that aren't
			// for us to ShareDB.
			var sdbMessageHandler = websocket.onmessage;
			websocket.onmessage = function(event) {
				var data = JSON.parse(event.data);
				if (data.wa) {
					websocketMessageHandler(data);
				} else {
					sdbMessageHandler(event);
				}
			};

			// Get ShareDB document for webstrateId.
			doc = conn.get(COLLECTION_NAME, webstrateId);

			// Subscribe to remote operations (changes to the ShareDB document).
			doc.subscribe(function(error) {
				if (error) {
					throw error;
				}
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
		} else {
			// If a static document is requested, ShareDB can't help us, as ShareDB will just give us the
			// newest version of the document. Instead, we will have to get the document ourselves.
			websocket.onmessage = function(event) {
				var data = JSON.parse(event.data);
				websocketMessageHandler(data);
			};

			var recWsOpenHandler = websocket.onopen;
			websocket.onopen = function(event) {
				var msgObj = {
					wa: "fetchdoc",
					d: webstrateId
				};

				var tag, version;
				 if (/^\d/.test(tagOrVersion) && Number(tagOrVersion)) {
					msgObj.v = Number(tagOrVersion);
				} else {
					msgObj.l = tagOrVersion;
				}

				websocketSend(msgObj, function(err, snapshot) {
					doc = snapshot;
					populateElementWithDocument(webstrateId, doc, targetElement,
						function documentPopulated() {
						rootElement = targetElement.childNodes[0];
						pathTree = webstrates.PathTree.create(rootElement, null, true);
						notifyListeners(webstrateId);
					});
				});
				websocket.onopen = recWsOpenHandler;
				recWsOpenHandler(event);
			}
		}

		// Attaches listeners to the websocket connection that trigger disconnect and reconnect events.
		setupWebsocketListeners(websocket);

		// Attaches keep alive manager to the websocket.
		setupKeepAlive(websocket);

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

			// This will normally be the case, but when using the static parameter, the document will just
			// be a plain JavaScript object, in which case we don't need all this stuff.
			if (doc instanceof sharedb.Doc) {
				// A typeless document is not a document at all. Let's create one.
				if (!doc.type || doc.data.length === 0) {
					if (!doc.type) {
						console.log(`Creating new sharedb document: "${webstrateId}".`);
						doc.create('json0');
					} else {
						console.log("Document exists, but was empty. Recreating basic document.");
					}

					var op = targetElement.parentNode
							? [{ "p": [], "oi": [ "div", { id: "doc_" + webstrateId, "class": "document" }]}]
							: [{ "p": [], "oi": [ "html", {}, [ "body", {} ]]}];
					doc.submitOp(op);
				}

				// All documents are persisted as JsonML, so we only know how to work with JSON documents.
				if (doc.type.name !== 'json0') {
					throw `Unsupported document type: ${sjsDocument.type.name}`;
				}
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

			// Let the server know that we are ready. This will trigger a `clientJoin` event on other
			// clients.
			websocketSend({ wa: "ready", d: webstrateId });

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

			// Set up `documentMaintainer` mutation observer.
			var maintainerObserver = new MutationObserver(documentMaintainer);
			maintainerObserver.observe(rootElement, observerOptions);

			// Run the maintainer on the just-initialized document.
			webstrates.util.recursiveForEach(rootElement, maintainElement);

			// And set up `mutationToOps` mutation observer.
			observer = new MutationObserver(mutationToOps);
			observer.observe(rootElement, observerOptions);
		};

		/**
		 * Sets up listener for operations on a document.
		 * @param  {ShareDBDocument} doc      Document to listen for operations on.
		 * @param  {DOMElement} rootElement    Element to listen for mutations on.
		 * @private
		 */
		var setupOpListener = function(doc, rootElement, pathTree) {
			doc.on('op', function onOp(ops, source) {

				var permissionsChanged = ops.some(function(op) {
					return op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === "data-auth";
				});

				// If permissions have changed, we need to recalculate the user's permissions.
				if (permissionsChanged) {
					var newPermissions = webstrates.util.getPermissionsFromSnapshot(module.user.username,
						module.user.provider, doc, defaultPermissionsList);
					if (module.user.permissions !== newPermissions) {
						module.user.permissions = newPermissions;
						triggerCallbacks(callbackLists.permissionsChanged, newPermissions,
							module.user.permissions);
					}
				}

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

				// Received an empty object (a no-op).
				if (typeof ops === "object" && Object.keys(ops).length === 0) {
					return;
				}

				// Invalid ops received.
				if (!Array.isArray(ops)) {
					console.warn("Invalid ops received", ops);
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
				setTimeout(callback, 0, ...parameters);
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
					var context = node.nodeType === Node.ELEMENT_NODE &&
						node.tagName.toLowerCase() === "iframe" && node.ContentWindow ?
						(node.contentWindow || window) : window;
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
			// Create a unique ID for each element if the element has a path node. If the node doesn't
			// have a path node, it either hasn't been added to the DOM yet, so we can't create an op for
			// the other clients, or the element isn't being tracked by Webstrates (this is the case with
			// transient elements and their descendants). Either way, we don't need to add a unique ID.
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

		var updateCookie = function(key, value, isGlobal) {
			var updateObj = {
				wa: "cookieUpdate",
				update: { key, value }
			};
			if (!isGlobal) {
				updateObj.d = webstrateId;
			}
			websocketSend(updateObj);
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

			if (!staticMode) {
				websocketSend(msgObj, callback);
				return;
			}

			msgObj.wa = "fetchdoc";
			websocketSend(msgObj, function(err, snapshot, ...args) {
				if (!err) {
					doc = snapshot;
					populateElementWithDocument(webstrateId, doc, targetElement,
						function documentPopulated() {
						rootElement = targetElement.childNodes[0];
						pathTree = webstrates.PathTree.create(rootElement, null, true);
					});
				};
								if (callback) callback(err, snapshot, ...args);

			});
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

		/**
		 * Untag a document with a tag or version
		 * @param  {[type]} tagOrVersion Tag or version.
		 * @public
		 */
		module.untag = function(tagOrVersion) {
			untagDocument(tagOrVersion)
		};

		/**
		 * Get a object of all tags. Returns a copy, so users won't (accidentally) modify it.
		 * @return {obj} Object with tags, indexed by version number.
		 * @public
		 */
		module.tags = function() {
			return webstrates.util.cloneObject(allTags);
		};

		/**
		 * Get a list of all asset objects. Returns a copy, so users won't (accidentally) modify it.
		 * @return {obj} List of all asset objects.
		 * @public
		 */
		module.assets = function() {
			return webstrates.util.cloneObject(allAssets);
		};

		/**
		 * Exposes document version through getter.
		 * @return {Number} Document version
		 * @public
		 */
		Object.defineProperty(module, "version", {
			get: function getVersion() {
				// If our document is an instance of sharedb.Doc (which it will be, unless we're requesting
				// a static version of the document), then doc.version is defined. If doc is just a plain
				// JavaScript object, the doc.version will be undefined, but doc.v will exist.
				return doc.version || doc.v;
			},
			set: function setVersion(v) {
				throw new Error("version is read-only");
			}
		});

		/**
		 * Exposes staticMode through getter.
		 * @return {bool} Whether document is is being served as static or not.
		 * @public
		 */
		Object.defineProperty(module, "isStatic", {
			get: function getIsStatic() {
				return staticMode;
			},
			set: function setVersion(b) {
				throw new Error("isStatic is read-only");
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