'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreJsonML = require('./coreJsonML');
const corePathTree = require('./corePathTree');

const corePopulator = {};

coreEvents.createEvent('populated');

corePopulator.populate = function(rootElement, doc) {
	// Empty the document, so we can use it.
	while (rootElement.firstChild) {
		rootElement.removeChild(rootElement.firstChild);
	}

	const webstrateId = doc.id;
	const staticMode = coreUtils.getLocationObject().staticMode;
	// If the document doesn't exist (no type) or is empty (no data), we should recreate it, unless
	// we're in static mode. We should never modify the document from static mode.
	if ((!doc.type || doc.data.length === 0) && !staticMode) {
		if (!doc.type) {
			console.log(`Creating new sharedb document: "${webstrateId}".`);
			doc.create('json0');
		} else {
			console.warn(`Document: "${webstrateId}" exists, but was empty. Recreating basic document.`);
		}

		const op = [{ 'p': [], 'oi': [
			'html', {}, '\n',
			[ 'head', {}, '\n',
				[ 'title', {}, webstrateId ], '\n'], '\n',
			[ 'body', {}, '\n' ]
		]}];
		doc.submitOp(op);
	}

	// All documents are persisted as JsonML, so we only know how to work with JSON documents.
	if ((!staticMode && doc.type.name !== 'json0')
		|| (staticMode && doc.type !== 'http://sharejs.org/types/JSONv0')) {
		console.error(staticMode, doc.type);
		throw `Unsupported document type: ${doc.type.name}`;
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