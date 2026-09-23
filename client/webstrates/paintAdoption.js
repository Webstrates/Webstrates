'use strict';

/**
 * paintAdoption — stream-side adoption of the pre-rendered ("painted") page.
 *
 * The painted transport serves the document as close to plain HTML as
 * identities allow: elements carry a _=<eid> attribute (unquoted value,
 * emitted LAST — removing it renumbers nothing), text and comment nodes
 * carry an "<eid>_" prefix on their content (their single "attribute", the
 * content, needs no index — position 0 is the node's only entry), the mirror
 * <head> rides as a <head_> element marked data-webstrates-head, and the
 * html-level nodes between head and body sit between that head_ element
 * and a bare <!--wsh--> comment inside body (the parser places them there).
 *
 * Attribute positions are purely local: the element's own attribute list in
 * the DOM IS the server's ordered list (the paint serialized them in mirror
 * order; removing the two transport-only names, both trailing every modeled
 * attribute, leaves the modeled order intact). Nothing about attributes is
 * registered at adoption.
 *
 * On a painted page the client bundle is a SYNC script in a temporary real
 * <head>, so this module executes before any document content exists: it
 * reads the page revision (its own tag's URL fragment) and content digest
 * (data-d), installs a MutationObserver, and does the parser-safe work AS
 * THE DOCUMENT STREAMS IN — strip _ attributes, trim the identity prefixes
 * with deleteData, register ids, un-neuter scripts — plus the two structural
 * transforms as soon as their boundaries arrive:
 *
 *   reparentHead — when head_'s next sibling appears, head_ is complete: its
 *     children move into the temporary real <head> (after removing the
 *     wire-only bundle + preload links), its attributes (the mirror head's)
 *     are copied over and registered, and head_ is removed.
 *   moveRegion — when the <!--wsh--> marker appears, the html-level nodes
 *     before it are complete: they move back between head and body, and the
 *     marker goes away.
 *
 * finish() (called by coreDatabase when the subscribe handshake wants the
 * adoption result) waits for DOMContentLoaded, sweeps everything the stream
 * pass could not see — template contents are invisible to a document-subtree
 * observer, records may still be in flight — runs the structural transforms
 * if their triggers never fired, and reports whether every node was adopted.
 * The server only serves paint-stable revisions (its own parse5 check), so a
 * failed adoption means extension interference or a parser divergence: the
 * content digest in coreDatabase catches it.
 *
 * The reveal of the document is deliberately NOT part of finish(): the boot
 * hide (wire-only, see SnapshotCacheManager.bootStyle) stays on through the
 * digest and the populator's script pass, and comes off at 'populated' —
 * unless a boot loader takes over first: the moment one announces itself on
 * <html> (BOOTLOADER_RE), our whole boot presentation — hide and spinner —
 * is removed and the loader owns the experience from there. Its loading
 * skin (if it ships one) has been live since parse; a loader without one
 * lets the raw document show while it compiles, exactly like any
 * script-driven website.
 */

const coreUtils = require('./coreUtils');
const coreIds = require('./coreIds');
const coreEvents = require('./coreEvents');

// The bundle wraps every module with a proxied `document` (see
// client/wrapper-header.js): Node-typed operations need the real one.
/* global _document */

const HEAD_MARKER = 'data-webstrates-head';
const REGION_MARKER = 'wsh';
const PREFIX_RE = /^(\d+)_/;
const WIRE_ONLY_HINTS = new Set(['script', 'link']); // head artifact elements

// Boot loader convention: a loader that will transform the document before
// it is fit to present (WPMv2: package install, Codestrates' SCSS->CSS
// compilation) announces itself on <html> as transient-<name>-bootloader —
// WPMv2 sets exactly this today (transient-wpm2-bootloader:
// waiting -> loading -> initializing -> loaded). The transient- prefix
// keeps the marker out of the mirror and the digest. Its appearance is a
// takeover: the transport's boot presentation (hide + spinner, see
// SnapshotCacheManager.bootStyle) is removed on the spot — the loader owns
// the loading experience from there. A loader that ships a skin takes the
// frame over cleanly (its CSS has been live since parse); a loader without
// one lets the raw document show through while it compiles, exactly like
// any script-driven website.
const BOOTLOADER_RE = /^transient-.+-bootloader$/;

