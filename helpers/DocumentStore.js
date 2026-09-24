'use strict';

/**
 * DocumentStore — the SQLite-backed document engine.
 *
 * Storage model: each webstrate is two SQLite databases,
 *
 *   <id>.current  — domStruct(parentId, childIndex, childId, type, name) and
 *                   domState(eid, attrIndex, name, value): the document state
 *                   at the newest revision, plus tags(label, opid, timestamp)
 *                   and meta (the global id counter). attrIndex is the
 *                   attribute's LOCAL position within its element (0-based,
 *                   dense); text/comment content sits at position 0.
 *   <id>.history  — a REVERSE DIFF: domStructOps and domStateOps rows are the
 *                   INVERSE of each committed forward op (applying them in
 *                   descending opid order to `current` walks the document all
 *                   the way back to nothing), and commits(opid, …) mark
 *                   transaction boundaries with metadata.
 *
 * Element 0 is the document root (the DOM Document node). Element ids are
 * minted from one global counter; clients get blocks allocated (allocIds)
 * and mint ids for new nodes themselves, so ops only ever reference stable
 * ids — never paths. Attributes have no global ids: a name plus its position
 * within the element's own ordered attribute list identifies it, and the
 * DOM's attribute order (setAttribute appends, updates stay in place,
 * removeAttribute shifts) matches the mirror's by construction.
 *
 * Forward op kinds (wire format, integers except n/v):
 *   sa {k,p,i,e,t,n}  parent p gains child e (type t, name n) at index i
 *   sr {k,p,e}        parent p loses child e (index not needed — id-based;
 *                     the log's effective ops carry i for transforms)
 *   aa {k,e,i,n,v}    element e gains attribute n at local position i with
 *                     initial value v — an existing name updates in place
 *                     (i advisory); n null (no i) = text/comment content
 *   ar {k,e,n}        element e loses attribute n (name-anchored; a raw
 *                     {e,i} form addresses the position for hostile input)
 *   si {k,e,q,v}      insert string v at char position q into the content of
 *                     text/comment e
 *   sd {k,e,q,v}      delete string v at char position q from the content of
 *                     text/comment e
 *   si {k,e,i,q,v}    … or, with i, into the value of element e's i-th
 *   sd {k,e,i,q,v}        attribute
 *
 * A commit of k ops consumes k+1 opids (ops that turn out to be no-op replays
 * leave gaps); the REVISION of the document is the max opid, i.e. the last
 * commit's opid. Revision 0 is the empty document. Both databases are written
 * in one SQLite transaction (history is ATTACHed to current), so a crash never
 * leaves a partial transaction.
 *
 * History rows store the INVERSE op, with the kind of the INVERSE (a forward
 * `sa` is stored as an `sr`-row carrying the full (p,i,e,t,n) so it can be
 * re-inverted). To rebuild version V: copy current, apply history rows with
 * opid > V in descending order. To list the forward ops of a commit (?ops API,
 * transform sources): invert the rows.
 *
 * All applications — server mirror and the client's identical rules — are
 * IDEMPOTENT and convergent: sa with a replayed (p, i, e) is skipped, sr
 * removes e wherever it is, aa with an existing name updates it in place
 * (a same-value write is a replay no-op), ar by a missing name skips, si/sd
 * check the exact substring. That is what makes broadcast-to-all (including
 * the originator) and reconnect replays safe. Ops referencing removed
 * parents or gone attributes are dropped with a warning rather than
 * rejected — the client's own commit always contains sr before any re-sa
 * of the same id, so a lone sa for an existing node is a pathological
 * replay and skipped. Attribute insert positions are transformed against
 * concurrent commits exactly like child indexes (a concurrent insert
 * before shifts right, a concurrent removal before shifts left), so a
 * position is unambiguous given its source revision.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const parse5 = require('parse5');

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_COMMENT = 8;

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
	'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track',
	'wbr']);

// Parents whose content the HTML tokenizer treats as one raw text node.
// This is the spec set (verified identical in Chromium and parse5): the
// generic-raw-text elements plus plaintext, whose content actually runs to
// EOF. Everything inside them travels as characters — a single text node
// with the first text child's identity prefix, everything else in its raw
// serialized form. The browser merges any other shape into exactly that
// node, and the first-paint normalization commits the merge.
// Scripts are additionally neutered so nothing executes before the client
// bundle has booted (the client re-activates and executes them in document
// order). RCDATA contexts (title, textarea) DO decode character references,
// so their text is entity-escaped when served and the parser un-escapes it
// back to the mirror value.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed',
	'noframes', 'noscript', 'plaintext']);
const RCDATA_ELEMENTS = new Set(['title', 'textarea']);

// Transport-only attribute names. They never enter the mirror: the wire
// writer uses them, the paint normalizer unconditionally strips them, and
// validOp rejects ops that try to set them.
const RESERVED_ATTR_NAMES = new Set(['_', 'data-webstrates-head',
	'data-webstrates-type']);

// Element names that cannot survive HTML serialization (the tokenizer
// requires an ASCII-letter start; '/', '>', '=' and whitespace never made it
// into a tag name token). Ops creating them are rejected.
const ELEMENT_NAME_RE = /^[A-Za-z][A-Za-z0-9:_.-]*$/;

const OP_KINDS = new Set(['sa', 'sr', 'aa', 'ar', 'si', 'sd']);

const dataDir = () => {
	const configured = global.config.sqliteDataDir;
	// A relative path (as in the sample config) is anchored to the
	// application, not to whatever directory the process was started from.
	if (!configured) return path.join(global.APP_PATH, 'document-data');
	return path.isAbsolute(configured) ? configured : path.join(global.APP_PATH, configured);
};

const fileBase = (webstrateId) => encodeURIComponent(webstrateId);

// ---------------------------------------------------------------------------
// In-memory mirror of `current`
// ---------------------------------------------------------------------------

/**
 * Create an empty document mirror (just the root node, eid 0).
 * @return {Map} eid → node {p, t, n, kids: [eid],
 *                          attrs: [{n, v}] (ordered; position = index)}
 * @private
 */
function emptyMirror() {
	const nodes = new Map();
	nodes.set(0, { p: -1, t: 0, n: null, kids: [], attrs: [] });
	return nodes;
}

/**
 * Deep-copy a mirror (nodes, kids arrays and attr maps).
 * @param  {Map} nodes Mirror to copy.
 * @return {Map}       Independent copy.
 * @private
 */
function cloneMirror(nodes) {
	const copy = new Map();
	for (const [eid, node] of nodes) {
		copy.set(eid, { p: node.p, t: node.t, n: node.n, kids: node.kids.slice(),
			attrs: node.attrs.map((a) => ({ n: a.n, v: a.v })) });
	}
	return copy;
}

/**
 * Validate the shape of an incoming forward op.
 * @param  {op}   op Op to check.
 * @return {bool}     True if well-formed.
 * @private
 */
function validOp(op) {
	if (!op || typeof op !== 'object' || !OP_KINDS.has(op.k)) return false;
	const int = (v) => Number.isInteger(v) && v >= 0;
	switch (op.k) {
		case 'sa': return int(op.p) && int(op.i) && int(op.e) && op.e > 0 && int(op.t)
			// Element names must survive HTML serialization: the tokenizer
			// requires an ASCII-letter start (see ELEMENT_NAME_RE). Text and
			// comments carry no name.
			&& (op.t === NODE_ELEMENT
				? (typeof op.n === 'string' && ELEMENT_NAME_RE.test(op.n)) : true);
		case 'sr': return int(op.p)
			// Either the exact node (eid form — the usual case), or its
			// position within the parent (position form): a client whose
			// id mapping for the removed node was lost (a duplicate removal
			// record consumed its path node) can still name the slot, and a
			// best-effort positional removal beats silently leaking the node
			// into the mirror — the server resolves the form to the node it
			// actually removes, so the effective op and the inverse are
			// eid-addressed like every other removal.
			&& ((int(op.e) && op.e > 0) || (op.e === undefined && int(op.i)));
		// Attributes are addressed by (eid, local index): the position within
		// that element's own attribute list (0-based, the root element's
		// data-protected sits at index 0 in the spec's example). Text and
		// comment nodes have exactly one attribute — the content — so their
		// ops carry the eid alone (aa with n:null, si/sd with no i). Reserved
		// names are transport-only (_, the head_ marker, the script-unneuter
		// marker): ops setting them are rejected so they can never enter the
		// mirror and collide with the wire format.
		case 'aa': return int(op.e) && op.e > 0
			&& (op.n === null ? true // content: the eid is enough
				: (typeof op.n === 'string'
					&& !RESERVED_ATTR_NAMES.has(op.n.toLowerCase()) && int(op.i)))
			&& typeof op.v === 'string';
		case 'ar': return int(op.e) && op.e > 0
			&& (typeof op.n === 'string' || int(op.i));
		case 'si':
		case 'sd': return int(op.e) && op.e > 0
			&& (op.i === undefined || op.i === null || int(op.i))
			&& int(op.q) && typeof op.v === 'string';
	}
	return false;
}

/**
 * Detach a subtree from a mirror into a stash: the node objects (with kids and
 * attributes intact) are captured so a later sa of the same eid re-attaches
 * the whole subtree cheaply — that is how moves stay sr+sa without losing or
 * re-logging descendants. The root must already be out of its parent's kids.
 * @param {Map}    nodes    Mirror (mutated).
 * @param {number} eid      Subtree root.
 * @param {Map}    detached Stash: eid → Map(eid → node); may be null.
 * @param {[number][]} out  Collector for removed eids (SQL cleanup).
 * @return {Map}            The captured subtree (eid → node).
 * @private
 */
function detachSubtree(nodes, eid, detached, out) {
	const captured = new Map();
	const walk = (e) => {
		const n = nodes.get(e);
		if (!n) return;
		captured.set(e, n);
		if (out) out.push(e);
		for (const child of n.kids) walk(child);
	};
	walk(eid);
	for (const e of captured.keys()) nodes.delete(e);
	if (detached) detached.set(eid, captured);
	return captured;
}

/**
 * Re-attach a stashed subtree into a mirror (inverse of detachSubtree).
 * @param {Map}   nodes    Mirror (mutated).
 * @param {number} eid     Subtree root.
 * @param {Map}   detached Stash: eid → Map(eid → node).
 * @return {Map|null}       The attached subtree (eid → node), or null.
 * @private
 */
function attachSubtree(nodes, eid, detached) {
	if (!detached) return null;
	const captured = detached.get(eid);
	if (!captured) return null;
	detached.delete(eid);
	for (const [e, n] of captured) nodes.set(e, n);
	return captured;
}

