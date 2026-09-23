'use strict';
const coreDatabase = require('./coreDatabase');
const coreEvents = require('./coreEvents');
const coreIds = require('./coreIds');
const coreUtils = require('./coreUtils');
const coreJsonML = require('./coreJsonML');
const corePathTree = require('./corePathTree');

const corePopulator = {};

coreEvents.createEvent('populated');
coreEvents.createEvent('adoptingDocument');

/**
 * Execute collected scripts, build the path tree and fire 'populated' — the
 * tail of every population path. The path tree comes last: userland scripts
 * may move things around before it is built (their mutations are not
 * observed yet, matching the classic population semantics).
 * @param  {Node}     targetElement The <html> element that now lives in the document.
 * @param  {array}    scripts      Script elements to (re)execute in order.
 * @param  {string}   webstrateId  Webstrate id.
 * @return {Promise}               Resolves when the population is complete.
 * @private
 */
const finishPopulation = (targetElement, scripts, webstrateId) => new Promise((resolve) => {
	coreUtils.executeScripts(scripts, () => {
		const pathTree = corePathTree.create(targetElement, null, true);
		// The tree only fails to build for a transient root (protected mode
		// can leave the populated document unapproved); the document still
		// stands, it just cannot produce ops.
		if (pathTree) pathTree.check();
		else console.warn('corePopulator: root admitted no path tree');
		resolve();
		coreEvents.triggerEvent('populated', targetElement, webstrateId);
	});
});

/**
 * Collect a live DOM's script elements in document order — for the adopted
 * page, whose scripts the browser never executed (the server neutered their
 * types until adoption restored them).
 * @param  {Node}    targetElement Root element to walk.
 * @return {array}                Script elements, in order.
 * @private
 */
const collectScripts = (targetElement) => {
	const scripts = [];
	coreUtils.recursiveForEach(targetElement, (node) => {
		if (node.nodeType === document.ELEMENT_NODE
			&& node.tagName === 'SCRIPT') {
			scripts.push(node);
		}
	});
	return scripts;
};

/**
 * Bootstrap an empty document: mint ids for the standard structure, build its
 * DOM (registering every node with the id registry), derive its JsonML (the
 * eids ride along as __wid properties), and commit the whole thing as the
 * document's root insert. The text metadata is handed to the translation so
 * the commit's wire ops carry the very ids the DOM now wears.
 * @param  {Node}   rootElement The document (its children get replaced).
 * @param  {object} doc         The live doc object.
 * @param  {string} webstrateId Webstrate id.
 * @return {Promise}           Resolves when the structure is committed.
 * @private
 */
const bootstrapDocument = async (rootElement, doc, webstrateId) => {
	// Ids for the standard structure: 4 elements and 5 text nodes, an eid
	// apiece (a text node's content needs no index of its own) — a small
	// block refill is plenty.
	await coreIds.refill(16, 16);

	const html = document.createElement('html');
	const head = document.createElement('head');
	const title = document.createElement('title');
	const body = document.createElement('body');
	for (const element of [html, head, title, body]) {
		const eid = coreIds.mintId();
		if (eid !== null) coreIds.registerElement(element, eid);
	}

	// Text nodes in document (JsonML pre-)order: head's two "\n"s around the
	// title, the title text, the "\n" between head and body, and body's
	// trailing "\n". There is deliberately NO text before <head>: the HTML
	// parser's "before head" mode drops whitespace there, so such a node
	// could never be re-created by parsing a served (painted) page — the
	// adopted DOM must be one a parser can reproduce.
	const textMetas = [];
	const textNodes = [];
	for (let i = 0; i < 5; i++) {
		const node = document.createTextNode(
			i === 1 ? webstrateId : '\n'); // the <title> text
		const eid = coreIds.mintId();
		if (eid !== null) {
			coreIds.registerTextOrComment(node, eid);
			textMetas.push({ eid });
		}
		textNodes.push(node);
	}

	coreUtils.appendChildWithoutScriptExecution(title, textNodes[1]);
	coreUtils.appendChildWithoutScriptExecution(head, textNodes[0]);
	coreUtils.appendChildWithoutScriptExecution(head, title);
	coreUtils.appendChildWithoutScriptExecution(head, textNodes[2]);
	coreUtils.appendChildWithoutScriptExecution(body, textNodes[4]);
	coreUtils.appendChildWithoutScriptExecution(html, head);
	coreUtils.appendChildWithoutScriptExecution(html, textNodes[3]);
	coreUtils.appendChildWithoutScriptExecution(html, body);

	// Replace the loading shell (the doctype stays: every population path
	// ends with a document the served serialization expects).
	coreUtils.clearPreservingDoctype(rootElement);
	coreUtils.appendChildWithoutScriptExecution(rootElement, html);

	// The JsonML of exactly what was built, eids included.
	const jml = ['html', { __wid: html.__wid },
		['head', { __wid: head.__wid }, '\n',
			['title', { __wid: title.__wid }, webstrateId], '\n'], '\n',
		['body', { __wid: body.__wid }, '\n']];

	coreDatabase.setBootstrapTextMeta(textMetas);
	doc.submitOp([{ p: [], oi: jml }]);
};