const adoption = {
	painted: false,  // a painted page (bundle carries data-d)
	version: 0,      // revision the page was rendered at
	digest: null,    // content digest the server stamped
	headDone: false, // head_ reparented
	regionDone: false, // region moved back to html level
	failed: false,   // an identity did not parse: unusable paint
	revealed: false, // boot style removed: the document is visible
	revealHooked: false, // the 'populated' reveal listener is armed
	observer: null
};

// The loader-takeover watcher (see reveal): fires the moment a boot loader
// marks <html> — during the loader's own script, as a microtask, so no
// paint can ever show our spinner above the loader's own loading UI.
let markerObserver = null;

// Nodes whose adoption is complete (registered with their identity). The
// parser sets an element's attributes when inserting it, EXCEPT the later
// <body …> start tag, which merges its attributes onto the already-open
// body element — so an element without a _ at insertion is not final and
// gets re-examined on attribute records.
const adoptedElements = new WeakSet();
const adoptedTexts = new WeakSet();

/**
 * The wire-only artifacts of the temporary real <head>: the client bundle
 * script and the script preload links (every mirror node carries a _, so
 * script/link children without one are transport-only).
 * @param {Element} element Head child to check.
 * @return {bool} Whether the child is wire-only.
 * @private
 */
const isHeadArtifact = (element) =>
	WIRE_ONLY_HINTS.has(element.tagName.toLowerCase())
		&& !element.hasAttribute('_');

/**
 * Adopt one element: parse its _ attribute (the bare eid), register the eid
 * and strip the _. Nothing else is tracked: the element's own attribute list
 * in DOM order IS the server's ordered list, and the _ (and the trailing
 * un-neuter marker, removed later) sat after every modeled attribute, so
 * their removal renumbers nothing. Scripts stay neutered — un-neutering is
 * deferred to finish() (after every structural move). Returns false when the
 * identity does not parse — the paint is unusable.
 * @param  {Element} element Element from the painted page.
 * @return {bool}            Whether the element was adopted cleanly.
 * @private
 */
const adoptElement = (element) => {
	if (adoptedElements.has(element)) return true;
	// The head_ wrapper is transport-only: its _ attribute belongs to the
	// mirror head and is consumed by reparentHead. Adopting it here would
	// strip the _ before reparentHead can read it (and register the head's
	// eid against a node that is about to be removed).
	if (element.tagName === 'HEAD_' && element.getAttribute(HEAD_MARKER) === '1') {
		return true;
	}
	const raw = element.getAttribute('_');
	if (raw === null) return true; // wire-only or parser-synthesized
	const eid = Number(raw);
	if (!Number.isInteger(eid) || eid <= 0) {
		adoption.failed = true;
		return false;
	}
	element.removeAttribute('_');
	coreIds.registerElement(element, eid);
	// Scripts stay neutered through the whole structural adoption (see
	// unneuterScripts in finish): an un-neutered script executes the moment
	// it is re-inserted, and the head reparent and region moves re-insert.
	adoptedElements.add(element);
	return true;
};

/**
 * Un-neuter one script: the server rode it with type="webstrates/x" (and
 * data-webstrates-type carrying its real type) so nothing executes during
 * parse or adoption. Restoring the type never triggers execution by itself
 * (execution is decided when a script is inserted; these are only ever
 * parser-inserted) — the populator executes the document's scripts in
 * document order once adoption has finished.
 * @param  {Element} element Script element.
 * @private
 */
const unneuterScript = (element) => {
	const realType = element.getAttribute('data-webstrates-type');
	if (realType !== null) {
		element.setAttribute('type', realType);
		element.removeAttribute('data-webstrates-type');
	} else {
		element.removeAttribute('type');
	}
};

