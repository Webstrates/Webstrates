'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreJsonML = require('./coreJsonML');
const corePathTree = require('./corePathTree');

const corePopulator = {};

coreEvents.createEvent('populated');

/**
 * Execute collected scripts, build the path tree and fire 'populated' — the
 * tail of the population path.
 * @param  {Node}     targetElement The <html> element that now lives in the document.
 * @param  {array}    scripts      Script elements to (re)execute in order.
 * @param  {string}   webstrateId  Webstrate id.
 * @return {Promise}               Resolves when the population is complete.
 * @private
 */
const finishPopulation = (targetElement, scripts, webstrateId) => new Promise((resolve) => {
	coreUtils.executeScripts(scripts, () => {
		const pathTree = corePathTree.create(targetElement, null, true);
		pathTree.check();
		resolve();
		coreEvents.triggerEvent('populated', targetElement, webstrateId);
	});
});

corePopulator.populate = function(rootElement, doc) {
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

	// Empty the previous document (e.g. the loading shell)
	while (rootElement.firstChild) {
		rootElement.removeChild(rootElement.firstChild);
	}

	coreUtils.appendChildWithoutScriptExecution(rootElement, html);

	return finishPopulation(rootElement.childNodes[0], scripts, webstrateId);
};

module.exports = corePopulator;
