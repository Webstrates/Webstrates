'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const sharedb = require('sharedb/lib/client');
const COLLECTION_NAME = 'webstrates';

coreEvents.createEvent('receivedDocument');
coreEvents.createEvent('receivedOps');
coreEvents.createEvent('databaseError');
coreEvents.createEvent('opsAcknowledged');

let doc, conn;

/**
 * Get the ShareDB document, or get an element at a certain path in the document if a path is
 * provided.
 * @param  {Array} path  (optional) Path into the ShareDB document.
 * @return {mixed}       ShareDB document object or a path into the document.
 * @public
 */
exports.getDocument = path => {
	if (!path || !Array.isArray(path)) return doc;
	return path.reduce((doc, path) => doc && doc[path], doc.data);
};

/**
 * Get the element at a given path in a JsonML document.
 * @param  {JsonMLPath} path Path to follow in snapshot.
 * @return {JsonML}          Element at path in snapshot.
 * @public
 */
exports.elementAtPath = (snapshot, path) => {
// Snapshot is optional (and only used in the internal recursion).
	if (!path) {
		path = snapshot;
		snapshot = doc.data;
	}

	if (path.length > 0 && typeof path[path.length-1] === 'string') {
		return null;
	}

	var [head, ...tail] = path;
	if (!head || !snapshot[head]) {
		return snapshot;
	}

	return exports.elementAtPath(snapshot[head], tail);
};

// Having multiple subscriptions to the same webstrate causes ShareDB to behave oddly and cut
// off parts of operations for (so far) unknown reasons. As a result, getDocument will return
// nothing if a subcription to the document already exists.
const subscriptions = new Set();
Object.defineProperty(globalObject.publicObject, 'getDocument', {
	value: (webstrateId) => {
		// In case this document is transcluded as well, we recursively ask the parent for the document.
		if (!conn) {
			return window.parent.window.webstrate.getDocument(webstrateId);
		}

		if (subscriptions.has(webstrateId)) return;
		subscriptions.add(webstrateId);
		return conn.get(COLLECTION_NAME, webstrateId);
	}
});

/**
 * Whether the browser's DecompressionStream natively understands brotli
 * (Firefox does; Chrome only supports gzip/deflate — there the snapshot is
 * decoded by a lazily fetched WASM decoder shipped as a bundle chunk).
 * @return {bool} True if new DecompressionStream('br') can be constructed.
 * @private
 */
let nativeBrotliSupported;
function canNativeBrotli() {
	if (nativeBrotliSupported === undefined) {
		try {
			new DecompressionStream('br');
			nativeBrotliSupported = true;
		} catch (err) {
			nativeBrotliSupported = false;
		}
	}
	return nativeBrotliSupported;
}

// Cached promise for the lazily initialized WASM brotli decoder (Chrome has
// no native 'br' DecompressionStream). The decoder glue AND its wasm bytes
// are bundled with the client (as base64, generated at build time), so the
// fast path pays no extra roundtrip for the decoder — it inits with the
// embedded bytes instead of letting the package fetch its .wasm.
let brotliInitPromise;
const brotliWasmModule = require('brotli-dec-wasm/web');
const BROTLI_WASM_BASE64 = require('./brotli-wasm-bytes.b64');

/**
 * Decode the embedded brotli-decoder wasm into bytes (once per page).
 * @return {Uint8Array} Decoder wasm bytes.
 * @private
 */
function embeddedBrotliWasmBytes() {
	const binary = atob(BROTLI_WASM_BASE64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Decompress brotli bytes (as a Uint8Array) into a parsed JSON payload.
 * Returns null when no decoder is available or decoding fails — callers then
 * fall back to the HTTP ?snapshot route, whose Content-Encoding: br is
 * decompressed by the network stack, no client decoder needed.
 * @param  {Uint8Array} bytes Compressed payload.
 * @return {Promise<Object|null>} Parsed payload, or null.
 * @private
 */
async function decodeBrotliPayload(bytes) {
	try {
		if (canNativeBrotli()) {
			const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('br'));
			return JSON.parse(await new Response(stream).text());
		}
		brotliInitPromise = brotliInitPromise
			|| brotliWasmModule.default({ module_or_path: embeddedBrotliWasmBytes() });
		await brotliInitPromise;
		return JSON.parse(new TextDecoder().decode(brotliWasmModule.decompress(bytes)));
	} catch (err) {
		return null;
	}
}

/**
 * Request the compressed snapshot over the (already open) websocket, so no
 * second HTTP request is needed on load. The server replies with a binary
 * frame (cache hit — the brotli bytes, token-correlated by coreWebsocket), a
 * plain reply without payload (genuine cache miss — proceed with a normal
 * subscribe; the server is already rebuilding the cache), or nothing at all
 * (older server without the handler — after a short timeout, fall back to
 * the HTTP route).
 * @param  {string} webstrateId Webstrate id.
 * @return {Promise<Uint8Array|undefined|null>} Compressed bytes (hit),
 *   undefined (miss), or null (websocket path unavailable — use HTTP).
 * @private
 */
function fetchCompressedSnapshotOverWebsocket(webstrateId) {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => settle(null), 2000);
		coreWebsocket.send({ wa: 'fetchSnapshot', d: webstrateId }, (err, reply) => {
			if (err) return settle(null);
			if (!(reply instanceof Uint8Array) || reply.byteLength === 0) return settle(undefined);
			settle(reply);
		}, { waitForOpen: true });
	});
}