/**
 * Adopt one text/comment node: parse its "eid_" prefix, trim it with
 * deleteData (in place — the parsed node IS the node the document keeps)
 * and register the eid (the content is the node's single "attribute", at
 * implicit position 0 — no index rides along). A streamed node may be
 * examined before its prefix has fully arrived; it is left for a later
 * record and finally caught by the DOMContentLoaded sweep, where a
 * prefix-less node is either a parser-chunk continuation of its head
 * (merged, see mergeContinuation) or genuine divergence (the digest
 * backstop).
 * @param  {Node} node Text or comment node.
 * @param  {bool} complete Whether the tree is final (the sweep pass):
 *                    no node can still grow.
 * @return {bool}      Whether the node is adopted or still pending.
 * @private
 */
/**
 * Merge a prefix-less text/comment tail chunk into the node it continues
 * (the "eid_" identity prefix rides only on a parser-split text's first
 * chunk — see the body comment for the full picture).
 * @param  {Node} node Prefix-less text or comment node.
 * @return {bool}      Whether the node was merged into its head.
 * @private
 */
const mergeContinuation = (node) => {
	const prev = node.previousSibling;
	if (!prev || prev.nodeType !== node.nodeType
		|| !adoptedTexts.has(prev) || prev.__eid === undefined) {
		return false;
	}
	// Chrome's HTML parser splits very large text nodes into multiple DOM
	// siblings at its internal (~64KB) buffer boundaries when it builds
	// them during parsing: the first chunk carries the whole "eid_"
	// identity prefix, the tail chunks are bare. At the DOMContentLoaded
	// sweep — when the tree is final and no tail can still grow — a bare
	// tail is appended to its adopted head and removed, restoring the
	// one-node-per-value shape the mirror holds. (Merging is sweep-only: an
	// eager merge would detach a node that later grows, silently dropping
	// the growth.) A bare node with no adopted same-type head stays put —
	// the content digest in coreDatabase then names it as the divergence.
	// Removal is safe during the sweep: recursiveForEach snapshots each
	// child list before walking it, and the next tail's previousSibling is
	// read fresh (after this removal it is the head again, so any number of
	// consecutive tails folds into one node).
	prev.appendData(node.data);
	node.remove();
	return true;
};

const adoptTextOrComment = (node, complete = false) => {
	if (adoptedTexts.has(node)) return true;
	if (node.nodeType === Node.COMMENT_NODE && node.data === REGION_MARKER) {
		return true; // the region boundary, handled by moveRegion
	}
	const match = PREFIX_RE.exec(node.data);
	if (!match) {
		// No (complete) prefix yet: a still-growing stream node — or, on
		// the sweep, a tail chunk of a parser-split text (merged into its
		// head above). Any other prefix-less node cannot exist on a stable
		// paint; the digest check in coreDatabase is the backstop.
		if (complete) mergeContinuation(node);
		return true;
	}
	const eid = Number(match[1]);
	if (!Number.isInteger(eid) || eid <= 0) {
		adoption.failed = true;
		return false;
	}
	node.deleteData(0, match[0].length);
	coreIds.registerTextOrComment(node, eid);
	adoptedTexts.add(node);
	return true;
};

/**
 * Reparent the mirror head: head_'s children into the temporary real
 * <head> (after its wire-only bundle + preloads are removed), head_'s
 * attributes onto the head (copied in order — the copy preserves the
 * server's attribute order, which the head's own list then IS), and
 * head_ out of the document. The real head never carried a _ of its own;
 * its registration happens here, entirely.
 * @return {bool} Whether the head was reparented.
 * @private
 */
