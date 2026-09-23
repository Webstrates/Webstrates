'use strict';

/**
 * PaintNormalizer — the server-side half of the painted transport's
 * stability guarantee.
 *
 * A served paint must re-parse (in the browser) to exactly the document the
 * mirror holds, or the DOM the client adopts would diverge from the model.
 * So, on the first render of every revision, the server parses its own paint
 * with parse5 — an implementation of the WHATWG parsing algorithm, the same
 * algorithm browsers run — applies the same transform the client's adoption
 * applies (reparent <head_>'s children and attributes onto the temporary
 * real <head>, move the nodes between </head_> and the <!--wsh--> marker
 * back to html level, drop the wire-only artifacts), trims the identity
 * prefixes, and diffs the resulting browser-canonical mirror against the
 * document's own.
 *
 *   No diff  → the revision is marked stable (meta key paintStableV) and
 *              every later render skips the pass.
 *   Diff     → the changes the browser would have made — moves (sr+sa with
 *              preserved element ids), parser-synthesized nodes (sa with
 *              minted ids), merges and fostered relocations — are committed
 *              as the document's own ops for that revision, the paint is
 *              re-rendered and verified once, and the stable revision is
 *              served.
 *
 * Documents with unparseable shapes (API-created table>tr, text children of
 * tables, adjacent text nodes, comments inside script raw text, …) self-
 * heal on their first load; the "browser's changes" become their first ops.
 * Served paints are therefore always identity-carrying and stable, and the
 * client's digest check can never see a mismatch of the server's making.
 */

const parse5 = require('parse5');
const diffMirrors = require(APP_PATH + '/helpers/mirrorDiff.js');

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_COMMENT = 8;

// -- parse5 tree helpers --------------------------------------------------------

const attrOf = (node, name) => {
	const a = (node.attrs || []).find((x) => x.name === name);
	return a ? a.value : undefined;
};

// template contents live in .content; everything else in .childNodes.
const childrenOf = (node) =>
	(node.content ? node.content.childNodes : node.childNodes) || [];

// Identity of an element from its `_` attribute: a bare "eid" (the
// attribute rides last and unquoted; Number() takes either form).
const eidOf = (el) => {
	const raw = attrOf(el, '_');
	if (!raw) return null;
	const eid = Number(raw);
	return Number.isInteger(eid) && eid > 0 ? eid : null;
};

// Identity and content of a text/comment node from its "eid_" prefix.
const prefixedData = (node) => {
	const data = node.nodeName === '#text' ? node.value : node.data;
	const m = /^(\d+)_([\s\S]*)$/.exec(data);
	if (!m) return null;
	return { eid: Number(m[1]), content: m[2] };
};

/**
 * Apply the adoption transform to the parse tree and extract the
 * browser-canonical mirror from it.
 *
 * The transform mirrors the client's adoption exactly: wire-only artifacts
 * are dropped, the temporary real <head> adopts the <head_> element's
 * attributes and children (keeping head_'s `_`, which carries the mirror
 * head's identity), and the html-level nodes the parser placed into body
 * (everything between head_ and the <!--wsh--> marker) move back between
 * head and body. The walk then reads identities off `_=eid` attributes and
 * "eid_" prefixes; attribute positions are the parse tree's own attribute
 * order. Parser-synthesized nodes (tbody, formatting elements, merged raw
 * content, a lost <html> or <head>) get ids minted from the document's
 * global counter, so the diff commits them as creations.
 *
 * @param  {Handle}  handle DocumentStore handle.
 * @param  {string}  wire   The check wire (DocumentStore.toHTML output).
 * @return {Map}            Mirror (eid → node), root 0 = document container.
 * @public
 */