/**
 * Fetch the brotli-compressed snapshot from the server's cache — preferring
 * the websocket (the connection is already open, so the initial bulk data
 * arrives without firing up another HTTP request), falling back to the HTTP
 * ?snapshot route when the websocket path is unavailable (there the network
 * stack decompresses the payload before fetch() sees it) — and ingest it
 * into the ShareDB doc locally, exactly as if it had arrived as a regular
 * snapshot. A subsequent doc.subscribe() then only needs the ops since this
 * version (sharedb's subscribe message carries doc.version and the server
 * answers with ops only) — the full JSONML snapshot never crosses the
 * websocket as uncompressed JSON.
 * @param  {Doc}    doc         ShareDB document.
 * @param  {string} webstrateId Webstrate id.
 * @return {Promise<bool>}     Whether a snapshot was ingested.
 * @private
 */
async function tryIngestCompressedSnapshot(doc, webstrateId) {
	try {
		const bytes = await fetchCompressedSnapshotOverWebsocket(webstrateId);

		if (bytes) {
			const payload = await decodeBrotliPayload(bytes);
			if (!payload) {
				// No usable decoder (or a corrupt frame): the HTTP route needs none.
				return ingestFromHttpResponse(doc, await fetch(`${location.pathname}?snapshot`,
					{ cache: 'no-store' }));
			}
			if (typeof payload.v !== 'number' || !Array.isArray(payload.data)) {
				return false;
			}
			doc.ingestSnapshot({ v: payload.v, type: payload.type, data: payload.data });
			return true;
		}

		if (bytes === undefined) {
			// A genuine miss: don't also fire the HTTP request (it would miss
			// too, and the server is already rebuilding the cache entry).
			return false;
		}

		// Websocket path unavailable (null): HTTP fallback.
		return ingestFromHttpResponse(doc, await fetch(`${location.pathname}?snapshot`,
			{ cache: 'no-store' }));
	} catch (err) {
		return false;
	}
}

/**
 * Ingest a payload fetched over the HTTP ?snapshot route (Content-Encoding:
 * br — the network stack has already decompressed it into JSON).
 * @param  {Doc}      doc      ShareDB document.
 * @param  {Response} response fetch() response for ?snapshot.
 * @return {Promise<bool>}      Whether a snapshot was ingested.
 * @private
 */
async function ingestFromHttpResponse(doc, response) {
	if (!response.ok) {
		return false;
	}
	const payload = await response.json();
	if (!payload || typeof payload.v !== 'number' || !Array.isArray(payload.data)) {
		return false;
	}
	doc.ingestSnapshot({ v: payload.v, type: payload.type, data: payload.data });
	return true;
}