const reparentHead = () => {
	if (adoption.headDone) return true;
	adoption.headDone = true;

	const body = document.body;
	const headEl = document.head;
	const head_ = body && headEl
		? Array.from(body.children).find((el) => el.tagName === 'HEAD_'
			&& el.getAttribute(HEAD_MARKER) === '1')
		: null;
	if (!head_) {
		// No mirror head on the wire: the (now bare) real head IS the
		// document's head.
		if (headEl) {
			for (const child of Array.from(headEl.children)) {
				if (isHeadArtifact(child)) child.remove();
			}
		}
		return true;
	}
	if (!headEl) {
		adoption.failed = true;
		return false;
	}

	// The bundle is executing from memory; drop it and the preloads.
	for (const child of Array.from(headEl.children)) {
		if (isHeadArtifact(child)) child.remove();
	}
	// Children first (their ids were registered when they streamed in;
	// registration is node-based and unaffected by the move).
	for (const child of Array.from(head_.childNodes)) {
		headEl.appendChild(child);
	}
	// The mirror head's attributes — copied onto the real head in wire
	// order (the copy preserves the server's ordering; the transport-only
	// _ and wrapper marker never make it over).
	const raw = head_.getAttribute('_');
	const eid = Number(raw);
	if (raw !== null && (!Number.isInteger(eid) || eid <= 0)) {
		adoption.failed = true;
		return false;
	}
	head_.removeAttribute('_');
	for (const attr of Array.from(head_.attributes)) {
		if (attr.name === HEAD_MARKER) continue;
		headEl.setAttribute(attr.name, attr.value);
	}
	if (raw !== null) coreIds.registerElement(headEl, eid);
	head_.remove();
	return true;
};

/**
 * Move the html-level nodes back between head and body: everything in body
 * before the marker comment was placed there by the parser (head_ already
 * left); it returns to html level, in order, and the marker is removed.
 * @param {Node} marker The <!--wsh--> comment.
 * @return {bool} Whether the region was moved.
 * @private
 */
const moveRegion = (marker) => {
	if (adoption.regionDone) return true;
	adoption.regionDone = true;

	const body = marker.parentNode;
	if (!body || body.tagName !== 'BODY') {
		adoption.failed = true;
		return false;
	}
	const html = body.parentNode;
	if (!html) {
		adoption.failed = true;
		return false;
	}
	const moved = [];
	while (body.firstChild !== marker) {
		const first = body.firstChild;
		moved.push(first);
		body.removeChild(first);
	}
	marker.remove();
	for (const node of moved) {
		html.insertBefore(node, body);
	}
	return true;
};

/**
 * One mutation batch during the stream: process records in order (they
 * arrive in document/mutation order, so a boundary's predecessors have
 * always been seen first).
 * @param {[MutationRecord]} records Mutation observer records.
 * @private
 */
const processRecords = (records) => {
	for (const record of records) {
		if (adoption.failed) return;
		if (record.type === 'childList') {
			for (const node of record.addedNodes) handleAddedNode(node);
		} else if (record.type === 'attributes') {
			// The <body …> start tag merges its attributes onto the
			// already-open body element: an attribute record is the only
			// signal, and the element may have been (wrongly) given up on
			// at insertion.
			if (record.target.nodeType === Node.ELEMENT_NODE) {
				adoptElement(record.target);
			}
		} else if (record.type === 'characterData') {
			adoptTextOrComment(record.target);
		}
	}
};

/**
 * Whether this added node completes the mirror head: any node appearing
 * after head_ means head_ is fully parsed (the wire is a tree, so nothing
 * inside head_ is still open when a sibling appears). Checked BEFORE the
 * region marker is handled — moveRegion would otherwise carry head_ along
 * with the region.
 * @param  {Node}  node Added node.
 * @return {bool}       Whether head_ is complete now.
 * @private
 */
const completesHead = (node) => {
	if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'HEAD_') {
		return false; // head_ itself
	}
	const body = document.body;
	if (!body) return false;
	const head_ = body.firstElementChild;
	if (!head_ || head_.tagName !== 'HEAD_'
		|| head_.getAttribute(HEAD_MARKER) !== '1') {
		return false;
	}
	return head_ !== body.lastChild; // some node followed it
};

/**
 * A node the parser just placed: adopt it, and check the two structural
 * boundaries — head_ completing (any following node appearing) and the
 * region marker arriving.
 * @param {Node} node Added node.
 * @private
 */
