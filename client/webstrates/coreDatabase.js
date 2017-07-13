'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const sharedb = require('sharedb/lib/client');

const coreDatabaseModule = {};

coreEvents.createEvent('receivedDocument');
coreEvents.createEvent('receivedOps');

let doc, conn;

coreDatabaseModule.getDocument = () => doc;

/**
 * Get the element at a given path in a JsonML document.
 * @param  {JsonMLPath} path Path to follow in snapshot.
 * @return {JsonML}          Element at path in snapshot.
 * @public
 */
coreDatabaseModule.elementAtPath = function(snapshot, path) {
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

	return coreDatabaseModule.elementAtPath(snapshot[head], tail);
};

coreDatabaseModule.subscribe = (documentName) => {
	return new Promise((resolve, reject) => {
		// Filter out our own messages. This could be done more elegantly by parsing the JSON object and
		// then checking if the "wa" property exists, but this is a lot faster.
		// This filter is passed to coreWebsocket.copy() when getting a copy of a websocket.
		// @param  {obj} event  Websocket onmessage event.
		// @return {bool}       Whether the message should be let through to ShareDB.
		const websocket = coreWebsocket.copy(event => !event.data.startsWith('{"wa":'));

		// Check if we can reuse the ShareDB Database connection from a parent if we're in an iframe.
		if (coreUtils.isTranscluded() && coreUtils.sameParentDomain()) {
			conn = window.parent.window.webstrate.shareDbConnection;
		} else {
			// Create a new ShareDB connection.
			conn = new sharedb.Connection(websocket);
		}

		// Get ShareDB document for webstrateId.
		doc = conn.get('webstrates', documentName);

		// Subscribe to remote operations (changes to the ShareDB document).
		doc.subscribe(function(error) {
			if (error) {
				return reject(error);
			}

			coreEvents.triggerEvent('receivedDocument', doc, { static: false });

			doc.on('op', (ops, source) => {
				// If source is truthy, it is our own op, which should not be broadcasted as "recivedOps".
				// It will already have been broadcasted as "createdOps".
				if (!source) {
					coreEvents.triggerEvent('receivedOps', ops);
				}
			});

			coreEvents.addEventListener('createdOps', (ops) => {
				doc.submitOp(ops);
			}, coreEvents.PRIORITY.IMMEDIATE);

			resolve(doc);
		});
	});
};

coreDatabaseModule.fetch = (documentName, tagOrVersion) => {
	return new Promise((resolve, reject) => {
		const msgObj = {
			wa: 'fetchdoc',
			d: documentName
		};

		if (/^\d/.test(tagOrVersion) && Number(tagOrVersion)) {
			msgObj.v = Number(tagOrVersion);
		} else {
			msgObj.l = tagOrVersion;
		}

		// The second parameter is `sendWhenReady` and true means to queue the message until the
		// websocket is open rather than to throw and error if the websocket isn't ready. This is not
		// part of the WebSocket specification, but has been implemented in coreWebsocket anyway.
		coreWebsocket.send(msgObj, doc => {
			coreEvents.triggerEvent('receivedDocument', doc, { static: true });
			resolve(doc);
		}, { waitForOpen: true });
	});
};

/**
 * Restore document to a previous version, either by version number or tag label.
 * Labels cannot begin with a digit whereas versions consist only of digits, so distinguishing
 * is easy.
 * This does not return a promise, as we do not have control over exactly when the document gets
 * reverted as this is ShareDB's job.
 * @param  {string} tagOrVersion Tag label or version number.
 */
coreDatabaseModule.restore = (documentName, tagOrVersion) => {
	var msgObj = {
		wa: 'restore',
		d: documentName
	};

	if (/^\d/.test(tagOrVersion)) {
		msgObj.v = tagOrVersion;
	} else {
		msgObj.l = tagOrVersion;
	}

	coreWebsocket.send(msgObj);
};

Object.defineProperty(globalObject.publicObject, 'shareDbConnection', {
	get: () => conn
});

module.exports = coreDatabaseModule;