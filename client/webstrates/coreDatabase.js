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

		// Subscribe to remote operations (changes to the ShareDB document).
		doc.subscribe(function(error) {
			if (error) {
				return reject(error);
			}

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
		});
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