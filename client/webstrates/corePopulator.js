'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreJsonML = require('./coreJsonML');
const corePathTree = require('./corePathTree');
const sharedb = require('sharedb/lib/client');

const corePopulator = {};

coreEvents.createEvent('populated');

corePopulator.populate = function(rootElement, doc) {
	// Empty the document, so we can use it.
	while (rootElement.firstChild) {
		rootElement.removeChild(rootElement.firstChild);
	}

	const webstrateId = doc.id;

	// This will normally be the case, but when using the static parameter, the document will just
	// be a plain JavaScript object, in which case we don't need all this stuff.
	if (doc instanceof sharedb.Doc) {
		// A typeless document is not a document at all. Let's create one.
		if (!doc.type || doc.data.length === 0) {
			if (!doc.type) {
				console.log(`Creating new sharedb document: "${webstrateId}".`);
				doc.create('json0');
			} else {
				console.log('Document exists, but was empty. Recreating basic document.');
			}

			const op = [{ 'p': [], 'oi': [
				'html', {},
				[ 'head', {},
				[ 'title', {}, webstrateId ] ],
				[ 'body', {} ]
			]}];
			doc.submitOp(op);
		}

		// All documents are persisted as JsonML, so we only know how to work with JSON documents.
		if (doc.type.name !== 'json0') {
			throw `Unsupported document type: ${doc.type.name}`;
		}
	}

	// In order to execute scripts synchronously, we insert them all without execution, and then
	// execute them in order afterwards.
	const scripts = [];
	const html = coreJsonML.toHTML(doc.data, undefined, scripts);
	coreUtils.appendChildWithoutScriptExecution(rootElement, html);

	return new Promise((resolve) => {
		coreUtils.executeScripts(scripts, () => {
			// Do not include the parent element in the path, i.e. create corePathTree on the <html>
			// element rather than the document element.
			const targetElement = rootElement.childNodes[0];
			const pathTree = corePathTree.create(targetElement, null, true);
			pathTree.check();
			resolve();
			coreEvents.triggerEvent('populated', targetElement, webstrateId);
		});
	});
};

module.exports = corePopulator;