function extractMirror(handle, wire) {
	const parsed = parse5.parse(wire);

	// Ids for parser-synthesized nodes: lazily allocated blocks from the
	// document's global counter (nothing is minted on the happy path — a
	// stable document's every node carries its identity).
	let mintPool = null;
	const mint = () => {
		if (!mintPool || mintPool.next > mintPool.end) {
			const { start } = handle.allocIds(1024);
			mintPool = { next: start, end: start + 1023 };
		}
		return mintPool.next++;
	};

	// html / head / body. The parser always builds one of each (synthesizing
	// missing ones); head_ rides as body's first child, marked by the
	// transport-only data-webstrates-head attribute a mirror node can never
	// carry (validOp rejects it).
	let htmlEl = null;
	for (const child of childrenOf(parsed)) {
		if (child.tagName === 'html') { htmlEl = child; break; }
	}
	if (!htmlEl) throw new Error('paint normalizer: parse produced no <html>');
	let headEl = null, bodyEl = null;
	for (const child of childrenOf(htmlEl)) {
		if (child.tagName === 'head' && !headEl) headEl = child;
		else if (child.tagName === 'body' && !bodyEl) bodyEl = child;
	}
	if (!headEl || !bodyEl) {
		throw new Error('paint normalizer: parse produced no <head>/<body>');
	}
	const head_ = childrenOf(bodyEl).find((c) => c.tagName === 'head_'
		&& attrOf(c, 'data-webstrates-head') === '1');

	// Reparent: the real head adopts head_'s attributes (minus the marker,
	// keeping `_` — its own identity) and children; head_ is removed.
	if (head_) {
		headEl.attrs = head_.attrs.filter((a) => a.name !== 'data-webstrates-head');
		headEl.childNodes = head_.childNodes;
		bodyEl.childNodes = bodyEl.childNodes.filter((c) => c !== head_);
	}

	// Region: body children before the <!--wsh--> marker are html-level
	// nodes — move them back between head and body; the marker goes away.
	const wshIdx = bodyEl.childNodes.findIndex((c) =>
		c.nodeName === '#comment' && c.data === 'wsh');
	if (wshIdx === -1) {
		throw new Error('paint normalizer: wire is missing the region marker');
	}
	const region = bodyEl.childNodes.splice(0, wshIdx + 1);
	region.pop(); // the marker itself
	htmlEl.childNodes.splice(htmlEl.childNodes.indexOf(bodyEl), 0, ...region);

	// Build the mirror. Attribute positions are the parse tree's own
	// attribute order — the DOM's attribute list IS the index map, so no
	// indexes ride the wire and none are minted here. Scripts are
	// un-neutered on the way in: type="webstrates/x" (which rides at the
	// type's own position) swaps back to the data-webstrates-type value, or
	// disappears when the script had no type; the marker itself and `_` are
	// transport-only and never enter the mirror.
	const elementAttrs = (el) => {
		let wireAttrs = el.attrs.filter((a) => a.name !== '_');
		if (el.tagName === 'script') {
			const marker = wireAttrs.find((a) => a.name === 'data-webstrates-type');
			wireAttrs = wireAttrs.filter((a) => a.name !== 'data-webstrates-type')
				.map((a) => (a.name === 'type' && a.value === 'webstrates/x'
					? (marker ? { name: 'type', value: marker.value } : null) : a))
				.filter(Boolean);
		}
		return wireAttrs.map((a) => ({ n: a.name, v: a.value }));
	};

	const mirror = new Map();
	mirror.set(0, { p: null, t: 0, n: null, kids: [], attrs: [] });
	const addNode = (eid, p, t, n) => {
		if (mirror.has(eid) || !mirror.has(p)) return null; // unique ids, known parent
		const node = { p, t, n, kids: [], attrs: [] };
		mirror.set(eid, node);
		mirror.get(p).kids.push(eid);
		return node;
	};

	const walkChild = (node, pEid) => {
		if (node.nodeName === '#text' || node.nodeName === '#comment') {
			const id = prefixedData(node);
			const eid = id ? id.eid : mint();
			const t = node.nodeName === '#text' ? NODE_TEXT : NODE_COMMENT;
			const mirrorNode = addNode(eid, pEid, t, null);
			if (mirrorNode) {
				mirrorNode.attrs.push({ n: null,
					v: id ? id.content : (node.value !== undefined ? node.value : node.data) });
			}
			return;
		}
		if (node.tagName) walkElement(node, pEid);
		// (#documentType and other non-element nodes never appear here.)
	};

	const walkElement = (el, pEid) => {
		const eid = eidOf(el) || mint();
		const node = addNode(eid, pEid, NODE_ELEMENT, el.tagName);
		if (node) {
			node.attrs = elementAttrs(el);
			for (const child of childrenOf(el)) walkChild(child, eid);
		}
	};

	walkElement(htmlEl, 0);
	return mirror;
}

/**
 * The normalization ops for a handle's current revision: serialize the
 * check wire, parse it with the spec algorithm, extract the
 * browser-canonical mirror, diff it against the document's own.
 * @param  {Handle} handle DocumentStore handle.
 * @return {{wire: string, ops: [op]}} The check wire and the diff ops
 *   (empty when the revision is stable).
 * @public
 */
function diffOps(handle) {
	const wire = handle.toHTML(handle.nodes);
	const extracted = extractMirror(handle, wire);
	const ops = diffMirrors(handle, extracted);
	return { wire, ops };
}

/**
 * Ensure a handle's current revision is paint-stable, committing the
 * browser-canonical normalization ops when it is not. Runs on the first
 * render of a revision (meta key paintStableV), skipped afterwards; the
 * committed ops broadcast like any other commit, so connected clients
 * converge on the normalized shape without a reload.
 *
 * options.commit, when given, applies the ops instead of the default
 * DocumentManager path (used by unit tests to keep MongoDB out of the
 * picture).
 * @param  {Handle}  handle  DocumentStore handle (caller keeps the reference).
 * @param  {object}  options {commit?: (handle, ops) => result}
 * @return {void}
 * @public
 */
function ensureStable(handle, options = {}) {
	if (handle.getMeta('paintStableV') === handle.revision) return;

	const commit = options.commit
		|| ((h, ops) => require(APP_PATH + '/helpers/DocumentManager.js')
			.submitPaintNormalization(h.id, h, ops));

	const { ops } = diffOps(handle);
	if (ops.length > 0) {
		commit(handle, ops);
		// Verify once: the normalized mirror must now re-parse to itself.
		// A remaining diff means the serializer and the parser disagree
		// (a bug or a hostile shape that loops); serve anyway — the client's
		// digest check is the backstop — and never commit twice (a
		// diverging pair would ping-pong the document forever).
		const second = diffOps(handle);
		if (second.ops.length > 0) {
			console.error(`PaintNormalizer: "${handle.id}" v${handle.revision} ` +
				`did not converge (${second.ops.length} ops remaining after ` +
				`normalization); serving with the client digest as backstop`);
		}
	}

	handle.setMeta('paintStableV', handle.revision);
}

module.exports = { extractMirror, diffOps, ensureStable };
