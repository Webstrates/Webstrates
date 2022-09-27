'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

const taggingModule = {};

coreEvents.createEvent('receivedTags');
globalObject.createEvent('tag');
globalObject.createEvent('untag');

var doc, currentTag, allTags = {}, futureTags = {};

const websocket = coreWebsocket.copy(event => event.data.startsWith('{"wa":'));
const webstrateId = coreUtils.getLocationObject().webstrateId;

websocket.onjsonmessage = (message) => {
	// Ignore message intended for other webstrates sharing the same websocket.
	if (message.d !== webstrateId) return;

	switch (message.wa) {

		case 'tags': {
			message.tags.forEach((tag) => {
				allTags[tag.v] = tag.label;
			});
			coreEvents.triggerEvent('receivedTags', allTags);
			break;
		}

		case 'tag': {
			let label = message.l;
			let version = message.v;

			// The label may already be in use, but since labels are unique, we should remove it.
			let existingVersion = Object.keys(allTags).find(candidateVersion =>
				allTags[candidateVersion] === label);

			if (existingVersion) {
				delete allTags[existingVersion];
			}

			allTags[version] = label;
			if (doc.version === version) {
				currentTag = label;
			} else if (version > doc.version) {
				futureTags[version] = label;
			}

			globalObject.triggerEvent('tag', version, label);
			break;
		}

		case 'untag': {
			let label = message.l;
			let version = message.v;

			if (!version && label) {
				version = Object.keys(allTags).find(candidateVersion =>
					allTags[candidateVersion] === label);
			}
			delete allTags[version];

			globalObject.triggerEvent('untag', version);
			break;
		}

	}
};

// When an op comes in, the document version changes and so does the tag. In rare cases, we may have
// received a tag for a version we were yet to be in at the time, in which case we may already know
// the tag of the new version, but most likely, this will set currentTag to undefined.
function moveFutureTags() {
	currentTag = futureTags[doc.version];
	// Move all futureTags that are no longer "future" into allTags.
	Object.keys(futureTags).forEach(function(futureVersion) {
		if (futureVersion <= doc.version) {
			allTags[futureVersion] = futureTags[futureVersion];
			delete futureTags[futureVersion];
		}
	});
}

// We can't set the currentTag until we have received all the tags and the document, so we know the
// current version of the current. Therefore, we wait until both the document and tags have been
// received using the promises below.
const docPromise = new Promise((accept, reject) => {
	coreEvents.addEventListener('receivedDocument', doc => accept(doc));
});

const tagsPromise = new Promise((accept, reject) => {
	coreEvents.addEventListener('receivedTags', tags => accept(tags));
});

// We use two promises below, one just for doc and one for tags. In static mode, we won't receive
// the tags, thus the document will never get set.
// We can't just have two single promises, in case the tags promise gets resolved before the doc
// promise.
// TODO: Make sure we receive tags in static mode as well.
docPromise.then(_doc => {
	doc = _doc;
});

Promise.all([docPromise, tagsPromise]).then(([_doc, tags]) => {
	currentTag = tags[doc.version];

	// We wait for both the document (so we know the version) and the tags to come in, before we can
	// start moving the currentTag 'tag pointer'.
	coreEvents.addEventListener('receivedOps', moveFutureTags);
	coreEvents.addEventListener('createdOps', moveFutureTags);
});

// Define functions on the global webstrate object to allow tagging and untagging.

/**
 * Tag a document with a label at a specific version.
 * @param  {string} label      Tag label.
 * @param  {integer} version   (optional) Version.
 * @param  {Function} callback (optional) Callback to be called when done.
 * @public
 */
globalObject.publicObject.tag = (label, version, callback) => {
	if (!label && !version) {
		return currentTag;
	}

	if (/^\d/.test(label)) {
		throw new Error('Tag name should not begin with a number');
	}

	if (label.includes('.')) {
		throw new Error('Tag name should not contain periods');
	}

	if (typeof version === 'function') {
		callback = version;
		version = undefined;
	}

	if (!version) {
		version = doc.version;
	}

	if (isNaN(version)) {
		throw new Error('Version must be a number');
	}

	if (allTags[doc.version] === label) return;
	allTags[doc.version] = label;
	websocket.send({
		wa: 'tag',
		d: doc.id,
		v: version,
		l: label
	}, callback);
};

/**
 * Untag a document with a tag or version
 * @param  {mixed} tagOrVersion Tag or version.
 * @public
 */
globalObject.publicObject.untag = (tagOrVersion) => {
	if (!tagOrVersion) {
		throw new Error('Tag label or version number must he provided');
	}

	const msgObj = {
		wa: 'untag',
		d: doc.id,
	};

	let version;

	// If tagOrVersion begins with a digit, we know it's a version.
	if (/^\d/.test(tagOrVersion)) {
		version = tagOrVersion;
	} else {
		// If it's a tag label, find the corresponding version.
		version = Object.keys(allTags).find(candidateVersion =>
			allTags[candidateVersion] === tagOrVersion);
	}

	msgObj.v = version;

	if (!version) {
		throw new Error('Provided tag does not exist');
	}

	delete allTags[version];
	websocket.send(msgObj);
};

Object.defineProperty(globalObject.publicObject, 'version', {
	// If our document is an instance of sharedb.Doc (which it will be, unless we're requesting
	// a static version of the document), then doc.version is defined. If doc is just a plain
	// JavaScript object, the doc.version will be undefined, but doc.v will exist.
	get: () => doc.version || doc.v,
	set: (v) => { throw new Error('Version is read-only'); }
});

/**
 * Get a object of all tags. Returns a frozen copy, so users won't (accidentally) modify it.
 * @return {obj} Object with tags, indexed by version number.
 * @public
 */
globalObject.publicObject.tags = () => Object.freeze(coreUtils.objectClone(allTags));

module.exports = taggingModule;