/**
 * Append the synthetic re-attach ops for stash re-attachments to a commit's
 * effective ops. When a sa re-attaches a subtree that an EARLIER commit
 * detached (a cross-commit move), the wire ops carry only the root sa — but a
 * client that processed that earlier sr no longer has the subtree and cannot
 * rebuild it. The subtree's struct+state therefore travel as additional
 * effective ops (marked z:true, sharing the root sa's opid) — broadcast and
 * log only, never persisted in history: clients that still hold the subtree
 * skip ops for eids they already know (idempotent), and the cold log rebuild
 * re-derives them the same way. Same-commit detach+re-attach pairs need no
 * synthetics — the subtree never left any client.
 * @param {[op]}   effective           Effective ops of the commit (mutated).
 * @param {Map}    nodes               Post-state mirror.
 * @param {[obj]}  reattaches          {rootEid, rootOpid, eids} per re-attach.
 * @param {Set}    detachedThisCommit  Eids this same commit detached.
 * @private
 */
function appendSyntheticReattachOps(effective, nodes, reattaches,
	detachedThisCommit) {
	for (const { rootEid, rootOpid, eids } of reattaches) {
		for (const eid of eids) {
			if (detachedThisCommit.has(eid)) continue;
			const node = nodes.get(eid);
			if (!node) continue;
			// The root's sa is already in the wire ops (it carries only the
			// node's type/name — its attributes, and every descendant, travel
			// only as synthetics).
			if (eid !== rootEid) {
				const parent = nodes.get(node.p);
				const i = parent && parent.kids.indexOf(eid);
				if (i === undefined || i < 0) continue;
				effective.push({ k: 'sa', p: node.p, i, e: eid, t: node.t, n: node.n,
					opid: rootOpid, z: true });
			}
			node.attrs.forEach((attr, i) => {
				effective.push({ k: 'aa', e: eid, i, n: attr.n, v: attr.v,
					opid: rootOpid, z: true });
			});
		}
	}
}

/**
 * Apply one forward op to a mirror, idempotently and convergently. Returns
 * the applied records: each carries `eff` (the effective op, possibly
 * rewritten, e.g. aa over an existing index becomes [ar, aa]) and `inv` (the
 * inverse op, derived from the pre-state). An empty result means the op was a
 * no-op (replay or missing reference — the latter bumps warn.count).
 *
 * ctx.detached is the move stash: sr captures the removed subtree into it and
 * a following sa of the same eid re-attaches it whole (that is what makes
 * moves cheap — sr+sa with all attribute/content rows surviving untouched).
 * @param {Map}    nodes Mirror (mutated).
 * @param {op}     op    Forward op.
 * @param {object} ctx   {warn: {count}, detached: Map} — both optional.
 * @return {[{eff: op, inv: op, subtree?: [number], reattached?: [number]}]}
 * @private
 */
function applyOpToMirror(nodes, op, ctx) {
	const warn = (ctx && ctx.warn) || { count: 0 };
	const detached = ctx && ctx.detached;
	switch (op.k) {
		case 'sa': {
			const p = nodes.get(op.p);
			if (!p) {
				warn.count++;
				return [];
			}
			if (nodes.has(op.e)) {
				const existing = nodes.get(op.e);
				if (existing.p === op.p && p.kids[op.i] === op.e) return []; // replay
				// A lone sa for an attached node is a transform artifact /
				// replay — moves go through the detach stash instead.
				warn.count++;
				return [];
			}
			const clamped = Math.min(op.i, p.kids.length);
			p.kids.splice(clamped, 0, op.e);
			const reattached = attachSubtree(nodes, op.e, detached);
			let reattachedEids = null;
			let reattachedAttrs = null;
			if (reattached) {
				nodes.get(op.e).p = op.p;
				reattachedEids = [...reattached.keys()];
				// Snapshot the attrs AS RE-ATTACHED. Phase 2 (persistence) runs
				// after the whole commit has been applied to the mirror, so the
				// live node objects no longer hold the attach-time state: later
				// ops in the same commit may already have edited them (their own
				// records write those deltas). Recreating the rows from the
				// snapshot keeps every later ar/aa/si/sd record consistent
				// instead of double-inserting the post state.
				reattachedAttrs = new Map();
				for (const [e, n] of reattached) {
					reattachedAttrs.set(e, n.attrs.map((a) => ({ n: a.n, v: a.v })));
				}
			} else {
				// Fresh node; moves re-attach stashed subtrees instead.
				nodes.set(op.e, { p: op.p, t: op.t, n: op.n, kids: [],
					attrs: [] });
			}
			return [{ eff: { k: 'sa', p: op.p, i: clamped, e: op.e, t: op.t, n: op.n },
				inv: { k: 'sr', p: op.p, e: op.e }, reattached: reattachedEids,
				reattachedAttrs }];
		}
		case 'sr': {
			let eid = op.e;
			if (eid === undefined) {
				// Position form: resolve whatever child holds the slot (clamped,
				// like sa; an empty parent warn-skips — the op can only be a
				// best-effort fallback, never a corruption).
				const p = nodes.get(op.p);
				if (!p || p.kids.length === 0) {
					warn.count++;
					return [];
				}
				eid = p.kids[Math.min(op.i, p.kids.length - 1)];
			}
			const node = nodes.get(eid);
			if (!node || node.p < 0 || !nodes.has(node.p)) {
				warn.count++;
				return [];
			}
			const actualParent = node.p;
			const idx = nodes.get(actualParent).kids.indexOf(eid);
			if (idx === -1) {
				warn.count++;
				return [];
			}
			nodes.get(actualParent).kids.splice(idx, 1);
			const subtree = [];
			detachSubtree(nodes, eid, detached, subtree);
			return [{ eff: { k: 'sr', p: actualParent, e: eid, i: idx },
				inv: { k: 'sa', p: actualParent, i: idx, e: eid, t: node.t, n: node.n },
				subtree }];
		}
		case 'aa': {
			const node = nodes.get(op.e);
			if (!node) {
				warn.count++;
				return [];
			}
			// Text/comment content: the eid addresses it — position 0 is the
			// node's single entry (a fresh sa'd node has none yet).
			if (op.n === null) {
				if (node.t !== NODE_TEXT && node.t !== NODE_COMMENT) {
					warn.count++;
					return [];
				}
				const cur = node.attrs[0];
				if (cur && cur.v === op.v) return []; // replay
				if (cur) {
					node.attrs[0] = { n: null, v: op.v };
					return [{ eff: { k: 'aa', e: op.e, n: null, v: op.v },
						inv: { k: 'au', e: op.e, i: 0, n: null, v: op.v,
							old: cur.v } }];
				}
				node.attrs.push({ n: null, v: op.v });
				return [{ eff: { k: 'aa', e: op.e, n: null, v: op.v },
					inv: { k: 'ar', e: op.e, i: 0, n: null, v: op.v } }];
			}
			// Element attribute, name-anchored: an existing name updates in
			// place (setAttribute semantics — its position never moves); a
			// new name inserts at the given local position, clamped to the
			// current end. DOM attribute creation is append-only, so an
			// honest client's insert position is always the end; the clamp
			// only absorbs degenerate raw-protocol input.
			const pos = node.attrs.findIndex((a) => a.n === op.n);
			if (pos !== -1) {
				const cur = node.attrs[pos];
				if (cur.v === op.v) return []; // replay
				node.attrs[pos] = { n: op.n, v: op.v };
				return [{ eff: { k: 'aa', e: op.e, i: pos, n: op.n, v: op.v },
					inv: { k: 'au', e: op.e, i: pos, n: op.n, v: op.v,
						old: cur.v } }];
			}
			const i = Math.min(Number.isInteger(op.i) ? op.i : node.attrs.length,
				node.attrs.length);
			node.attrs.splice(i, 0, { n: op.n, v: op.v });
			// ins marks an insert for the transform pass: concurrent
			// position-addressed ops on the same element shift past it.
			return [{ eff: { k: 'aa', e: op.e, i, n: op.n, v: op.v, ins: true },
				inv: { k: 'ar', e: op.e, i, n: op.n, v: op.v } }];
		}
		case 'ar': {
			const node = nodes.get(op.e);
			if (!node) {
				warn.count++;
				return [];
			}
			// Name-addressed when the op carries a name (the client always
			// does — it knows it from the mutation record; a missing name is
			// then a plain removal, not a position fallback, so a concurrent
			// removal cannot make it delete an innocent neighbor).
			// Position-addressed only when no name rides along (raw
			// protocol consumers).
			let pos = -1;
			if (typeof op.n === 'string') {
				pos = node.attrs.findIndex((a) => a.n === op.n);
			} else if (Number.isInteger(op.i) && op.i >= 0
				&& op.i < node.attrs.length && node.attrs[op.i].n !== null) {
				pos = op.i;
			}
			if (pos === -1 || node.attrs[pos].n === null) {
				warn.count++; // already gone, or the text content (never removable)
				return [];
			}
			const old = node.attrs[pos];
			node.attrs.splice(pos, 1);
			return [{ eff: { k: 'ar', e: op.e, i: pos, n: old.n },
				inv: { k: 'aa', e: op.e, i: pos, n: old.n, v: old.v } }];
		}
		case 'si': {
			const node = nodes.get(op.e);
			if (!node) {
				warn.count++;
				return [];
			}
			// The target: the content entry for text/comment nodes (an
			// absent i addresses it), the i-th attribute for elements.
			const pos = node.t === NODE_TEXT || node.t === NODE_COMMENT ? 0
				: (Number.isInteger(op.i) && op.i >= 0
					&& op.i < node.attrs.length ? op.i : -1);
			const attr = pos !== -1 ? node.attrs[pos] : null;
			if (!attr || (node.t === NODE_ELEMENT && attr.n === null)) {
				warn.count++;
				return [];
			}
			// No replay check here: an insert whose text coincidentally
			// matches the string at q is a legitimate insert (random typing
			// hits this constantly), and true duplicate delivery cannot
			// happen — the client commits are exactly-once (a transport
			// error rolls the entry back; it is never resent). The old
			// content-match "replay" drop silently ate legitimate inserts,
			// leaving the client's optimistic text permanently divergent.
			const clamped = Math.min(op.q, attr.v.length);
			attr.v = attr.v.slice(0, clamped) + op.v + attr.v.slice(clamped);
			return [{ eff: { k: 'si', e: op.e, i: pos, q: clamped, v: op.v },
				inv: { k: 'sd', e: op.e, i: pos, q: clamped, v: op.v } }];
		}
		case 'sd': {
			const node = nodes.get(op.e);
			if (!node) {
				warn.count++;
				return [];
			}
			const pos = node.t === NODE_TEXT || node.t === NODE_COMMENT ? 0
				: (Number.isInteger(op.i) && op.i >= 0
					&& op.i < node.attrs.length ? op.i : -1);
			const attr = pos !== -1 ? node.attrs[pos] : null;
			if (!attr || (node.t === NODE_ELEMENT && attr.n === null)
				|| attr.v.slice(op.q, op.q + op.v.length) !== op.v) {
				warn.count++;
				return [];
			}
			attr.v = attr.v.slice(0, op.q) + attr.v.slice(op.q + op.v.length);
			return [{ eff: { k: 'sd', e: op.e, i: pos, q: op.q, v: op.v },
				inv: { k: 'si', e: op.e, i: pos, q: op.q, v: op.v } }];
		}
	}
	return [];
}