const handleAddedNode = (node) => {
	if (adoption.headDone === false && completesHead(node)) {
		if (!reparentHead()) return;
	}
	if (node.nodeType === Node.ELEMENT_NODE) {
		adoptElement(node);
	} else if (node.nodeType === Node.COMMENT_NODE
		&& node.data === REGION_MARKER) {
		if (!adoption.regionDone) moveRegion(node);
	} else if (node.nodeType === Node.TEXT_NODE
		|| node.nodeType === Node.COMMENT_NODE) {
		adoptTextOrComment(node);
	}
};

// Module load: on a painted page the bundle is a sync script in the
// temporary real <head> — the document body has not been parsed yet. On the
// plain client shell (empty documents, old versions) there is no data-d and
// this module stays inert.
const current = document.currentScript;
if (current && current.hasAttribute('data-d')) {
	adoption.painted = true;
	const match = (current.getAttribute('src') || '').match(/#(\d+)$/);
	adoption.version = match ? Number(match[1]) : 0;
	adoption.digest = current.getAttribute('data-d');
	if (!Number.isInteger(adoption.version) || adoption.version <= 0
		|| !adoption.digest) {
		adoption.failed = true;
	} else {
		adoption.observer = new MutationObserver(processRecords);
		// The real document (the wrapped `document` here is a proxy, not a
		// Node); the records it produces carry real nodes either way.
		adoption.observer.observe(_document, {
			childList: true, subtree: true, attributes: true,
			characterData: true
		});
		// The parser may already have produced nodes between the bundle's
		// execution and the observer install (the <html> element, the temp
		// <head>, its script). The DOMContentLoaded sweep catches them.
	}
}

/**
 * Reveal the document: remove the wire-only boot style (the hide + loading
 * UI, see SnapshotCacheManager.bootStyle) and tear down the takeover
 * watcher. Idempotent, and it always runs to completion — no observer
 * survives it. For a plain document this is at 'populated': the body was
 * kept display:none through parse and adoption, so the reveal is the
 * first and only layout — of the final document. For a codestrate it is
 * the moment its boot loader announces itself: the loader owns the
 * experience from there, hide and all (its skin, or the raw compiling
 * document — see BOOTLOADER_RE).
 * @private
 */
const reveal = () => {
	if (adoption.revealed) return;
	adoption.revealed = true;
	if (markerObserver) {
		markerObserver.disconnect();
		markerObserver = null;
	}
	for (const el of document.querySelectorAll('[data-webstrates-boot]')) {
		el.remove();
	}
};

/**
 * Reveal now, whatever the state: strip the boot style (the hide + spinner)
 * and tear down the takeover watcher. Used by the reveal paths internally
 * and by the load dead ends (coreDatabase.showLoadError), which would
 * otherwise leave the watcher armed on a stopped page.
 * @public
 */
module.exports.reveal = reveal;

/**
 * Whether the running page is a painted page (carrying a revision + digest).
 * @return {bool}
 * @public
 */
module.exports.isPainted = () => adoption.painted;

/**
 * The revision the painted page was rendered at (the bundle URL fragment).
 * @return {int} Revision, 0 when unknown/unpainted.
 * @public
 */
module.exports.pageVersion = () => adoption.version;

/**
 * The content digest the server stamped on the bundle (data-d).
 * @return {string|null} Hex digest.
 * @public
 */
module.exports.pageDigest = () => adoption.digest;

/**
 * Finish the adoption: wait for DOMContentLoaded (the whole document has
 * parsed; template contents and in-flight records included), sweep the tree
 * for anything the stream pass could not see, run the structural transforms
 * if their triggers never fired, disconnect the observer, and finally
 * un-neuter the scripts (only now is it safe — every re-insertion is done).
 * Afterwards the document holds exactly what the mirror said, with ids
 * registered and scripts ready for the populator.
 * @return {Promise<bool>} Whether the adoption completed cleanly.
 * @public
 */
module.exports.finish = async () => {
	if (!adoption.painted || adoption.failed) return false;

	const domReady = document.readyState === 'loading'
		? new Promise((resolve) => document.addEventListener(
			'DOMContentLoaded', () => resolve(), { once: true }))
		: Promise.resolve();
	await domReady;

	let ok = true;
	coreUtils.recursiveForEach(document.documentElement, (node) => {
		if (!ok || adoption.failed) return;
		if (node.nodeType === Node.ELEMENT_NODE) {
			// The head_ wrapper is consumed by reparentHead (below), not
			// adopted as an element of its own.
			if (node.tagName === 'HEAD_' && node.getAttribute(HEAD_MARKER) === '1') {
				return;
			}
			ok = adoptElement(node);
		} else if (node.nodeType === Node.TEXT_NODE
			|| node.nodeType === Node.COMMENT_NODE) {
			// The sweep is the complete-tree pass: prefix-less tails are
			// parser-split continuations here, not still-growing nodes.
			ok = adoptTextOrComment(node, true);
		}
	});

	// Structural transforms, if their stream triggers never fired (empty
	// heads/regions, tiny documents, a marker after the last observed node).
	if (!adoption.headDone) ok = reparentHead() && ok;
	if (!adoption.regionDone) {
		let marker = null;
		coreUtils.recursiveForEach(document.documentElement, (node) => {
			if (!marker && node.nodeType === Node.COMMENT_NODE
				&& node.data === REGION_MARKER) marker = node;
		});
		if (marker) ok = moveRegion(marker) && ok;
	}

	if (adoption.observer) {
		adoption.observer.disconnect();
		adoption.observer = null;
	}
	// Scripts were carried neutered so nothing executes mid-adoption — an
	// un-neutered script would have run the moment the head reparent or the
	// region moves re-inserted it. With every structural move done (and the
	// observer gone), restoring their types is inert by itself; the populator
	// executes them in document order. Template contents ride along.
	if (ok && !adoption.failed) {
		coreUtils.recursiveForEach(document.documentElement, (node) => {
			if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SCRIPT'
				&& (node.hasAttribute('data-webstrates-type')
					|| node.getAttribute('type') === 'webstrates/x')) {
				unneuterScript(node);
			}
		});
	}
	// Adoption is complete — but the document is NOT revealed here. The
	// boot style survives the digest (computeRows skips it: a wire-only
	// node, never a mirror node) and comes off at 'populated' — after the
	// document's own scripts have run — unless a boot loader takes over
	// first (see BOOTLOADER_RE). IMMEDIATE priority: the listener runs
	// synchronously with the trigger, before the populate chain arms the
	// op observer; both removal paths are covered by the style's
	// `transient` attribute (op-free removal, see bootStyle). Dead ends
	// (paths that never populate) strip it in showLoadError.
	if (!adoption.revealHooked) {
		adoption.revealHooked = true;
		coreEvents.addEventListener('populated', () => reveal(),
			coreEvents.PRIORITY.IMMEDIATE);
	}
	// Arm the loader-takeover watcher before the document's scripts run:
	// the moment a boot loader marks <html>, reveal() runs from the
	// observer's microtask — before any paint could show our spinner
	// above the loader's own loading UI — so the handoff is a clean
	// frame-switch and the loader owns the experience from its first
	// tick (its skin, or the raw compiling document).
	if (!markerObserver) {
		markerObserver = new MutationObserver(() => {
			const htmlEl = _document.documentElement;
			if (!htmlEl || adoption.revealed) return;
			const marked = Array.from(htmlEl.attributes)
				.some((a) => BOOTLOADER_RE.test(a.name));
			if (marked) reveal();
		});
		markerObserver.observe(_document.documentElement, { attributes: true });
	}
	return ok && !adoption.failed;
};

// Test hooks (never used by the application itself).
module.exports._adoption = adoption;
module.exports._adoptElement = adoptElement;
module.exports._adoptTextOrComment = adoptTextOrComment;