corePopulator.populate = function(rootElement, doc) {
	const webstrateId = doc.id;
	const staticMode = coreUtils.getLocationObject().staticMode;

	if (staticMode) {
		// Static mode: build the DOM from the fetched snapshot's JsonML and
		// never modify the document.
		if (doc.type !== 'http://sharejs.org/types/JSONv0') {
			console.error(staticMode, doc.type);
			throw `Unsupported document type: ${doc.type}`;
		}

		const scripts = [];
		const html = coreJsonML.toHTML(doc.data, undefined, scripts);

		// Empty the previous document (e.g. the loading shell), keeping the
		// doctype.
		coreUtils.clearPreservingDoctype(rootElement);

		coreUtils.appendChildWithoutScriptExecution(rootElement, html);
		return finishPopulation(rootElement.documentElement, scripts, webstrateId);
	}

	// Live mode. The doc object is backed by the client's own state; the
	// database marked whether the DOM is already in place (an adopted
	// pre-rendered page or a structure rebuild) or has to be bootstrapped
	// (a brand-new, empty document).
	if (doc.type && doc.type.name !== 'json0') {
		console.error(doc.type);
		throw `Unsupported document type: ${doc.type}`;
	}

	if (!doc.domReady) {
		// Empty document: create the standard structure and commit it as the
		// document's root insert, then populate normally. The model is the
		// submitted op's value, so no adoption finalization is needed.
		return bootstrapDocument(rootElement, doc, webstrateId).then(() => {
			return finishPopulation(rootElement.documentElement, [], webstrateId);
		});
	}

	// A structural rebuild (during subscribe, or later on divergence) has
	// already executed the scripts, built the path tree, derived the model
	// and fired its events — nothing left to do here.
	if (doc.scriptsExecuted) {
		return Promise.resolve();
	}

	// Adopted DOM: keep it as-is, execute its collected scripts and derive
	// the canonical model from the final DOM once the path tree exists.
	// documentElement, not childNodes[0]: an adopted page keeps the parsed
	// doctype, so childNodes[0] is the doctype node (whose nodeName is also
	// "html"!). The bootstrapped/rebuilt paths clear the document first, so
	// only the adopted DOM carries a doctype — but documentElement is right
	// for every path.
	const documentElement = rootElement.documentElement;
	const scripts = collectScripts(documentElement);
	// Protected mode must treat the adopted DOM as server-persisted state: its
	// nodes were parsed out of the served page, so nothing marked them approved
	// the way the internal createElement/importNode overrides do for the
	// bootstrap and rebuild paths. Listeners (protectedMode) approve the whole
	// tree before anything else runs, so the path tree below admits it and
	// attribute edits on pre-existing nodes become non-transient.
	coreEvents.triggerEvent('adoptingDocument', documentElement, webstrateId);
	return new Promise((resolve) => {
		coreUtils.executeScripts(scripts, () => {
			const pathTree = corePathTree.create(documentElement, null, true);
			// See finishPopulation: a transient root leaves the document
			// standing but op-less until a rebuild succeeds.
			if (pathTree) pathTree.check();
			else console.warn('corePopulator: adopted root admitted no path tree');
			coreDatabase.finalizeAdoption();
			resolve();
			coreEvents.triggerEvent('populated', documentElement, webstrateId);
		});
	});
};

module.exports = corePopulator;