/**
 * Apply a history row (an inverse op) to a mirror during a backwards walk.
 * Rows are applied in descending opid order, which undoes a commit exactly
 * (children before parents, since forward sa order is parents first). The
 * move stash works exactly as in the forward direction: undoing a forward sa
 * ('sr'-row) detaches, and the matching undo of the forward sr ('sa'-row)
 * re-attaches the stashed subtree — so a move undoes to a move.
 * @param {Map}  nodes Mirror (mutated).
 * @param {row}  row   History row {k, p, i, e, t, n, x, q, v}.
 * @param {Map}  ctx   {detached: Map} stash — optional.
 * @private
 */
function applyInverseToMirror(nodes, row, ctx) {
	const detached = ctx && ctx.detached;
	switch (row.k) {
		case 'sr': { // undoes a forward sa: remove the child
			if (process.env.DS_WALK_TRACE) {
				const pp = nodes.get(row.p);
				console.error('walk sr row', row.opid, 'e=' + row.e, 'p=' + row.p,
					'p-present=' + !!pp, 'idx=' + (pp ? pp.kids.indexOf(row.e) : 'n/a'));
			}
			const p = nodes.get(row.p);
			const idx = p ? p.kids.indexOf(row.e) : -1;
			if (idx !== -1) {
				p.kids.splice(idx, 1);
				detachSubtree(nodes, row.e, detached);
			}
			break;
		}
		case 'sa': { // undoes a forward sr: re-add the child (stashed if moved)
			if (process.env.DS_WALK_TRACE) {
				console.error('walk sa row', row.opid, 'e=' + row.e,
					'payload=' + !!(ctx && ctx.payloads && ctx.payloads.get(row.opid)),
					'stash=' + !!(detached && detached.get(row.e)),
					'p=' + row.p, 'p-present=' + !!nodes.get(row.p),
					'e-present=' + nodes.has(row.e),
					'i=' + row.i, 'len=' + (nodes.get(row.p) ? nodes.get(row.p).kids.length : -1));
			}
			const p = nodes.get(row.p);
			if (!p || nodes.has(row.e)) break;
			const clamped = Math.min(row.i, p.kids.length);
			p.kids.splice(clamped, 0, row.e);
			// A pure removal's subtree is re-materialized from the removal's
			// payload row — the inverse row alone only carries the root node
			// (descendants have no inverse rows of their own). The payload is
			// checked FIRST: undoing pre-order adds leaf-first leaves gutted
			// fragments in the walk stash (a parent detached after its
			// children, so its stash entry has empty kids), and a stash hit
			// would then resurrect the parent without descendants. Same-commit
			// move pairs never write payloads, so they still bridge via the
			// stash below.
			const payload = ctx && ctx.payloads && ctx.payloads.get(row.opid);
			const attached = payload ? null : attachSubtree(nodes, row.e, detached);
			if (payload) {
				for (const [eid, t, n, parentId, kids, attrs] of payload) {
					nodes.set(eid, { p: parentId, t, n, kids,
						attrs: attrs.map(([attrName, v]) => ({ n: attrName, v })) });
				}
			} else if (attached) {
				nodes.get(row.e).p = row.p;
			} else {
				// Pre-payload history: best effort (root only, empty).
				nodes.set(row.e, { p: row.p, t: row.t, n: row.n, kids: [],
					attrs: [] });
			}
			break;
		}
		case 'ar': { // undoes a forward aa insert: remove the attribute
			const node = nodes.get(row.e);
			if (!node) break;
			if (row.n === null) {
				// Content entry: the node's single attribute.
				if (node.attrs.length > 0 && node.attrs[0].n === null) {
					node.attrs.shift();
				}
				break;
			}
			const pos = node.attrs.findIndex((a) => a.n === row.n);
			if (pos !== -1) node.attrs.splice(pos, 1);
			break;
		}
		case 'aa': { // undoes a forward ar: re-add the attribute at its position
			const node = nodes.get(row.e);
			if (!node || row.n === null) break;
			if (node.attrs.some((a) => a.n === row.n)) break; // idempotent
			const i = Math.min(Number.isInteger(row.i) ? row.i : node.attrs.length,
				node.attrs.length);
			node.attrs.splice(i, 0, { n: row.n, v: row.v });
			break;
		}
		case 'au': { // undoes a forward aa update: restore the old value in place
			const node = nodes.get(row.e);
			if (!node) break;
			if (row.n === null) {
				if (node.attrs.length > 0 && node.attrs[0].n === null) {
					node.attrs[0] = { n: null, v: row.old !== undefined ? row.old : row.v };
				}
				break;
			}
			const pos = node.attrs.findIndex((a) => a.n === row.n);
			if (pos !== -1) {
				node.attrs[pos] = { n: row.n, v: row.old !== undefined ? row.old : row.v };
			}
			break;
		}
		case 'sd': { // undoes a forward si: remove the inserted string
			const attr = nodes.get(row.e)?.attrs[row.i];
			if (attr && attr.v.slice(row.q, row.q + row.v.length) === row.v) {
				attr.v = attr.v.slice(0, row.q) + attr.v.slice(row.q + row.v.length);
			}
			break;
		}
		case 'si': { // undoes a forward sd: re-insert the deleted string
			const attr = nodes.get(row.e)?.attrs[row.i];
			if (attr) {
				const clamped = Math.min(row.q, attr.v.length);
				attr.v = attr.v.slice(0, clamped) + row.v + attr.v.slice(clamped);
			}
			break;
		}
	}
}

/**
 * Turn a history row into the forward op it inverts (for the op log API and
 * transform sources).
 * @param  {row} row History row.
 * @return {op}     Forward op.
 * @private
 */
function rowToForwardOp(row) {
	switch (row.k) {
		case 'sr': return { k: 'sa', p: row.p, i: row.i, e: row.e, t: row.t, n: row.n };
		case 'sa': return { k: 'sr', p: row.p, e: row.e, i: row.i };
		// 'ar' rows invert an aa insert, 'au' rows an aa update — both
		// reconstruct as an aa; the replay re-derives insert-ness from
		// name-absence on its scratch mirror, so transform sources stay
		// identical warm (log) and cold (history).
		case 'ar':
		case 'au': return { k: 'aa', e: row.e, i: row.i, n: row.n, v: row.v };
		case 'aa': return { k: 'ar', e: row.e, i: row.i, n: row.n };
		case 'sd': return { k: 'si', e: row.e, i: row.i, q: row.q, v: row.v };
		case 'si': return { k: 'sd', e: row.e, i: row.i, q: row.q, v: row.v };
	}
}

// ---------------------------------------------------------------------------
// Transform (OT-lite): rewrite ops based on `base` against committed ops
// ---------------------------------------------------------------------------

/**
 * Transform one op against one already-committed op (both relative to the same
 * preceding state). Returns an array (an sd split by a concurrent insert or
 * overlap becomes two ops, a fully covered op becomes none). Positions only;
 * existence (removed parents, gone attributes) is left to the idempotent
 * applier, which skips and warns.
 * @param  {op}  op    Our op (not mutated).
 * @param  {op}  other Committed op.
 * @return {[op]}     Transformed op(s).
 * @private
 */
function transformAgainst(op, other) {
	// Attribute positions are local (per-element) and shift under concurrent
	// attribute ops on the same element: an INSERT (an aa whose name was new
	// — marked `ins` on the effective op, re-derived on history replay by
	// name-absence) shifts later positions right, a REMOVAL shifts later
	// positions left. Updates (an existing name) and string edits move
	// nothing. Element-child positions are unaffected by attribute ops.
	const attrShift = (op) => {
		if (other.e !== op.e || !Number.isInteger(op.i)) return op;
		if (other.k === 'aa' && other.ins === true
			&& Number.isInteger(other.i) && other.i <= op.i) {
			return { ...op, i: op.i + 1 };
		}
		if (other.k === 'ar' && Number.isInteger(other.i) && other.i < op.i) {
			return { ...op, i: op.i - 1 };
		}
		return op;
	};
	switch (op.k) {
		case 'sa': {
			if (other.k === 'sa' && other.p === op.p && other.i <= op.i) {
				return [{ ...op, i: op.i + 1 }];
			}
			if (other.k === 'sr' && other.p === op.p && other.i < op.i) {
				return [{ ...op, i: op.i - 1 }];
			}
			return [op];
		}
		case 'sr':
			// Eid form: id-based, no positions. A POSITION form (the client's
			// lost-id fallback) shifts under concurrent inserts/removals in the
			// same parent, and voids when its exact slot was concurrently
			// removed — the same rules the position-addressed ar follows.
			if (op.e === undefined && Number.isInteger(op.i)) {
				if (other.k === 'sr' && other.p === op.p && other.i === op.i) {
					return [];
				}
				if (other.k === 'sa' && other.p === op.p
					&& Number.isInteger(other.i) && other.i <= op.i) {
					return [{ ...op, i: op.i + 1 }];
				}
				if (other.k === 'sr' && other.p === op.p && other.i < op.i) {
					return [{ ...op, i: op.i - 1 }];
				}
			}
			return [op];
		case 'aa': {
			if (op.n === null || !Number.isInteger(op.i)) return [op];
			// Content replaces carry no positions; name-anchored updates
			// resolve at apply regardless of their advisory index — but an
			// insert must keep pointing at its (append) slot.
			if (other.k === 'aa' && other.ins === true && other.e === op.e
				&& Number.isInteger(other.i) && other.i <= op.i) {
				return [{ ...op, i: op.i + 1 }];
			}
			if (other.k === 'ar' && other.e === op.e && other.i < op.i) {
				return [{ ...op, i: op.i - 1 }];
			}
			return [op];
		}
		case 'ar': {
			if (!Number.isInteger(op.i)) return [op];
			// A name-addressed ar is resolved by name at apply (a missing
			// name skips) — only its advisory index shifts. A position-
			// addressed ar whose exact slot was concurrently removed is void.
			if (other.k === 'ar' && other.e === op.e && other.i === op.i
				&& typeof op.n !== 'string') {
				return [];
			}
			const shifted = attrShift(op);
			return shifted === op ? [op] : [shifted];
		}
		case 'si': {
			// The target identity is (eid, position) — text ops carry no
			// position (undefined) while the server's effective ops
			// normalize a text node's content slot to 0; both name the
			// same target, so identity compares undefined/null as 0. A
			// node is either a text/comment or an element, so the pair
			// cannot collide across kinds. A concurrently removed target
			// voids the edit; the position shift then follows (a void
			// check on the shifted index would falsely match the neighbor
			// that moved into the removed slot).
			const slot = (o) => (o.i === undefined || o.i === null ? 0 : o.i);
			if (op.i !== undefined && other.k === 'ar' && other.e === op.e
				&& other.i === op.i) {
				return [];
			}
			op = attrShift(op);
			if (other.k === 'si' && other.e === op.e && slot(other) === slot(op)) {
				// Committed-first wins the left slot at equal positions.
				if (other.q <= op.q) return [{ ...op, q: op.q + other.v.length }];
				return [op];
			}
			if (other.k === 'sd' && other.e === op.e && slot(other) === slot(op)) {
				if (other.q + other.v.length <= op.q) return [{ ...op, q: op.q - other.v.length }];
				if (other.q <= op.q) return [{ ...op, q: other.q }];
				return [op];
			}
			return [op];
		}
		case 'sd': {
			const slot = (o) => (o.i === undefined || o.i === null ? 0 : o.i);
			if (op.i !== undefined && other.k === 'ar' && other.e === op.e
				&& other.i === op.i) {
				return [];
			}
			op = attrShift(op);
			if (other.k === 'si' && other.e === op.e && slot(other) === slot(op)) {
				const end = op.q + op.v.length;
				if (other.q <= op.q) return [{ ...op, q: op.q + other.v.length }];
				if (other.q < end) {
					// Their insert splits our delete: keep both sides.
					return [
						{ k: 'sd', e: op.e, i: op.i, q: op.q, v: op.v.slice(0, other.q - op.q) },
						{ k: 'sd', e: op.e, i: op.i, q: other.q + other.v.length,
							v: op.v.slice(other.q - op.q) }
					].filter((piece) => piece.v.length > 0);
				}
				return [op];
			}
			if (other.k === 'sd' && other.e === op.e && slot(other) === slot(op)) {
				const oEnd = other.q + other.v.length, end = op.q + op.v.length;
				if (oEnd <= op.q) return [{ ...op, q: op.q - other.v.length }];
				if (other.q >= end) return [op];
				// Overlap: theirs is committed, so drop our chars inside it.
				if (other.q <= op.q) {
					if (oEnd >= end) return []; // ours fully covered
					return [{ k: 'sd', e: op.e, i: op.i, q: other.q,
						v: op.v.slice(oEnd - op.q) }];
				}
				const pieces = [
					{ k: 'sd', e: op.e, i: op.i, q: op.q, v: op.v.slice(0, other.q - op.q) },
					...(oEnd < end
						? [{ k: 'sd', e: op.e, i: op.i, q: other.q,
							v: op.v.slice(oEnd - op.q) }]
						: [])
				];
				return pieces.filter((piece) => piece.v.length > 0);
			}
			return [op];
		}
	}
	return [op];
}