exports.subscribe = webstrateId => {
	return new Promise((resolve, reject) => {
		// Check if we can reuse the ShareDB Database connection from a parent if we're in an iframe.
		if (coreUtils.isTranscluded() && coreUtils.sameParentDomain() && config.reuseWebsocket) {
			doc = window.parent.window.webstrate.getDocument(webstrateId);
		}

		// Even if we're transcluded, we won't succeed in getting a document from our parent if another
		// subscription on the same webstrate already exists.
		if (!doc) {
			// Filter out our own messages. This could be done more elegantly by parsing the JSON object
			//  and
			// then checking if the "wa" property exists, but this is a lot faster.
			// This filter is passed to coreWebsocket.copy() when getting a copy of a websocket.
			// @param  {obj} event  Websocket onmessage event.
			// @return {bool}       Whether the message should be let through to ShareDB.
			const websocket = coreWebsocket.copy(event => !event.data.startsWith('{"wa":'));

			// Create a new ShareDB connection.
			conn = new sharedb.Connection(websocket);

			// Get ShareDB document for webstrateId.
			doc = conn.get(COLLECTION_NAME, webstrateId);
		}

		// Wire up the document events once the (cache-accelerated or normal)
		// subscribe has completed.
		const wireUp = () => {
			coreEvents.triggerEvent('receivedDocument', doc, { static: false });

			// Generate a unique ID for this document client.
			const source = coreUtils.randomString();

			coreEvents.addEventListener('createdOps', (ops) => {
				doc.submitOp(ops, { source });
			}, coreEvents.PRIORITY.IMMEDIATE);

			doc.on('op batch', (ops, opsSource) => {
				// We don't broadcast a 'receivedOps' event for ops we create ourselves, as we haven't
				// received them from anybody.
				if (opsSource !== source) {
					coreEvents.triggerEvent('receivedOps', ops);
				}
			});

			// This event gets triggered after all ops have been successfully been received by the
			// server and submitted to the database. There's 'nothing pending' in the submission queue.
			// If a user is making changes to the DOM, we can't guarantee that they have been recorded
			// after this event has happened.
			doc.on('nothing pending', () => {
				coreEvents.triggerEvent('opsAcknowledged');
			});

			doc.on('error', error => {
				// ShareDB error code 4018 (Document was created remotely) triggers happens when multiple
				// clients try to create the same webstrate at the same time. It doesn't matter, so we
				// suppress it.
				if (error.code === 4018) return;
				console.error(error);
				coreEvents.triggerEvent('databaseError', error);
			});

			resolve(doc);
		};

		// The compressed fast path is only attempted when the server advertises it (the
		// flag is baked into the bundle at build time) and we own the ShareDB connection
		// (a transcluded webstrate reuses its parent's doc, which the parent already
		// loaded).
		const cacheEligible = serverConfig.compressedSnapshots === true && !coreUtils.isTranscluded();

		const finishSubscribe = (ingestedFromCache) => {
			doc.subscribe(function(error) {
				if (error) {
					// An ingested cache snapshot can disagree with the server's op log
					// (e.g. the document was deleted and recreated after the cache entry
					// was written): discard the doc and do a clean, cache-less load.
					if (ingestedFromCache) {
						doc.destroy(() => {
							doc = conn.get(COLLECTION_NAME, webstrateId);
							doc.subscribe(function(retryError) {
								if (retryError) return reject(retryError);
								wireUp();
							});
						});
						return;
					}
					return reject(error);
				}

				wireUp();
			});
		};

		if (!cacheEligible) return finishSubscribe(false);

		tryIngestCompressedSnapshot(doc, webstrateId)
			.then(ingested => finishSubscribe(ingested))
			.catch(() => finishSubscribe(false));
	});
};

/**
 * Set the version (`v`) or tag label (`l`) property on a message object. Versions consist only
 * of digits while labels cannot begin with a digit, so distinguishing is easy, but the version
 * may arrive as either a number or a numeric string ("3"), and it is sent to the server as a
 * number, as the server compares versions strictly.
 * @param {Object}        msgObj       Message object to set the version/tag property on.
 * @param {string|Number} tagOrVersion Tag label or version number.
 * @private
 */
function setVersionOrTag(msgObj, tagOrVersion) {
	if (/^\d+$/.test(String(tagOrVersion))) {
		// Version 0 is a valid version, so the coerced value mustn't be tested for truthiness.
		msgObj.v = Number(tagOrVersion);
	} else {
		msgObj.l = tagOrVersion;
	}
}

exports.fetch = (webstrateId, tagOrVersion) => {
	return new Promise((resolve, reject) => {
		const msgObj = {
			wa: 'fetchdoc',
			d: webstrateId
		};

		setVersionOrTag(msgObj, tagOrVersion);

		// The second parameter is `sendWhenReady` and true means to queue the message until the
		// websocket is open rather than to throw and error if the websocket isn't ready. This is not
		// part of the WebSocket specification, but has been implemented in coreWebsocket anyway.
		coreWebsocket.send(msgObj, (err, doc) => {
			if (err) return reject(err);
			coreEvents.triggerEvent('receivedDocument', doc, { static: true });
			resolve(doc);
		}, { waitForOpen: true });
	});
};

/**
 * Restore document to a previous version, either by version number or tag label.
 * This does not return a promise, as we do not have control over exactly when the document gets
 * reverted as this is ShareDB's job.
 * @param {string|Number} tagOrVersion Tag label or version number.
 * @param {Function} callback Callback
 */
exports.restore = (webstrateId, tagOrVersion, callback) => {
	var msgObj = {
		wa: 'restore',
		d: webstrateId
	};

	setVersionOrTag(msgObj, tagOrVersion);

	coreWebsocket.send(msgObj, callback);
};

/**
 * Get a range of ops from a specific webstrate.
 * @param  {string}   webstrateId Webstrate to get ops from .
 * @param  {Number}   fromVersion Version to start the op range from (inclusive).
 * @param  {Number}   toVersion   Version to end the op range at (exclusive).
 * @param  {Function} callback    Callback.
 * @return {Array}                (async) Array of ops in the range.
 */
exports.getOps = (webstrateId, fromVersion, toVersion, callback) => {
	coreWebsocket.send({
		wa: 'getOps',
		d: webstrateId,
		from: fromVersion,
		to: toVersion
	}, callback);
};