/**
 * Transform a list of ops against a sequence of commits (each with its final
 * effective ops, in commit order) that landed since the ops' base.
 * @param  {[op]}    ops     Ops to transform (not mutated).
 * @param  {[{ops}]} commits Intervening commits, oldest first.
 * @return {{ops: [op], xformed: bool}}
 * @private
 */
function transformOps(ops, commits) {
	let xformed = false;
	let work = ops.slice();
	for (const commit of commits) {
		for (const other of commit.ops) {
			const next = [];
			for (const op of work) {
				const results = transformAgainst(op, other);
				if (results.length !== 1 || results[0] !== op) xformed = true;
				next.push(...results);
			}
			work = next;
		}
	}
	return { ops: work, xformed };
}

// ---------------------------------------------------------------------------
// Handle: one open webstrate (SQLite connection + mirror + log cache)
// ---------------------------------------------------------------------------

const handles = new Map(); // webstrateId → handle
const MAX_OPEN_HANDLES = 128;

class Handle {
	constructor(webstrateId) {
		this.id = webstrateId;
		this.refCount = 0;
		this.log = []; // [{v, base, ops, src, userId, timestamp}] — newest last
		this.logFirstV = null; // v of this.log[0]; null → cold (read from SQL)
		// Move stash (see detachSubtree): detached subtrees awaiting a sa.
		// Capped so a pathological remove-never-re-add pattern cannot grow it
		// without bound (the oldest entries are dropped first).
		this.detached = new Map();

		const dir = dataDir();
		fs.mkdirSync(dir, { recursive: true });
		const currentPath = path.join(dir, fileBase(webstrateId) + '.current');
		const historyPath = path.join(dir, fileBase(webstrateId) + '.history');

		this.conn = new DatabaseSync(currentPath);
		this.conn.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			ATTACH '${historyPath.replace(/'/g, '\'\'')}' AS history;
			PRAGMA history.journal_mode = WAL;
			PRAGMA history.busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS domStruct (
				parentId INTEGER NOT NULL,
				childIndex INTEGER NOT NULL,
				childId INTEGER NOT NULL UNIQUE,
				type INTEGER NOT NULL,
				name TEXT,
				PRIMARY KEY (parentId, childIndex)
			);
			CREATE TABLE IF NOT EXISTS domState (
				eid INTEGER NOT NULL,
				attrIndex INTEGER NOT NULL,
				name TEXT,
				value TEXT NOT NULL,
				PRIMARY KEY (eid, attrIndex)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_domstate_name
				ON domState(eid, name) WHERE name IS NOT NULL;
			CREATE TABLE IF NOT EXISTS tags (
				label TEXT PRIMARY KEY,
				opid INTEGER NOT NULL UNIQUE,
				timestamp INTEGER
			);
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER);
			CREATE TABLE IF NOT EXISTS history.domStructOps (
				opid INTEGER PRIMARY KEY,
				kind TEXT NOT NULL,
				parentId INTEGER,
				childIndex INTEGER,
				childId INTEGER,
				type INTEGER,
				name TEXT
			);
			CREATE TABLE IF NOT EXISTS history.domStateOps (
				opid INTEGER PRIMARY KEY,
				kind TEXT NOT NULL,
				eid INTEGER,
				attrIndex INTEGER,
				pos INTEGER,
				name TEXT,
				value TEXT,
				oldValue TEXT
			);
			CREATE TABLE IF NOT EXISTS history.commits (
				opid INTEGER PRIMARY KEY,
				userId TEXT,
				source TEXT,
				timestamp INTEGER,
				label TEXT
			);
			-- Re-materialization payloads for REMOVED subtrees. A forward sr of a
			-- subtree stores one inverse row (re-add the root) whose opid keys a row
			-- here holding the whole captured subtree (nodes+attrs), so the backward
			-- walk (snapshotAt) can resurrect descendants — they never have inverse
			-- rows of their own. Moves never write payloads: their sr/sa pair is
			-- bridged by the walk's own stash. CREATE IF NOT EXISTS, so pre-existing
			-- history DBs pick the table up on next open (payloads missing for old
			-- removals — those walks keep the old, lossy behavior).
			CREATE TABLE IF NOT EXISTS history.subtrees (
				opid INTEGER PRIMARY KEY,
				payload TEXT NOT NULL
			);
		`);
		// Schema migration: `history.domStateOps.oldValue` was added after
		// the fleet existed — CREATE TABLE IF NOT EXISTS never migrates a
		// pre-existing table, so every history DB created before the
		// column fails its state-op reads with "no such column:
		// oldValue" (179 of the 264-DB audit corpus). ALTER TABLE ADD
		// COLUMN is metadata-only and old rows read as NULL, which every
		// consumer already tolerates (`old: r.oldValue`). No other table
		// has late columns (commits/domStructOps are uniform across the
		// corpus); history.subtrees is a whole-table late addition that
		// the CREATE IF NOT EXISTS above handles (with the documented
		// lossy-payload caveat for old removals).
		if (!this.conn.prepare('PRAGMA history.table_info(domStateOps)')
			.all().some((col) => col.name === 'oldValue')) {
			this.conn.exec('ALTER TABLE history.domStateOps '
				+ 'ADD COLUMN oldValue TEXT');
		}

		this.stmt = {
			structRows: this.conn.prepare('SELECT parentId, childIndex, childId, type, ' +
				'name FROM domStruct ORDER BY parentId, childIndex'),
			// ORDER BY eid, attrIndex: attribute indexes are LOCAL positions,
			// and every consumer (the loader's ordered array, the structure
			// payload's jml props order) relies on the per-element order.
			stateRows: this.conn.prepare('SELECT eid, attrIndex, name, value FROM domState '
				+ 'ORDER BY eid, attrIndex'),
			insertStruct: this.conn.prepare('INSERT INTO domStruct ' +
				'(parentId, childIndex, childId, type, name) VALUES (?, ?, ?, ?, ?)'),
			deleteParentRows: this.conn.prepare('DELETE FROM domStruct WHERE parentId = ?'),
			deleteStructRow: this.conn.prepare('DELETE FROM domStruct WHERE childId = ?'),
			deleteStateRows: this.conn.prepare('DELETE FROM domState WHERE eid = ?'),
			insertState: this.conn.prepare('INSERT INTO domState ' +
				'(eid, attrIndex, name, value) VALUES (?, ?, ?, ?)'),
			setState: this.conn.prepare('UPDATE domState SET value = ? ' +
				'WHERE eid = ? AND attrIndex = ?'),
			nextId: this.conn.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ' +
				'ON CONFLICT(key) DO UPDATE SET value = value + ? RETURNING value'),
			bumpNextId: this.conn.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ' +
				'ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)'),
			getMeta: this.conn.prepare('SELECT value FROM meta WHERE key = ?'),
			setMeta: this.conn.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ' +
				'ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
			maxCommit: this.conn.prepare('SELECT MAX(opid) AS m FROM history.commits'),
			invStructRows: this.conn.prepare('SELECT opid, kind, parentId, childIndex, ' +
				'childId, type, name FROM history.domStructOps WHERE opid > ? AND opid <= ?'),
			invStateRows: this.conn.prepare('SELECT opid, kind, eid, attrIndex, pos, ' +
				'name, value, oldValue FROM history.domStateOps WHERE opid > ? AND opid <= ?'),
			allStructOps: this.conn.prepare('SELECT opid, kind, parentId, childIndex, ' +
				'childId, type, name FROM history.domStructOps ORDER BY opid'),
			allStateOps: this.conn.prepare('SELECT opid, kind, eid, attrIndex, pos, ' +
				'name, value, oldValue FROM history.domStateOps ORDER BY opid'),
			commitRows: this.conn.prepare('SELECT opid, userId, source, timestamp, label ' +
				'FROM history.commits ORDER BY opid'),
			insertStructOp: this.conn.prepare('INSERT INTO history.domStructOps ' +
				'(opid, kind, parentId, childIndex, childId, type, name) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?)'),
			insertStateOp: this.conn.prepare('INSERT INTO history.domStateOps ' +
				'(opid, kind, eid, attrIndex, pos, name, value, oldValue) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
			insertCommit: this.conn.prepare('INSERT INTO history.commits ' +
				'(opid, userId, source, timestamp, label) VALUES (?, ?, ?, ?, ?)'),
			insertSubtreePayload: this.conn.prepare('INSERT INTO history.subtrees ' +
				'(opid, payload) VALUES (?, ?)'),
			subtreePayloadsInRange: this.conn.prepare('SELECT opid, payload FROM ' +
				'history.subtrees WHERE opid > ? AND opid <= ?'),
			getTag: this.conn.prepare('SELECT label, opid, timestamp FROM tags WHERE label = ?'),
			tagForOpid: this.conn.prepare('SELECT label, opid, timestamp FROM tags WHERE opid = ?'),
			allTags: this.conn.prepare('SELECT label, opid, timestamp FROM tags ORDER BY opid'),
			upsertTag: this.conn.prepare('INSERT INTO tags (label, opid, timestamp) ' +
				'VALUES (?, ?, ?) ON CONFLICT(label) DO UPDATE SET opid = excluded.opid, ' +
				'timestamp = excluded.timestamp'),
			deleteTagByLabel: this.conn.prepare('DELETE FROM tags WHERE label = ?'),
			deleteTagByOpid: this.conn.prepare('DELETE FROM tags WHERE opid = ?')
		};

		this.nodes = emptyMirror();
		this._load();
		this.revision = this.stmt.maxCommit.get().m || 0;
	}

	_load() {
		const rows = this.stmt.structRows.all();
		for (const row of rows) {
			this.nodes.set(row.childId, { p: row.parentId, t: row.type, n: row.name,
				kids: [], attrs: [] });
		}
		// rows arrive ORDER BY parentId, childIndex — child order per parent is
		// preserved within a parent's row sequence, so group them.
		const byParent = new Map();
		for (const row of rows) {
			if (!byParent.has(row.parentId)) byParent.set(row.parentId, []);
			byParent.get(row.parentId).push(row.childId);
		}
		for (const [p, kids] of byParent) {
			const node = this.nodes.get(p);
			if (node) node.kids = kids;
		}
		// State rows arrive ORDER BY eid, attrIndex — pushed in order, the
		// array positions ARE the loaded local indexes (a gap — a database
		// from a pre-local-index format — compacts silently).
		for (const row of this.stmt.stateRows.all()) {
			const node = this.nodes.get(row.eid);
			if (!node) continue;
			node.attrs.push({ n: row.name, v: row.value });
		}
	}

	_logIsWarm(base) {
		// The in-memory log covers all commits with v > base iff it is not cold
		// and its oldest entry's v is the very next commit after base.
		return this.logFirstV !== null && this.logFirstV <= base + 1;
	}

	close() {
		try {
			this.conn.close();
		} catch (err) {
			console.error(`DocumentStore: closing ${this.id}:`, err.message);
		}
	}

	// -- ids -------------------------------------------------------------------

	/**
	 * Allocate a block of ids from the document's global counter. Clients
	 * mint element ids from their block; the server never rewrites
	 * references. (Attributes no longer draw ids — they are identified by
	 * name plus local position.)
	 * @param  {number} count Number of ids wanted.
	 * @return {{start, end}} Inclusive block.
	 * @public
	 */
	allocIds(count) {
		const c = Math.max(1, Math.min(1024 * 1024, Math.floor(count) || 1));
		const after = this.stmt.nextId.get('nextId', c, c).value;
		return { start: after - c + 1, end: after };
	}

	// -- meta ---------------------------------------------------------------------

	/**
	 * Read a small integer flag from the meta table (undefined when absent).
	 * Used for the paint-stability revision, the marker that the document's
	 * mirror re-parses to itself so renders can skip the normalization pass.
	 * @param  {string} key Meta key.
	 * @return {number|undefined}
	 * @public
	 */
	getMeta(key) {
		const row = this.stmt.getMeta.get(key);
		return row === undefined ? undefined : row.value;
	}

	/**
	 * Write a small integer flag to the meta table.
	 * @param {string} key   Meta key.
	 * @param {number} value Integer value.
	 * @public
	 */
	setMeta(key, value) {
		this.stmt.setMeta.run(key, Number(value) | 0);
	}

	// -- commits -----------------------------------------------------------------

	/**
	 * Commits with v > base, oldest first — the transform source. Served from
	 * the in-memory log when it reaches back that far, otherwise reconstructed
	 * from the history tables (rows invert to forward ops), which also warms
	 * the log.
	 * @param  {number}    base Base revision.
	 * @return {[{v, base, ops, src, userId, timestamp}]}
	 * @private
	 */
	commitsSince(base) {
		if (this._logIsWarm(base)) {
			return this.log.filter((entry) => entry.v > base);
		}
		const commits = [];
		let prev = 0;
		const rows = new Map(); // opid → row (kind of the INVERSE)
		for (const r of this.stmt.allStructOps.all()) {
			rows.set(r.opid, { k: r.kind, p: r.parentId, i: r.childIndex, e: r.childId,
				t: r.type, n: r.name });
		}
		for (const r of this.stmt.allStateOps.all()) {
			rows.set(r.opid, { k: r.kind, e: r.eid, i: r.attrIndex, q: r.pos, n: r.name,
				v: r.value, old: r.oldValue });
		}
		// Replay the whole history on a scratch mirror so the rebuilt log
		// matches what live applyCommit produced — including the synthetic
		// re-attach ops, which are never persisted but must be re-derivable
		// for late subscribers (getOps resync) and transforms after a cold
		// start.
		const scratch = emptyMirror();
		const scratchCtx = { warn: { count: 0 }, detached: new Map() };
		for (const c of this.stmt.commitRows.all()) {
			const ops = [];
			const detachedThisCommit = new Set();
			const reattaches = [];
			for (let opid = prev + 1; opid < c.opid; opid++) {
				const row = rows.get(opid);
				if (!row) continue;
				const forward = rowToForwardOp(row);
				for (const record of applyOpToMirror(scratch, forward, scratchCtx)) {
					ops.push({ ...record.eff, opid });
					if (record.subtree) {
						for (const eid of record.subtree) detachedThisCommit.add(eid);
					}
					if (record.reattached) {
						reattaches.push({ rootEid: record.eff.e, rootOpid: opid,
							eids: record.reattached });
					}
				}
			}
			appendSyntheticReattachOps(ops, scratch, reattaches, detachedThisCommit);
			commits.push({ v: c.opid, base: prev, ops, src: c.source, userId: c.userId,
				timestamp: c.timestamp });
			prev = c.opid;
		}
		// Warm the in-memory log (keep the newest 1024 commits).
		this.log = commits.slice(-1024);
		this.logFirstV = this.log.length > 0 ? this.log[0].v : null;
		return commits.filter((entry) => entry.v > base);
	}

	/**
	 * Apply a client commit: transform against commits since `base`, apply the
	 * effective ops to the mirror, write current + history in one transaction,
	 * append to the log.
	 * @param  {number} base   Revision the ops were based on.
	 * @param  {[op]}   ops    Forward ops.
	 * @param  {string} userId Committing user.
	 * @param  {string} source Source (socketId or userId).
	 * @return {{v, firstOpid, ops, xformed}} New revision and final ops.
	 * @public
	 */
	applyCommit({ base, ops, userId, source }) {
		if (!Number.isInteger(base) || base < 0 || base > this.revision) {
			throw new Error(`Invalid base revision ${base} (head is ${this.revision}).`);
		}
		for (const op of ops) {
			if (!validOp(op)) throw new Error(`Invalid op: ${JSON.stringify(op)}`);
		}

		let finalOps = ops;
		let xformed = false;
		if (base < this.revision) {
			const others = this.commitsSince(base);
			({ ops: finalOps, xformed } = transformOps(ops, others));
			if (others.length > 0) xformed = true;
		}

		const firstOpid = this.revision + 1;
		const warn = { count: 0 };
		const ctx = { warn, detached: this.detached };
		const effective = [];
		const invStruct = [];
		const invState = [];
		const timestamp = Date.now();

		let commitOpid;
		this.conn.exec('BEGIN IMMEDIATE');
		try {
			// Phase 1: apply the (transformed) ops to the mirror in order,
			// collecting records (one per effective op; opids are assigned
			// to EFFECTIVE ops below).
			const records = [];
			for (const op of finalOps) {
				records.push(...applyOpToMirror(this.nodes, op, ctx));
			}
			commitOpid = firstOpid + records.length; // commit row gets its own opid

			// Phase 2: persist. The mirror is already at the post state, and
			// every si/sd read uses it. domStruct writes are batched per
			// parent (dirtyParents) and domState writes per element
			// (dirtyAttrEids): rebuilding each affected set once per commit
			// instead of once per op keeps a 1000-append commit O(n), not
			// O(n²) — and an attribute list whose positions shifted (an
			// insert or removal spliced the ordered array) is rewritten
			// dense, in order, from the post state.
			const dirtyParents = new Set();
			const dirtyAttrEids = new Set();
			const detachedThisCommit = new Set();
			const reattaches = [];
			const pendingSubtreePayloads = [];
			for (let k = 0; k < records.length; k++) {
				const opid = firstOpid + k;
				const eff = { ...records[k].eff, opid };
				effective.push(eff);
				this._persist(eff, records[k].inv, opid, records[k], invStruct,
					invState, dirtyParents, dirtyAttrEids, pendingSubtreePayloads);
				if (records[k].subtree) {
					for (const eid of records[k].subtree) detachedThisCommit.add(eid);
				}
				if (records[k].reattached) {
					reattaches.push({ rootEid: records[k].eff.e, rootOpid: opid,
						eids: records[k].reattached });
				}
			}
			appendSyntheticReattachOps(effective, this.nodes, reattaches,
				detachedThisCommit);
			for (const parentId of dirtyParents) {
				this._rebuildParentRows(parentId);
			}
			for (const eid of dirtyAttrEids) {
				this._rebuildStateRows(eid);
			}
			for (const row of invStruct) {
				this.stmt.insertStructOp.run(row.opid, row.kind, row.parentId,
					row.childIndex, row.childId, row.type, row.name);
			}
			for (const row of invState) {
				this.stmt.insertStateOp.run(row.opid, row.kind, row.eid, row.attrIndex,
					row.pos, row.name, row.value, row.oldValue);
			}
			// Pure subtree removals (still detached at commit end) get a payload
			// row keyed by the removal's inverse opid, so snapshotAt can
			// re-materialize the descendants. Subtrees re-attached within this
			// commit (moves) left the stash and need nothing.
			for (const { opid, e } of pendingSubtreePayloads) {
				const captured = this.detached.get(e);
				if (!captured) continue;
				const payload = [];
				for (const [eid, node] of captured) {
					payload.push([eid, node.t, node.n, node.p,
						node.kids.slice(),
						node.attrs.map((a) => [a.n, a.v])]);
				}
				this.stmt.insertSubtreePayload.run(opid, JSON.stringify(payload));
			}
			this.stmt.insertCommit.run(commitOpid, userId, source, timestamp, null);
			this.conn.exec('COMMIT');
			this._stashPrune();
		} catch (err) {
			this.conn.exec('ROLLBACK');
			// The mirror may be ahead of the database — reload from current.
			this.nodes = emptyMirror();
			this._load();
			this.revision = this.stmt.maxCommit.get().m || 0;
			this.log = [];
			this.logFirstV = null;
			throw err;
		}

		if (warn.count > 0) {
			console.warn(`DocumentStore: ${warn.count} op(s) skipped (missing ` +
				`parent/node/attr) in commit to ${this.id} based on ${base}.`);
		}

		this.revision = commitOpid;
		const entry = { v: commitOpid, base, ops: effective, src: source, userId,
			timestamp };
		this.log.push(entry);
		if (this.log.length > 1024) {
			this.log.splice(0, this.log.length - 1024);
		}
		this.logFirstV = this.log[0].v;

		return { v: commitOpid, firstOpid, ops: effective, xformed, src: source };
	}

	/**
	 * Write the `current` rows for one effective op and queue its inverse row.
	 * Called with the mirror already updated (post-state). A parent's domStruct
	 * rows are NOT written here — the caller collects the parent in
	 * dirtyParents and rebuilds each affected parent once per commit (see
	 * applyCommit), which keeps sibling-heavy commits O(n); an element's
	 * domState rows likewise go through dirtyAttrEids.
	 * @param {op}     eff       Effective forward op (carries opid).
	 * @param {op}     inv       Its inverse (carries pre-state data).
	 * @param {number} opid      Opid of this op.
	 * @param {record} record    The applier record ({subtree, reattached}).
	 * @param {[row]}  invStruct Inverse struct-row queue (mutated).
	 * @param {[row]}  invState  Inverse state-row queue (mutated).
	 * @param {Set}    dirtyParents Parents whose child rows need a rebuild.
	 * @param {Set}    dirtyAttrEids Elements whose attribute rows need a rebuild.
	 * @private
	 */
	_persist(eff, inv, opid, record, invStruct, invState, dirtyParents,
		dirtyAttrEids, pendingSubtreePayloads) {
		switch (eff.k) {
			case 'sa':
				dirtyParents.add(eff.p);
				if (record.reattached) {
					// A stashed (moved) subtree was re-attached: rewrite every
					// descendant's struct+state rows, at the AS-ATTACHED state
					// (record.reattachedAttrs — the live mirror may already hold
					// this commit's later edits, which write their own rows).
					// The root's own row is written by the deferred rebuild of
					// eff.p; skip it here.
					for (const eid of record.reattached) {
						if (eid !== eff.e) this._insertSubtreeRow(eid);
						const snap = record.reattachedAttrs
							&& record.reattachedAttrs.get(eid);
						const attrs = snap !== undefined ? snap
							: this.nodes.get(eid).attrs;
						attrs.forEach((a, i) => {
							this.stmt.insertState.run(eid, i, a.n, a.v);
						});
					}
				}
				invStruct.push({ opid, kind: 'sr', parentId: eff.p, childIndex: eff.i,
					childId: eff.e, type: eff.t, name: eff.n });
				break;
			case 'sr':
				for (const eid of (record.subtree || [eff.e])) {
					this.stmt.deleteStructRow.run(eid);
					this.stmt.deleteStateRows.run(eid);
				}
				dirtyParents.add(eff.p);
				invStruct.push({ opid, kind: 'sa', parentId: eff.p, childIndex: eff.i,
					childId: eff.e, type: inv.t, name: inv.n });
				// A pure subtree removal: remember it so a payload row can be
				// written at commit end if nothing re-attached the subtree in the
				// meantime (the walk needs it to resurrect descendants AND the
				// removed nodes' attributes — single-node removals too: a leaf
				// text node's content lives in its nameless attr, and the sr
				// writes no state-inverse rows of its own, so without a payload
				// the walk would resurrect it empty).
				if (record.subtree) {
					pendingSubtreePayloads.push({ opid, e: eff.e });
				}
				break;
			case 'aa': {
				// Insert ('ar' row undoes it) or update ('au' row restores the
				// pre-value) — for text/comment content the position is 0.
				const i = eff.n === null ? 0 : eff.i;
				dirtyAttrEids.add(eff.e);
				invState.push({ opid, kind: inv.k, eid: eff.e, attrIndex: i,
					pos: null, name: eff.n,
					value: inv.k === 'au' ? eff.v : inv.v,
					oldValue: inv.k === 'au' ? inv.old : null });
				break;
			}
			case 'ar':
				dirtyAttrEids.add(eff.e);
				invState.push({ opid, kind: 'aa', eid: eff.e, attrIndex: eff.i,
					pos: null, name: inv.n, value: inv.v, oldValue: null });
				break;
			case 'si':
			case 'sd':
				// A string edit never moves an attribute: the row at the
				// position keeps its key; the deferred rebuild rewrites the
				// value from the post state.
				dirtyAttrEids.add(eff.e);
				invState.push({ opid, kind: inv.k, eid: eff.e, attrIndex: eff.i,
					pos: eff.q, name: null, value: eff.v, oldValue: null });
				break;
		}
	}

	/**
	 * Rewrite all domState rows of one element from the mirror (dense local
	 * positions, the mirror's attribute order).
	 * @param {number} eid Element eid.
	 * @private
	 */
	_rebuildStateRows(eid) {
		const node = this.nodes.get(eid);
		this.stmt.deleteStateRows.run(eid);
		if (!node) return;
		node.attrs.forEach((a, i) => {
			this.stmt.insertState.run(eid, i, a.n, a.v);
		});
	}

	/**
	 * Rewrite all domStruct rows of one parent from the mirror (dense
	 * childIndex, correct order).
	 * @param {number} parentId Parent eid.
	 * @private
	 */
	_rebuildParentRows(parentId) {
		const parent = this.nodes.get(parentId);
		this.stmt.deleteParentRows.run(parentId);
		if (!parent) return;
		for (let i = 0; i < parent.kids.length; i++) {
			const child = this.nodes.get(parent.kids[i]);
			if (!child) continue;
			this.stmt.insertStruct.run(parentId, i, parent.kids[i], child.t, child.n);
		}
	}

	/**
	 * Insert one node's "as a child" row from the mirror (used when a stashed
	 * subtree is re-attached — see _persist).
	 * @param {number} eid Node eid.
	 * @private
	 */
	_insertSubtreeRow(eid) {
		const node = this.nodes.get(eid);
		if (!node || !this.nodes.has(node.p)) return;
		const siblings = this.nodes.get(node.p).kids;
		this.stmt.insertStruct.run(node.p, siblings.indexOf(eid), eid, node.t, node.n);
	}

	/**
	 * Cap the move stash.
	 * @private
	 */
	_stashPrune() {
		while (this.detached.size > 1024) {
			this.detached.delete(this.detached.keys().next().value);
		}
	}

	// -- version reconstruction --------------------------------------------------

	/**
	 * The state (mirror) at a revision ≤ head: current with all history rows
	 * past that revision undone (descending opid).
	 * @param  {number} opid Revision.
	 * @return {Map}         Mirror at that revision.
	 * @public
	 */
	snapshotAt(opid) {
		if (!Number.isInteger(opid) || opid < 0) {
			throw new Error('Version must be a non-negative integer.');
		}
		if (opid > this.revision) {
			throw new Error(`Version ${opid} requested, but newest version is ${this.revision}.`);
		}
		const nodes = cloneMirror(this.nodes);
		if (opid === this.revision) return nodes;

		// SQL columns map onto the compact op shape the inverse applier uses.
		const rows = [
			...this.stmt.invStructRows.all(opid, this.revision).map((r) => ({ opid: r.opid,
				k: r.kind, p: r.parentId, i: r.childIndex, e: r.childId, t: r.type,
				n: r.name })),
			...this.stmt.invStateRows.all(opid, this.revision).map((r) => ({ opid: r.opid,
				k: r.kind, e: r.eid, i: r.attrIndex, q: r.pos, n: r.name, v: r.value,
				old: r.oldValue }))
		].sort((a, b) => b.opid - a.opid); // descending: undo newest first
		// Payloads for pure subtree removals in the walked range (keyed by the
		// removal inverse row's opid) — needed to resurrect descendants.
		const payloads = new Map(this.stmt.subtreePayloadsInRange.all(opid,
			this.revision).map((r) => [r.opid, JSON.parse(r.payload)]));
		const ctx = { detached: new Map(), payloads };
		for (const row of rows) {
			applyInverseToMirror(nodes, row, ctx);
		}
		return nodes;
	}

	// -- op log --------------------------------------------------------------------

	/**
	 * All forward-op log entries (one per commit), oldest first.
	 * @return {[{v, base, ops, src, userId, timestamp}]}
	 * @public
	 */
	allCommits() {
		return this.commitsSince(-1);
	}

	// -- tags ----------------------------------------------------------------------

	getTags() {
		return this.stmt.allTags.all().map((tag) => ({ v: tag.opid, label: tag.label,
			timestamp: tag.timestamp }));
	}

	getTag(label) {
		const row = this.stmt.getTag.get(label);
		return row ? { v: row.opid, label: row.label, timestamp: row.timestamp } : null;
	}

	getTagForVersion(opid) {
		const row = this.stmt.tagForOpid.get(opid);
		return row ? { v: row.opid, label: row.label, timestamp: row.timestamp } : null;
	}

	tag(label, opid) {
		if (!label || label.includes('.')) {
			throw new Error('Tag names should not contain periods.');
		}
		if (!Number.isInteger(opid) || opid < 0 || opid > this.revision) {
			throw new Error(`Cannot tag version ${opid} (newest is ${this.revision}).`);
		}
		// One label per version, one version per label: clear both sides first.
		this.stmt.deleteTagByLabel.run(label);
		this.stmt.deleteTagByOpid.run(opid);
		this.stmt.upsertTag.run(label, opid, Date.now());
		return opid;
	}

	untag({ label, opid } = {}) {
		if (opid !== undefined && opid !== null) {
			this.stmt.deleteTagByOpid.run(opid);
		} else if (label) {
			this.stmt.deleteTagByLabel.run(label);
		}
	}

	// -- HTML ingest -----------------------------------------------------------------

	/**
	 * Bootstrap a document from an HTML string (the REST ingest paths: zip
	 * import, remote prototype) as one synthetic commit of sa+aa ops. The
	 * HTML is parsed with parse5 — the same tree-construction algorithm
	 * browsers run, so the ingested mirror is browser-canonical from the
	 * start (fostering, synthesized tbody, template contents all land where
	 * a browser would put them). __wid attributes are dropped (eids are the
	 * identity now); doctypes are not persisted. Attribute values and text
	 * arrive entity-decoded from the parser, so no unescaping applies.
	 * Returns the new revision.
	 * @param {string} html   HTML document.
	 * @param {string} userId Committing user.
	 * @param {string} source Source.
	 * @return {number}       New revision.
	 * @public
	 */
	fromHtml(html, userId, source) {
		if (typeof html !== 'string' || html.length === 0) {
			throw new Error('Ingest requires HTML.');
		}
		const document = parse5.parse(html);
		let nextId = 1;
		const mint = () => nextId++;
		const ops = [];
		const kidCount = new Map([[0, 0]]);

		const nextIndex = (parentEid) => {
			const i = kidCount.get(parentEid) || 0;
			kidCount.set(parentEid, i + 1);
			return i;
		};

		const walk = (node, parentEid) => {
			// Template contents live in node.content (a DocumentFragment);
			// every other node carries its children directly.
			const children = node.content ? node.content.childNodes : node.childNodes;
			for (const child of children) {
				if (child.nodeName === '#documentType') continue; // never persisted
				const e = mint();
				const i = nextIndex(parentEid);
				if (child.nodeName === '#text') {
					ops.push({ k: 'sa', p: parentEid, i, e, t: NODE_TEXT, n: null });
					ops.push({ k: 'aa', e, n: null, v: child.value });
				} else if (child.nodeName === '#comment') {
					ops.push({ k: 'sa', p: parentEid, i, e, t: NODE_COMMENT, n: null });
					ops.push({ k: 'aa', e, n: null, v: child.data });
				} else {
					ops.push({ k: 'sa', p: parentEid, i, e, t: NODE_ELEMENT,
						n: child.tagName });
					// Attributes insert at successive local positions 0, 1, …
					// in the document's own order.
					let attrPos = 0;
					for (const { name, value } of child.attrs || []) {
						if (name === '__wid') continue; // eids are the identity now
						ops.push({ k: 'aa', e, i: attrPos++, n: name, v: value });
					}
					walk(child, e);
				}
			}
		};

		walk(document, 0);
		// No transform: the ops are minted against the current head.
		const result = this.applyCommit({ base: this.revision, ops, userId, source });
		this.stmt.bumpNextId.run('nextId', nextId);
		return result.v;
	}

	/**
	 * Bootstrap this (empty) document as a copy of another handle's mirror at
	 * a revision — the prototype path. Same mechanism as fromHtml (one
	 * synthetic commit of sa+aa ops, fresh eids minted for the new document),
	 * but walking the source mirror directly: no parse round-trip, no
	 * escaping, attribute order preserved from the source's own lists.
	 * Returns the new revision.
	 * @param {Handle} sourceHandle Handle of the document to copy.
	 * @param {number} v            Revision to copy (default: its head).
	 * @param {string} userId       Committing user.
	 * @param {string} source       Source.
	 * @return {number}             New revision of this handle.
	 * @public
	 */
	copyFrom(sourceHandle, v = sourceHandle.revision, userId = 'server',
		source = 'prototype') {
		const nodes = v === sourceHandle.revision
			? sourceHandle.nodes : sourceHandle.snapshotAt(v);
		if (this.revision > 0) throw new Error('Webstrate already exists.');
		if (nodes.get(0)?.kids.length === 0) {
			throw new Error('Prototype webstrate doesn\'t exist.');
		}
		let nextId = 1;
		const mint = () => nextId++;
		const ops = [];
		const kidCount = new Map([[0, 0]]);
		const nextIndex = (parentEid) => {
			const i = kidCount.get(parentEid) || 0;
			kidCount.set(parentEid, i + 1);
			return i;
		};
		const walk = (eid, parentEid) => {
			const node = nodes.get(eid);
			if (!node) return;
			const e = mint();
			ops.push({ k: 'sa', p: parentEid, i: nextIndex(parentEid), e, t: node.t,
				n: node.t === NODE_ELEMENT ? String(node.n) : null });
			let attrPos = 0;
			for (const attr of node.attrs) {
				if (attr.n === null) {
					// Content rows carry no index: a text/comment node's single
					// "attribute" is its content, at implicit position 0.
					ops.push({ k: 'aa', e, n: null, v: attr.v });
				} else {
					// Attributes insert at successive local positions, in the
					// source's own order.
					ops.push({ k: 'aa', e, i: attrPos++, n: attr.n, v: attr.v });
				}
			}
			for (const child of node.kids) walk(child, e);
		};
		walk(nodes.get(0).kids[0], 0);
		const result = this.applyCommit({ base: 0, ops, userId, source });
		this.stmt.bumpNextId.run('nextId', nextId);
		return result.v;
	}

	// -- HTML rendering (painted wire) + digest --------------------------------------

	/**
	 * Serialize a mirror to the painted wire: as close to a plain HTML
	 * serialization of the document as identities allow, so the browser's
	 * parser does virtually all of the transformation work.
	 *
	 * Shape:
	 *
	 *   <!doctype html><html _="...">
	 *   <head><script ...client bundle...></script></head>   temp, sync
	 *   <head_ _="..." data-webstrates-head="1" ...attrs...> the mirror head
	 *     ...head children, natively...
	 *   </head_>
	 *   ...html-level nodes (between head and body in the mirror)...
	 *   <!--wsh-->                                           region boundary
	 *   <body _="...">...</body>
	 *   ...html-level nodes after body...
	 *   </html>
	 *
	 * Every mirror node rides as a real node: elements carry `_=eid` —
	 * LAST in their attribute list, unquoted, so stripping it at adoption
	 * renumbers nothing (the attributes before it ARE the mirror's ordered
	 * attribute list; the DOM's own attribute positions are the wire's
	 * attribute indexes, so the client needs no name→index registry), and
	 * text and comment nodes carry an "<eid>_" prefix on their content
	 * that adoption removes with deleteData. A neutered script's
	 * type="webstrates/x" placeholder rides AT the type's own position
	 * (keeping every position aligned); its un-neuter marker
	 * data-webstrates-type goes after the _. Wire-only artifacts (the temp
	 * head's bundle script and preloads, the region marker) carry no _ and
	 * are stripped at adoption. The temporary real <head> holds only the
	 * bundle; when </head_> has arrived, adoption reparents head_'s children
	 * and attributes onto it and removes head_. Nodes between head_ and the
	 * <!--wsh--> marker are html-level nodes the parser placed into body;
	 * adoption moves them back between head and body. Scripts are neutered
	 * so nothing executes before the client bundle has booted; the client
	 * re-activates and executes them in document order.
	 *
	 * Raw-text and RCDATA parents (script, style, xmp, iframe, noembed,
	 * noframes, noscript, plaintext; title, textarea) carry their content
	 * as the single text node the tokenizer builds from it: the first text
	 * child's identity prefix, then every child in raw serialized form —
	 * the parser merges them into that one node, and the first-paint
	 * normalization commits the merge. options.bundle and options.preloads
	 * are emitted inside the temp head (wire-only, stripped at adoption).
	 * @param  {Map}    nodes   Mirror (default: current).
	 * @param  {object} options {bundle?: string, preloads?: [string]}
	 * @return {string}         HTML document.
	 * @public
	 */
	toHTML(nodes = this.nodes, options = {}) {
		const escapeAttr = (v) => String(v).replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const escapeRc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
		// Content escapes for text riding inside one raw-text node (see the
		// class doc). RCDATA decodes character references, so entity
		// escaping round-trips. RAWTEXT decodes nothing, so only the byte
		// sequences that could end the node early — or, for script, flip
		// the tokenizer into an escaped state — get a backslash: the same
		// rewrite the HTML serializer spec applies to script text. The
		// parser-visible content is what the node keeps; the first-paint
		// normalization commits it.
		const escScript = (v) => String(v)
			.replace(/<!--/g, '<\\!--')
			.replace(/<script/gi, (m) => '<\\' + m.slice(1))
			.replace(/<\/script/gi, (m) => '<\\/' + m.slice(2));
		const escRaw = (name, v) => {
			if (name === 'plaintext') return String(v); // runs to EOF: never exits
			if (name === 'script') return escScript(v);
			return String(v).replace(new RegExp(`</${name}`, 'gi'),
				(m) => '<\\/' + m.slice(2));
		};

		const out = ['<!doctype html>'];

		const root = nodes.get(0);
		const htmlEid = root ? root.kids[0] : undefined;
		const htmlNode = nodes.get(htmlEid);
		const htmlKids = htmlNode ? htmlNode.kids : [];
		const elementName = (eid) => {
			const n = nodes.get(eid);
			return n && n.t === NODE_ELEMENT ? String(n.n).toLowerCase() : null;
		};
		const headIdx = htmlKids.findIndex((k) => elementName(k) === 'head');
		const bodyIdx = htmlKids.findIndex((k) => elementName(k) === 'body');

		// One element's serialized open tag: attributes in mirror position
		// order (the DOM's own attribute list IS the position map — the
		// client never carries a name→index registry), `_` LAST and
		// unquoted — it carries only the element id, and stripping it at
		// adoption renumbers nothing. A neutered script's placeholder rides
		// AT the type's own position so adopted positions line up with the
		// mirror's; its un-neuter marker (data-webstrates-type, also
		// stripped at adoption) goes after `_`. extra appends
		// transport-only attributes (the head_ marker).
		const openTag = (eid, wireName, extra) => {
			const node = nodes.get(eid);
			const mirrorName = elementName(eid) || wireName;
			const attrStrs = [];
			let typeEntry = null;
			for (const attr of node.attrs) {
				if (attr.n === null) continue;
				if (mirrorName === 'script' && attr.n === 'type') {
					typeEntry = attr;
					attrStrs.push('type="webstrates/x"'); // at the type's own position
					continue;
				}
				attrStrs.push(`${escapeAttr(attr.n)}="${escapeAttr(attr.v)}"`);
			}
			if (mirrorName === 'script' && !typeEntry) {
				attrStrs.push('type="webstrates/x"');
			}
			attrStrs.push(`_=${eid}`);
			if (typeEntry) {
				attrStrs.push(`data-webstrates-type="${escapeAttr(typeEntry.v)}"`);
			}
			if (extra) attrStrs.push(extra);
			return `<${wireName} ${attrStrs.join(' ')}>`;
		};

		// Serialize a sibling run in a normal (non-raw) context. Adjacent
		// text siblings parse as ONE text node: emit runs as one node (the
		// first identity's prefix, concatenated contents) so the wire never
		// carries a shape the parser would merge. The first-paint
		// normalization commits the merge to the mirror.
		const serializeRun = (eids) => {
			let i = 0;
			while (i < eids.length) {
				const c = nodes.get(eids[i]);
				if (c && c.t === NODE_TEXT) {
					const entry = c.attrs[0];
					let run = `${eids[i]}_` + (entry ? escapeRc(entry.v) : '');
					i++;
					while (i < eids.length) {
						const n2 = nodes.get(eids[i]);
						if (!n2 || n2.t !== NODE_TEXT) break;
						const e2 = n2.attrs[0];
						run += e2 ? escapeRc(e2.v) : '';
						i++;
					}
					out.push(run);
					continue;
				}
				serializeNode(eids[i]);
				i++;
			}
		};

		// Serialize a mirror node in a normal (non-raw) context.
		const serializeNode = (eid) => {
			const node = nodes.get(eid);
			if (!node) return;
			if (node.t === NODE_TEXT || node.t === NODE_COMMENT) {
				// The identity prefix carries only the eid: a text or comment
				// node's single "attribute" is its content, position 0.
				const entry = node.attrs[0];
				const v = entry ? entry.v : '';
				if (node.t === NODE_TEXT) out.push(`${eid}_` + escapeRc(v));
				else out.push(`<!--${eid}_${v}-->`);
				return;
			}
			const name = String(node.n).toLowerCase();
			if (VOID_ELEMENTS.has(name)) {
				out.push(openTag(eid, name));
				return;
			}
			out.push(openTag(eid, name));
			if (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name)) {
				// All of this parent's content becomes one text node to the
				// parser: the first text child's identity as the prefix, then
				// every child in raw serialized form. Stable mirrors have a
				// single text child here; anything else is an unparseable
				// shape that the parser merges and the first-paint
				// normalization commits as content writes.
				let prefixed = false;
				const esc = RCDATA_ELEMENTS.has(name) ? escapeRc
					: (v) => escRaw(name, v);
				for (const child of node.kids) {
					const c = nodes.get(child);
					if (!c) continue;
					if (c.t === NODE_TEXT) {
						const entry = c.attrs[0];
						if (!prefixed) {
							out.push(`${child}_`);
							prefixed = true;
						}
						out.push(esc(entry ? entry.v : ''));
						continue;
					}
					if (c.t === NODE_COMMENT) {
						const entry = c.attrs[0];
						out.push(`<!--${esc(entry ? entry.v : '')}-->`);
						continue;
					}
					serializeNode(child); // element children ride as markup
				}
			} else {
				serializeRun(node.kids);
			}
			out.push(`</${name}>`);
		};

		// Document skeleton. The temporary real <head> carries only the
		// wire-only bundle + preloads; the mirror head rides as <head_>,
		// whose children and attributes adoption reparents onto it.
		out.push(htmlNode ? openTag(htmlEid, 'html') : '<html>');
		out.push('<head>');
		if (options.bundle) out.push(options.bundle);
		if (options.preloads) out.push(...options.preloads);
		out.push('</head>');
		if (headIdx !== -1) {
			out.push(openTag(htmlKids[headIdx], 'head_', 'data-webstrates-head="1"'));
			serializeRun(nodes.get(htmlKids[headIdx]).kids);
			out.push('</head_>');
		}
		// html-level nodes: everything of html except the (first) head and
		// body. Before-body nodes land between head_ and the marker (the
		// parser places them into body; adoption moves them back to html
		// level). After-body nodes ride after </body> — the parser appends
		// them into body, the first-paint normalization commits that move,
		// and stable documents keep them inside body.
		const region = [];
		const tail = [];
		htmlKids.forEach((k, i) => {
			if (i === headIdx || i === bodyIdx) return;
			(bodyIdx !== -1 && i > bodyIdx ? tail : region).push(k);
		});
		// The region parses in body context: adjacent text nodes there merge
		// too, so the region rides as runs just like body's own children.
		serializeRun(region);
		out.push('<!--wsh-->');
		if (bodyIdx !== -1) {
			const bodyEid = htmlKids[bodyIdx];
			const bodyKids = nodes.get(bodyEid).kids;
			out.push(openTag(bodyEid, 'body'));
			// The parser appends after-body nodes into body, so a text run
			// spanning </body> (body's trailing texts and the tail's leading
			// texts) parses as ONE node: emit it as one prefixed run inside
			// body (first identity only), then the rest of the tail after
			// </body>. The normalization commits the merge to the mirror.
			const isText = (e) => nodes.get(e)?.t === NODE_TEXT;
			let bodyRunEnd = bodyKids.length;
			while (bodyRunEnd > 0 && isText(bodyKids[bodyRunEnd - 1])) bodyRunEnd--;
			let tailRunEnd = 0;
			while (tailRunEnd < tail.length && isText(tail[tailRunEnd])) tailRunEnd++;
			serializeRun(bodyKids.slice(0, bodyRunEnd));
			if (bodyRunEnd < bodyKids.length && tailRunEnd > 0) {
				// The seam run: body's trailing texts + tail's leading texts.
				serializeRun(bodyKids.slice(bodyRunEnd).concat(tail.slice(0, tailRunEnd)));
			} else {
				serializeRun(bodyKids.slice(bodyRunEnd));
			}
			out.push('</body>');
			serializeRun(tail.slice(tailRunEnd));
		} else {
			tail.forEach((k) => serializeNode(k));
		}
		out.push('</html>');
		return out.join('');
	}

	/**
	 * Serialize a mirror as a plain, standalone HTML document — the ?raw and
	 * ?dl (archive index.html) view: what the document looks like to a plain
	 * browser with no webstrates client. No transport annotations at all: no
	 * _ identities, no content prefixes, no neutered scripts, no temporary
	 * head — scripts serialize their real type, text their own content, and
	 * the document's html children (head, html-level nodes, body, tail) ride
	 * in mirror order. Escaping follows the same context rules as the wire
	 * serializer (RCDATA entity-escaped, raw text </name-safe, script
	 * backslash-rewritten) so the served bytes re-parse to the same tree.
	 * @param  {Map}    nodes Mirror (default: current).
	 * @return {string}       HTML document ('' for the empty mirror).
	 * @public
	 */
	toPlainHTML(nodes = this.nodes) {
		const escapeAttr = (v) => String(v).replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const escapeRc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
		const escScript = (v) => String(v)
			.replace(/<!--/g, '<\\!--')
			.replace(/<script/gi, (m) => '<\\' + m.slice(1))
			.replace(/<\/script/gi, (m) => '<\\/' + m.slice(2));
		const escRaw = (name, v) => {
			if (name === 'plaintext') return String(v);
			if (name === 'script') return escScript(v);
			return String(v).replace(new RegExp(`</${name}`, 'gi'),
				(m) => '<\\/' + m.slice(2));
		};

		const root = nodes.get(0);
		const htmlEid = root ? root.kids[0] : undefined;
		if (htmlEid === undefined) return '';
		const elementName = (eid) => {
			const n = nodes.get(eid);
			return n && n.t === NODE_ELEMENT ? String(n.n).toLowerCase() : null;
		};

		const openTag = (eid) => {
			const node = nodes.get(eid);
			const name = elementName(eid);
			const attrStrs = [];
			for (const attr of node.attrs) {
				if (attr.n === null) continue;
				attrStrs.push(`${escapeAttr(attr.n)}="${escapeAttr(attr.v)}"`);
			}
			return `<${name}${attrStrs.length ? ' ' + attrStrs.join(' ') : ''}>`;
		};

		const serializeNode = (eid) => {
			const node = nodes.get(eid);
			if (!node) return;
			if (node.t === NODE_TEXT) {
				const entry = node.attrs[0];
				out.push(escapeRc(entry ? entry.v : ''));
				return;
			}
			if (node.t === NODE_COMMENT) {
				const entry = node.attrs[0];
				out.push(`<!--${entry ? entry.v : ''}-->`);
				return;
			}
			const name = elementName(eid);
			if (VOID_ELEMENTS.has(name)) {
				out.push(openTag(eid));
				return;
			}
			out.push(openTag(eid));
			if (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name)) {
				const esc = RCDATA_ELEMENTS.has(name) ? escapeRc
					: (v) => escRaw(name, v);
				for (const child of node.kids) {
					const c = nodes.get(child);
					if (!c) continue;
					if (c.t === NODE_TEXT) {
						const entry = c.attrs[0];
						out.push(esc(entry ? entry.v : ''));
					} else if (c.t === NODE_COMMENT) {
						const entry = c.attrs[0];
						out.push(`<!--${esc(entry ? entry.v : '')}-->`);
					} else {
						serializeNode(child); // element children ride as markup
					}
				}
			} else {
				for (const child of node.kids) serializeNode(child);
			}
			out.push(`</${name}>`);
		};

		const out = ['<!doctype html>\n', openTag(htmlEid)];
		for (const child of nodes.get(htmlEid).kids) serializeNode(child);
		out.push('</html>');
		return out.join('');
	}

	/**
	 * The paint digest: a sha256 over the mirror in canonical (document
	 * order, attribute-position order) row form. The client computes the
	 * same digest over the DOM it adopted and compares it with the data-d
	 * on the bundle script; a mismatch means the adopted DOM is not what
	 * the mirror said it was (extension interference, a parser divergence,
	 * an attribute order the DOM could not materialize) and the client
	 * reloads once before showing an error state. Served paints are
	 * normalization-stable, so by construction the digests agree.
	 * @param  {Map}    nodes Mirror (default: current).
	 * @return {string}       Hex digest.
	 * @public
	 */
	paintDigest(nodes = this.nodes) {
		return crypto.createHash('sha256')
			.update(JSON.stringify(this.paintRows(nodes))).digest('hex');
	}

	/**
	 * The digest rows of paintDigest, unhashed: the pre-order row form
	 * (['E', eid, tagName, [[name, value], …]] / ['T'|'C', eid, data]) the
	 * client reproduces over its adopted DOM. Served by the paint-rows
	 * endpoint so a digest mismatch can be diffed to its first divergent
	 * row instead of remaining an opaque hex comparison.
	 * @param  {Map}    nodes Mirror (default: current).
	 * @return {[array]}      Digest rows.
	 * @public
	 */
	paintRows(nodes = this.nodes) {
		const digestRows = [];
		const walk = (eid) => {
			const node = nodes.get(eid);
			if (!node) return;
			if (node.t === NODE_TEXT || node.t === NODE_COMMENT) {
				const entry = node.attrs[0];
				digestRows.push([node.t === NODE_TEXT ? 'T' : 'C', eid,
					entry ? entry.v : '']);
				return;
			}
			const name = String(node.n).toLowerCase();
			// Attribute positions are load-bearing (ops address them), so the
			// digest is order-sensitive — a DOM whose attribute order
			// diverged from the mirror's is caught here.
			const attrs = [];
			for (const attr of node.attrs) {
				if (attr.n === null) continue;
				attrs.push([attr.n, attr.v]);
			}
			digestRows.push(['E', eid, name, attrs]);
			for (const child of node.kids) walk(child);
		};
		const root = nodes.get(0);
		for (const child of root.kids) walk(child);
		return digestRows;
	}

	destroy() {
		handles.delete(this.id);
		this.close();
		const dir = dataDir();
		const base = path.join(dir, fileBase(this.id));
		for (const suffix of ['.current', '.history', '.current-wal', '.current-shm',
			'.history-wal', '.history-shm']) {
			try {
				fs.unlinkSync(base + suffix);
			} catch (err) { /* already gone */ }
		}
	}
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

/**
 * Get (or open) the handle for a webstrate. Handles are LRU-capped; eviction
 * is safe because all writes are synchronous.
 * @param  {string} webstrateId Webstrate id.
 * @return {Handle}
 * @public
 */
function getHandle(webstrateId) {
	let handle = handles.get(webstrateId);
	if (handle) {
		handle.refCount++;
		return handle;
	}
	while (handles.size >= MAX_OPEN_HANDLES) {
		let evicted = false;
		for (const [id, h] of handles) {
			if (h.refCount <= 0) {
				handles.delete(id);
				h.close();
				evicted = true;
				break;
			}
		}
		if (!evicted) break; // all referenced — proceed anyway
	}
	handle = new Handle(webstrateId);
	handles.set(webstrateId, handle);
	handle.refCount++;
	return handle;
}

/**
 * Release a handle obtained via getHandle.
 * @param {string} webstrateId Webstrate id.
 * @public
 */
function releaseHandle(webstrateId) {
	const handle = handles.get(webstrateId);
	if (handle && handle.refCount > 0) handle.refCount--;
}

/**
 * Whether a webstrate has any committed content (revision > 0).
 * @param  {string} webstrateId Webstrate id.
 * @return {bool}
 * @public
 */
function exists(webstrateId) {
	const handle = getHandle(webstrateId);
	const has = handle.revision > 0;
	releaseHandle(webstrateId);
	return has;
}

module.exports = { getHandle, releaseHandle, exists, validOp, emptyMirror,
	cloneMirror, applyOpToMirror, transformOps, NODE_ELEMENT, NODE_TEXT,
	NODE_COMMENT };
