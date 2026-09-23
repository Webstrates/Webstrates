'use strict';
/*
coreDatabase (client/webstrates/coreDatabase.js)

The document protocol client — the replacement for the ShareDB connection.

The server keeps every webstrate in two SQLite stores (a current mirror and a
history log) and talks a small wire protocol over the websocket:

  (subscribe)  implicit: opening the socket joins the document's presence
               (the document is in the socket's URL); the hello that follows
               carries the head revision, and from then on every commit is
               pushed as a {wa: 'ops'} frame
  commit       {base, ops} — one transaction; the server transforms the ops
               against everything committed since `base`, applies them, and
               broadcasts the final ops (with an x flag when it transformed)
  allocids      mint a block of element ids and attribute indexes from the
               document's global counter (coreIds.js owns the client pool)
  fetchStructure brotli binary frame {v, struct, state} — the authoritative
               node tree with every eid and attribute index; used for clean
               rebuilds (divergences, root-touching commits) and secondary
               documents, never for the initial load
  fetchdoc/getOps/tag/... snapshot reads, op log, tagging (unchanged shapes)

The client keeps json0 as its internal event language: coreOpCreator still
produces json0 ops (against the DOM, like it always did) and coreOpApplier
still applies json0 ops to the DOM. This module is the translation boundary
(json0 ↔ wire) plus the commit queue:

  - commits are serialized (one in flight). While a commit is in flight,
    incoming {wa: 'ops'} frames are deferred; that makes the concurrent-edit
    case exact: on an x=false acknowledgement our own ops stand (they are
    already in the DOM) and the deferred frames apply on top; on x=true the
    client inverts its own ops from the DOM (nothing else was interleaved,
    so the inverse is exact), then replays the deferred frames and its own
    final ops in pure server order. No client-side OT.
  - the DOM is adopted from the pre-rendered page when one was served. The
    paint is served stable by construction (the server re-parses its own
    render and commits any divergence first), so every node rides natively
    and identified: elements carry _="<eid>[,<attrIndex>…>" attributes,
    text/comment nodes carry an "<eid>,<x>_" content prefix, the mirror
    head travels as a <head_> element and the html-level nodes as a region
    between it and a <!--wsh--> marker. The bundle script (sync, in a
    temporary real <head>) starts paintAdoption's stream pass during the
    parse; adoption finishes at DOMContentLoaded and the content digest
    (data-d on the bundle) is an integrity assert — a mismatch means
    extension interference or a parser divergence, gets one sessionStorage-
    guarded reload and then a visible error state. There is deliberately no
    fetchStructure fallback on the initial load (it remains for divergence
    rebuilds and secondary documents). After adoption the client replays
    the few commits since the render.
*/
/* global _document */
const coreEvents = require('./coreEvents');
const coreIds = require('./coreIds');
const coreJsonML = require('./coreJsonML');
const coreMutation = require('./coreMutation');
const coreOpApplier = require('./coreOpApplier');
const corePathTree = require('./corePathTree');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const json0 = require('ot-json0/lib/json0');

coreEvents.createEvent('receivedDocument');
coreEvents.createEvent('receivedOps');
coreEvents.createEvent('databaseError');
coreEvents.createEvent('opsAcknowledged');

const COLLECTION_NAME = 'webstrates';
const TYPE_JSONv0 = 'http://sharejs.org/types/JSONv0';

// Wire node type codes (the mirror's t).
const WIRE_ELEMENT = 1;
const WIRE_TEXT = 3;
const WIRE_COMMENT = 8;

// The JsonML indexes: [tag-name, attribute-object, ...children].
const ATTRIBUTE_INDEX = 1;
const ELEMENT_LIST_OFFSET = 2;

// ---------------------------------------------------------------------------
// Canonical form helpers (JsonML <-> wire raw values)
// ---------------------------------------------------------------------------

// The canonical (doc.data) form escapes attribute values and '.' in names;
// the wire (and the DOM) carry raw ones. escape/unescape/escapeDots/
// unescapeDots come from coreUtils.

/**
 * Map an offset into an escaped string to the offset of the same position in
 * the raw string (attribute value string diffs: the canonical op offsets are
 * in escaped coordinates, the wire's are raw).
 * @param  {string} escapedValue Canonical (escaped) string.
 * @param  {int}    offset      Offset in the escaped string.
 * @return {int|null}           Offset in the raw string (null if the offset
 *                              falls inside an entity).
 * @private
 */
function escapedOffsetToRaw(escapedValue, offset) {
	let raw = 0;
	let i = 0;
	while (i < offset && i < escapedValue.length) {
		if (escapedValue.startsWith('&quot;', i)) {
			if (i + 6 > offset) return null;
			i += 6;
		} else if (escapedValue.startsWith('&amp;', i)) {
			if (i + 5 > offset) return null;
			i += 5;
		} else {
			i += 1;
		}
		raw += 1;
	}
	return raw;
}

/**
 * Map a raw offset back into an escaped string's coordinates.
 * @param  {string} escapedValue Canonical (escaped) string.
 * @param  {int}    rawOffset   Offset in the raw string.
 * @return {int}                Offset in the escaped string.
 * @private
 */
function rawOffsetToEscaped(escapedValue, rawOffset) {
	let raw = 0;
	let i = 0;
	while (raw < rawOffset && i < escapedValue.length) {
		if (escapedValue.startsWith('&quot;', i)) {
			i += 6;
		} else if (escapedValue.startsWith('&amp;', i)) {
			i += 5;
		} else {
			i += 1;
		}
		raw += 1;
	}
	return i;
}

/**
 * Canonicalize a JsonML tree (fromHTML output: raw attribute values, __wid
 * properties) into doc.data form: escaped values, '.'-escaped attribute
 * names, __wid kept as an integer property.
 * @param  {JsonML} jml JsonML fragment.
 * @return {JsonML}      Canonical JsonML fragment.
 * @private
 */
function canonicalizeJml(jml) {
	if (typeof jml === 'string' || typeof jml === 'number' || jml === null) {
		return jml;
	}
	if (!Array.isArray(jml)) return jml;
	return jml.map((entry, index) => {
		if (index === 1 && entry && typeof entry === 'object'
			&& !Array.isArray(entry)) {
			const props = {};
			for (const [name, value] of Object.entries(entry)) {
				if (name === '__wid') {
					props.__wid = value;
					continue;
				}
				props[coreUtils.escapeDots(name)] = coreUtils.escape(value);
			}
			return props;
		}
		return canonicalizeJml(entry);
	});
}

// ---------------------------------------------------------------------------
// Digest (mirrors DocumentStore.paintDigest: sha256 over pre-order rows
// ['E', eid, lowerName, sorted[name,value] pairs], ['T', eid, content],
// ['C', eid, content] — raw names and values)
// ---------------------------------------------------------------------------

/**
 * The digest rows of a DOM subtree: the pre-order row form the server's
 * paintRows mirrors (['E', eid, tagName, [[name, value], …]] elements,
 * ['T'|'C', eid, data] text/comment).
 * @param  {DOMElement} rootElement The <html> element (walked pre-order).
 * @return {[array]}                Digest rows.
 * @private
 */
function computeRows(rootElement) {
	const rows = [];
	const walk = (node) => {
		if (node.nodeType === document.TEXT_NODE) {
			rows.push(['T', node.__eid, node.data]);
			return;
		}
		if (node.nodeType === document.COMMENT_NODE) {
			rows.push(['C', node.__eid, node.data]);
			return;
		}
		// Wire-only transport nodes (the boot hide + loading UI, see
		// SnapshotCacheManager.bootStyle) are not mirror content and must
		// not enter the digest. The reveal is deferred past the digest to
		// 'populated' (see paintAdoption), so the style element is still
		// in the walked tree here. data-webstrates-* names are rejected
		// by validOp, so no mirror element can ever be skipped by mistake.
		if (node.hasAttribute && node.hasAttribute('data-webstrates-boot')) {
			return;
		}
		// Attribute positions are load-bearing (ops address them), so the
		// digest is order-sensitive — the DOM's attribute order must equal
		// the mirror's. The two transport-only names are already stripped
		// by the time a digest is computed; skipping them keeps any window
		// during adoption from corrupting it.
		const attrs = [];
		for (let i = 0; i < node.attributes.length; i++) {
			const attr = node.attributes[i];
			if (attr.name === '_' || attr.name === 'data-webstrates-type') {
				continue;
			}
			attrs.push([attr.name, attr.value]);
		}
		rows.push(['E', node.__wid, String(node.tagName).toLowerCase(), attrs]);
		coreUtils.getChildNodes(node).forEach(walk);
	};
	walk(rootElement);
	return rows;
}

/**
 * Compute the content digest of a DOM subtree, identical to the server's
 * paint digest of the same document.
 * @param  {DOMElement} rootElement The <html> element (walked pre-order).
 * @return {Promise<string>}       sha256 hex digest.
 * @private
 */
async function computeDigest(rootElement) {
	const bytes = new TextEncoder().encode(JSON.stringify(computeRows(rootElement)));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Brotli decoding (binary fetchStructure frames; Chrome has no native
// DecompressionStream('br') and uses an embedded wasm decoder)
// ---------------------------------------------------------------------------

let nativeBrotliSupported;
function canNativeBrotli() {
	if (nativeBrotliSupported === undefined) {
		try {
			new DecompressionStream('br');
			nativeBrotliSupported = true;
		} catch (err) {
			nativeBrotliSupported = false;
		}
	}
	return nativeBrotliSupported;
}

const brotliWasmModule = require('brotli-dec-wasm/web');
const BROTLI_WASM_BASE64 = require('./brotli-wasm-bytes.b64');
let brotliInitPromise;

function embeddedBrotliWasmBytes() {
	const binary = atob(BROTLI_WASM_BASE64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Decompress brotli bytes (as a Uint8Array) into a parsed JSON payload.
 * @param  {Uint8Array} bytes Compressed payload.
 * @return {Promise<Object|null>} Parsed payload, or null on failure.
 * @private
 */
async function decodeBrotliPayload(bytes) {
	try {
		if (canNativeBrotli()) {
			const stream = new Blob([bytes]).stream()
				.pipeThrough(new DecompressionStream('br'));
			return JSON.parse(await new Response(stream).text());
		}
		brotliInitPromise = brotliInitPromise
			|| brotliWasmModule.default({ module_or_path: embeddedBrotliWasmBytes() });
		await brotliInitPromise;
		return JSON.parse(new TextDecoder().decode(brotliWasmModule.decompress(bytes)));
	} catch (err) {
		return null;
	}
}

/**
 * Fetch the document structure (a {v, struct, state} payload, brotli
 * compressed) at a specific revision. `version` defaults to head.
 * @param  {string} webstrateId Webstrate id.
 * @param  {int}    version     (optional) Revision.
 * @return {Promise<Object|null>} Parsed structure, or null.
 * @private
 */
function fetchStructure(webstrateId, version) {
	return new Promise((resolve) => {
		// The document is named only when it is not this socket's own.
		const message = { wa: 'fetchStructure' };
		if (webstrateId !== state.webstrateId) message.d = webstrateId;
		if (version !== undefined) message.v = version;
		// A lost reply (socket reconnected under the token bookkeeping)
		// would otherwise leave the promise pending forever, wedging every
		// rebuild that waits on it.
		const timer = setTimeout(() => resolve(null), 30000);
		coreWebsocket.send(message, (error, bytes) => {
			clearTimeout(timer);
			if (error || !(bytes instanceof Uint8Array)) return resolve(null);
			decodeBrotliPayload(bytes).then(resolve);
		}, { waitForOpen: true });
	});
}

/**
 * Build a canonical JsonML tree plus text metadata from a fetchStructure
 * payload ({v, struct: [[p, i, e, t, n]], state: [[e, i, n, v]]} — the
 * state rows' second field is the attribute's LOCAL position, arriving in
 * the mirror's attribute order).
 * @param  {object} structure Parsed structure payload.
 * @return {{jml: JsonML, textMeta: [{eid}], node: Map}} Tree + text/comment
 *   eids in creation (pre-order) order. The jml props order IS the
 *   attribute-position order (no parallel index registry is needed — the
 *   rebuilt DOM's own attribute list carries the positions).
 * @private
 */
function jsonmlFromStructure(structure) {
	const node = new Map(); // eid -> { kids: [], attrs: [], t, n }
	const ordered = []; // eids in parent, then child order
	for (const [p, i, e, t, n] of structure.struct) {
		let entry = node.get(e);
		if (!entry) {
			entry = { kids: [], attrs: [], t, n };
			node.set(e, entry);
		}
		const parent = node.get(p) || { kids: [], attrs: [], t: WIRE_ELEMENT };
		parent.kids[i] = e;
		node.set(p, parent);
		ordered.push(e);
	}
	for (const [e, i, n, v] of structure.state) {
		const entry = node.get(e);
		if (!entry) continue;
		if (n === null) {
			entry.content = { v };
		} else {
			// Ordered: the DOM's attribute list is the position map, so the
			// row order (the mirror's attribute order) must survive intact —
			// a name-keyed object would reorder integer-like names.
			entry.attrs.push({ n, v });
		}
	}

	const textMeta = [];
	const build = (eid) => {
		const entry = node.get(eid);
		if (!entry) return null;
		if (entry.t === WIRE_TEXT || entry.t === WIRE_COMMENT) {
			textMeta.push({ eid });
			return entry.t === WIRE_TEXT
				? (entry.content ? entry.content.v : '')
				: ['!', entry.content ? entry.content.v : ''];
		}
		const props = { __wid: eid };
		for (const { n: name, v } of entry.attrs) {
			props[coreUtils.escapeDots(name)] = coreUtils.escape(v);
		}
		const jml = [entry.n, props];
		for (const kid of entry.kids) {
			if (kid === undefined) continue;
			jml.push(build(kid));
		}
		return jml;
	};

	const root = node.get(0) || { kids: [] };
	const jml = [];
	for (const kid of root.kids) {
		if (kid === undefined) continue;
		jml.push(build(kid));
	}
	return { jml, textMeta, node };
}

// ---------------------------------------------------------------------------
// Outgoing translation: json0 ops (DOM-annotated) → wire ops
// ---------------------------------------------------------------------------

// Text metadata for the empty-document bootstrap: the populator mints eids
// and content indexes for the DOM's text/comment nodes as it builds them and
// hands them over (in JsonML pre-order) before submitting the root insert.
// A root insert without populator metadata (userland) mints its own here.
let bootstrapTextMeta = [];

/**
 * Emit wire ops for a canonical JsonML value: an sa for every element (its
 * eid taken from the value's __wid property, minted and written back when
 * missing), an aa for every attribute, and an sa+aa pair for every text and
 * comment leaf (its eid/content index from the bootstrap metadata or minted
 * fresh). The root insert (the bootstrap), fresh node emission and node
 * replacements share this. When `domNode` is given, the walk runs in parallel
 * over the DOM subtree (in fromHTML's child order) and binds minted ids to
 * the actual nodes; attributes listed in `entry.attrs` are skipped — the
 * entry's attribute collapse re-sends them with the newest record-time value.
 * @param  {JsonML}  jml       Canonical value.
 * @param  {int}     parentEid Wire parent eid.
 * @param  {int}     index     Wire child index.
 * @param  {DOMNode} domNode   DOM node matching the value (or null).
 * @param  {object}  entry     Queue entry (or null; for attr skipping).
 * @return {{eid: int|null, wire: [wireOp]}} The root's eid and its wire ops
 *                                        (eid null when the pool ran out).
 * @private
 */
function wireForCanonicalJml(jml, parentEid, index, domNode, entry) {
	const wire = [];
	const walk = (value, pEid, i, dom) => {
		if (typeof value === 'string' || typeof value === 'number') {
			let eid = dom && dom.__eid !== undefined ? dom.__eid : null;
			if (eid === null) {
				const meta = bootstrapTextMeta.length > 0
					? bootstrapTextMeta.shift() : null;
				eid = meta ? meta.eid : coreIds.mintId();
				if (eid === null) return null;
				if (dom && dom.nodeType !== document.ELEMENT_NODE) {
					coreIds.registerTextOrComment(dom, eid);
				}
			}
			// The content needs no index: a text node's single "attribute"
			// is its content, at implicit position 0 — the eid addresses it.
			const content = String(value);
			wire.push({ k: 'sa', p: pEid, i, e: eid, t: WIRE_TEXT, n: null });
			wire.push({ k: 'aa', e: eid, n: null, v: content });
			return eid;
		}
		if (Array.isArray(value) && value[0] === '!') {
			let eid = dom && dom.__eid !== undefined ? dom.__eid : null;
			if (eid === null) {
				const meta = bootstrapTextMeta.length > 0
					? bootstrapTextMeta.shift() : null;
				eid = meta ? meta.eid : coreIds.mintId();
				if (eid === null) return null;
				if (dom && dom.nodeType !== document.ELEMENT_NODE) {
					coreIds.registerTextOrComment(dom, eid);
				}
			}
			const content = typeof value[1] === 'string' ? value[1] : '';
			wire.push({ k: 'sa', p: pEid, i, e: eid, t: WIRE_COMMENT, n: null });
			wire.push({ k: 'aa', e: eid, n: null, v: content });
			return eid;
		}
		let eid = value[1] && value[1].__wid;
		if (typeof eid !== 'number') {
			eid = coreIds.mintId();
			if (eid === null) return null;
			if (value[1] && typeof value[1] === 'object'
				&& !Array.isArray(value[1])) {
				value[1].__wid = eid;
			} else {
				value.splice(1, 0, { __wid: eid });
			}
			if (dom && dom.nodeType === document.ELEMENT_NODE
				&& (dom.__wid === undefined || dom.__wid === null)) {
				coreIds.registerElement(dom, eid);
			}
		}
		wire.push({ k: 'sa', p: pEid, i, e: eid, t: WIRE_ELEMENT, n: value[0] });
		// Parallel DOM cursor for the children, in fromHTML's order.
		const domChildren = dom && dom.nodeType === document.ELEMENT_NODE
			? Array.from(coreUtils.getChildNodes(dom)).filter((child) =>
				child.__pathNodes && child.__pathNodes.length > 0) : [];
		let domCursor = 0;
		const nextDomChild = () => domCursor < domChildren.length
			? domChildren[domCursor++] : null;
		let childIndex = 0;
		for (let i = 1; i < value.length; i++) {
			const child = value[i];
			if (i === 1 && child && typeof child === 'object'
				&& !Array.isArray(child)) {
				// A fresh node's attributes insert at successive local
				// positions — the emission order (the props object's key
				// order) for userland jml, the live DOM's own order when a
				// parallel node exists.
				let attrPos = 0;
				for (const [name, attrValue] of Object.entries(child)) {
					if (name === '__wid') continue;
					const rawName = coreUtils.unescapeDots(name);
					if (entry && entry.attrs.get(dom)
						&& entry.attrs.get(dom).has(rawName)) {
						continue; // re-sent by the entry's attribute collapse
					}
					const pos = dom && dom.nodeType === document.ELEMENT_NODE
						? coreIds.attrPosition(dom, rawName) : attrPos++;
					wire.push({ k: 'aa', e: eid, i: pos, n: rawName,
						v: coreUtils.unescape(attrValue) });
				}
				continue;
			}
			const childEid = walk(child, eid, childIndex, nextDomChild());
			if (childEid === null) return null;
			childIndex += 1;
		}
		return eid;
	};
	const eid = walk(jml, parentEid, index, domNode);
	return { eid, wire };
}

/**
 * Resolve the DOM node at a json0 element path.
 * @param  {JsonMLPath} path Path (relative to the document root array).
 * @return {DOMNode|null}     The node, if it exists in the path tree.
 * @private
 */
function nodeAtPath(path) {
	const resolved = corePathTree.elementAtPath(document.documentElement, path);
	return resolved ? resolved[0] : null;
}

/**
 * Count the ids a wire translation will mint for a DOM subtree: one per
 * node plus one per attribute, plus one per attribute set in the ops.
 * @param  {[op]}  ops json0 ops (with __node annotations).
 * @return {int}       Upper bound of ids needed.
 * @private
 */
function estimateIdBudget(ops) {
	let count = 8;
	const countSubtree = (node) => {
		if (!node) return;
		count += 1 + (node.attributes ? node.attributes.length : 0);
		coreUtils.getChildNodes(node).forEach(countSubtree);
	};
	for (const op of ops) {
		if (op.__node) countSubtree(op.__node);
		count += 2;
	}
	return count;
}

/**
 * Translate one json0 op (from coreOpCreator, with __node annotations) into
 * wire ops. Returns null when the op cannot be translated yet (out of ids —
 * the caller retries after a refill) or an empty array when it needs no wire
 * op at all.
 * @param  {op}    op          json0 op.
 * @param {object} valueSnaps  Map from op to the canonical (escaped) string
 *                             value its si/sd offsets refer to (snapshotted
 *                             at submit time, when the op was created).
 * @return {[wireOp]|null}    Wire ops, or null to retry later.
 * @private
 */
function translateOpOutgoing(op, entry) {
	// Wire-only recovery ops (coreOpCreator): a removal whose node the local
	// model has already lost but the server mirror still holds. No json0 form
	// exists, so the op rides the queue untranslated and is applied to the
	// wire verbatim — and never to the model (applyToModel skips it).
	if (op.__wireOnly) {
		return [op.__wireOnly];
	}

	const path = op.p;
	const last = path[path.length - 1];

	// Root-level insert (the empty-document bootstrap): the whole document
	// arrives as one op with the standard structure as its value. Elements
	// carry pre-minted eids in their __wid properties; text eids are minted
	// here in JsonML pre-order (or taken from the populator's metadata).
	if (path.length === 0 && 'oi' in op) {
		const emitted = wireForCanonicalJml(op.oi, 0, 0, null, null);
		return emitted.eid === null ? null : emitted.wire;
	}

	// Node replacement (userland, e.g. the webstrates file system): a
	// replaceNode op {li, ld, p}. Decomposed into a detach of the old node
	// and a fresh emission of the new value — the replacement's root gets a
	// fresh eid (the server's re-attach keeps a stashed node's tag and
	// attributes, so the old eid cannot carry a new tag), while children keep
	// theirs and re-attach from the server's stash.
	if ('li' in op && 'ld' in op) {
		const node = op.__node || nodeAtPath(path);
		if (!node) return [];
		const parent = node.parentElement || node.parentNode;
		if (!parent) return [];
		// Children of a template live in its content fragment; the wire
		// parent is the template itself.
		const container = parent.nodeType === document.DOCUMENT_FRAGMENT_NODE
			? coreIds.hostOf(parent) : parent;
		if (!container) return [];
		const parentEid = coreIds.eidOfContainer(container);
		if (parentEid === undefined || parentEid === null) return null;
		const wire = [];
		const oldEid = coreIds.getEid(node);
		if (oldEid !== undefined && oldEid !== null) {
			// The wire sr names the parent being left (validOp requires p).
			wire.push({ k: 'sr', e: oldEid, p: parentEid });
		} else if (typeof last === 'number' && last >= ELEMENT_LIST_OFFSET
			&& parentEid !== 0) {
			// The old node lost its eid mapping (it was never bound): name the
			// slot instead and let the server remove whatever child holds it —
			// clamped and skipped when it does not resolve. A best-effort
			// positional removal beats leaking the old node next to its
			// replacement. Never at the document root (p 0): slot 0 there is
			// the html element, and a stale index could name it.
			wire.push({ k: 'sr', p: parentEid, i: last - ELEMENT_LIST_OFFSET });
		}
		let value = op.li;
		let domNode = node;
		if (last === 0 && typeof value === 'string') {
			// Tag rename: the value is the new tag name, not a text value —
			// re-serialize the (locally unchanged) subtree under the new tag.
			const serialized = serializeNode(node);
			serialized.jml[0] = value;
			if (serialized.jml[1] && typeof serialized.jml[1] === 'object'
				&& !Array.isArray(serialized.jml[1])) {
				delete serialized.jml[1].__wid; // fresh root eid
			}
			value = serialized.jml;
		} else if (Array.isArray(value) && value[1]
			&& typeof value[1] === 'object' && !Array.isArray(value[1])
			&& typeof value[1].__wid === 'number') {
			// The model's value still carries the old node's eid; dropping it
			// makes the walk below mint a fresh one. Op values share object
			// identity with the model, so the model follows along.
			delete value[1].__wid;
		}
		// Creation-time position (the op's path, less ELEMENT_LIST_OFFSET):
		// the server replaces the node at this index, so the replacement
		// takes the same slot — a flush-time count could describe a
		// post-batch position instead.
		const emitted = wireForCanonicalJml(value, parentEid,
			typeof last === 'number' ? last - ELEMENT_LIST_OFFSET
				: knownIndexOf(container, node),
			domNode, entry);
		if (emitted.eid === null) return null;
		wire.push(...emitted.wire);
		return wire;
	}

	// Element (or text/comment) insertion: {li, p, __node}. A node the
	// server already knows (created or stashed by an earlier commit — the
	// queue is serialized, so earlier local commits are acked) is a move:
	// sr (a no-op when an sr from the same batch already detached it) plus sa
	// at the current DOM position. Fresh nodes get a full subtree emission.
	if ('li' in op) {
		return wireForFreshNode(op, entry);
	}

	// Element removal: {ld, p, __node}. Moves (an ld and a later li of the
	// same node in one batch) pair up naturally: the sr detaches, the li's
	// sa re-attaches from the stash.
	if ('ld' in op) {
		const node = op.__node || nodeAtPath(op.p);
		if (!node) return [];
		const eid = coreIds.getEid(node);
		// The wire sr names the parent the node leaves. A removed node is
		// detached (and a same-batch move re-attaches it elsewhere), so the
		// parent is resolved from the op's own record-time path — the server
		// applies sr from its own bookkeeping (node.p) and only checks p's
		// shape. 0 (document root) is the fallback: it passes validation.
		const parent = nodeAtPath(op.p.slice(0, -1)) || node.parentNode;
		let parentEid = 0;
		if (parent) {
			parentEid = parent.nodeType === document.DOCUMENT_NODE
				? 0 : coreIds.getEid(parent);
			if (parentEid === undefined || parentEid === null) parentEid = 0;
		}
		if (eid !== undefined && eid !== null) {
			return [{ k: 'sr', e: eid, p: parentEid }];
		}
		// The node never got an eid binding (never sent): if the record-time
		// model position can name the slot anyway, let the server remove
		// whatever child holds it (clamped; skipped when the parent is empty)
		// — a positional best-effort beats a silent leak of the node into the
		// mirror. Never at the document root (slot 0 is the html element).
		//
		// UNLESS this entry already detached a node from the same parent by
		// eid: the add-first pair's li then took the MOVE path (its node was
		// bound to the old text's minted eid when the pump lagged a feedback
		// rewrite), and that move's sr already removed the parent's old
		// occupant server-side. Applying the positional sr afterwards — the
		// ops run sequentially within the commit — hits the slot the move's
		// sa just re-occupied and removes the re-added node: the record text
		// vanishes from the mirror while the client DOM keeps it (the
		// tldraw feedback-write flicker). The by-eid sr is the removal; this
		// one would be a second one.
		if (typeof last === 'number' && last >= ELEMENT_LIST_OFFSET
			&& parentEid !== 0
			&& !(entry.__srDetachParents
				&& entry.__srDetachParents.has(parentEid))) {
			return [{ k: 'sr', p: parentEid, i: last - ELEMENT_LIST_OFFSET }];
		}
		return [];
	}

	// Attribute insertion/replacement/removal and attribute string edits are
	// collapsed per element and name by submitOp (entry.attrs) and emitted
	// once per commit with the entry's final (record-time) value: individual
	// ops produce no wire here.
	if ('oi' in op || 'od' in op) {
		return [];
	}

	// String insert/delete: text and comment content (attribute values are
	// collapsed like oi/od above).
	if ('si' in op || 'sd' in op) {
		const isInsert = 'si' in op;
		const fragment = isInsert ? op.si : op.sd;
		const offset = last;
		const containerIndex = path[path.length - 2];

		// Attribute value: [...elemPath, 1, key, offset].
		if (typeof containerIndex === 'string') {
			return [];
		}

		// Text or comment content: [...parentPath, index, offset]. The wire
		// op carries only the eid — the content is the node's single
		// "attribute", at implicit position 0. The wire offset is the
		// record-time offset mapped past frame edits recorded after the op
		// (earlier local entries' edits are acked and baked into the base;
		// same-commit siblings apply sequentially server-side, so they need
		// no mapping).
		const node = op.__target || nodeAtPath(path.slice(0, -1));
		if (!node) return [];
		const eid = coreIds.getEid(node);
		if (eid === undefined || eid === null) return null;
		if (op.__strKey === undefined) {
			// No edit log was kept for this string (userland op recorded
			// before the logging path existed): send as-is, the server
			// clamps the offset.
			return [{ k: isInsert ? 'si' : 'sd', e: eid, q: offset,
				v: fragment }];
		}
		if (isInsert) {
			const q = mapOffsetForward(op.__strKey, op.__strVer, op.__frameVer,
				offset, op.__entryId);
			if (q === null) return null;
			return [{ k: 'si', e: eid, q, v: fragment }];
		}
		const pieces = mapRangeForward(op.__strKey, op.__strVer,
			op.__frameVer, offset, fragment.length, op.__entryId);
		if (pieces === null) return null;
		return pieces.map((piece) => ({ k: 'sd', e: eid, q: piece.q,
			v: fragment.slice(piece.s, piece.s + piece.l) }));
	}

	// Anything else (root deletions and the like) is not produced by the
	// client's creator; ignore it rather than corrupting the document.
	return [];
}

/**
 * The wire child index for a node: the number of preceding siblings the
 * server will know by the time this op applies. Ops apply sequentially
 * within a commit, so a sibling minted for an earlier op of the same (or an
 * already-sent earlier) entry counts too — skipping same-batch siblings
 * transposed multi-add mutations (several nodes added by one childList
 * record all computed index 0 and landed in the document in reverse).
 * @param  {DOMElement} parent Parent element.
 * @param  {DOMNode}    node   Node to place.
 * @return {int}               Wire child index.
 * @private
 */
function knownIndexOf(parent, node) {
	const parentPathNode = corePathTree.getPathNode(parent);
	if (!parentPathNode) return 0;
	let count = 0;
	for (const child of parentPathNode.children) {
		if (child.DOMNode === node) return count;
		const eid = coreIds.getEid(child.DOMNode);
		if (eid !== undefined && eid !== null) count++;
	}
	return count;
}

/**
 * Wire ops for a freshly inserted DOM node (op.__node). A node whose eid the
 * server already knows is a move: sr plus sa at the current DOM position
 * (index by preceding-known count, parent by actual DOM parent — id-based,
 * so no path transformation is ever needed). Fresh nodes get a full subtree
 * emission with values from the op's own (frozen, record-time) li value; the
 * DOM is walked in parallel only to bind minted ids to nodes.
 * @param  {op}    op    json0 li op (with __node and the frozen li value).
 * @param  {object} entry Queue entry (for the attribute collapse skip list).
 * @return {[wireOp]|null} Wire ops, or null when out of ids.
 * @private
 */
function wireForFreshNode(op, entry) {
	const node = op.__node || nodeAtPath(op.p);
	if (!node) return [];
	// The parent comes from the op's own annotation first: moves are two
	// entries (detach ack'd and echoed first, re-insert translated later),
	// and the echo's detach can have removed the node from the DOM by the
	// time the re-insert is translated. Resolving by node.parentElement
	// there would orphan the op and turn the move into a deletion.
	const parent = op.__parent || node.parentElement || node.parentNode;
	if (!parent) return [];
	// Children of a template live in its content fragment; the wire parent
	// is the template itself.
	const container = parent.nodeType === document.DOCUMENT_FRAGMENT_NODE
		? coreIds.hostOf(parent) : parent;
	if (!container) return [];
	const parentEid = coreIds.eidOfContainer(container);
	if (parentEid === undefined || parentEid === null) return null;

	// The wire index comes from the op's own creation-time path (its last
	// element, less ELEMENT_LIST_OFFSET — json0 child slots start after the
	// tag and attribute object), NOT from a flush-time position: the pump is
	// serialized, so the server's state when it applies this op equals the
	// client model at op-creation time (the same op sequence, earlier
	// entries acked). A flush-time count (knownIndexOf) describes the node's
	// position in the FINAL DOM of the whole batch — under batched moves
	// (e.g. rotating siblings to the end) those final positions are not the
	// positions the server sees mid-sequence, and applying them scrambles
	// sibling order (each move lands "k positions too late", interleaving
	// the moved block with the rows that follow it). The op's path was
	// computed against the tree exactly as the model stood when the op was
	// created, which is the state the server will be in — so it is the
	// correct per-op index.
	const wireIndex = Array.isArray(op.p) && op.p.length > 0
		&& Number.isInteger(op.p[op.p.length - 1])
		? op.p[op.p.length - 1] - ELEMENT_LIST_OFFSET
		: knownIndexOf(container, node);

	const eid = coreIds.getEid(node);
	if (eid !== undefined && eid !== null && knownEids.has(eid)) {
		// Move: detach (a no-op when the same batch's ld already emitted an
		// sr) and re-attach at the op's recorded position.
		return [
			{ k: 'sr', e: eid, p: parentEid },
			{ k: 'sa', p: parentEid, i: wireIndex, e: eid,
				t: node.nodeType === document.ELEMENT_NODE ? WIRE_ELEMENT
					: (node.nodeType === document.TEXT_NODE ? WIRE_TEXT
						: WIRE_COMMENT),
				n: node.nodeType === document.ELEMENT_NODE ? node.tagName : null }
		];
	}

	// Fresh node: full subtree emission from the op's own value.
	const emitted = wireForCanonicalJml(op.li, parentEid, wireIndex, node, entry);
	return emitted.eid === null ? null : emitted.wire;
}

/**
 * Translate a queue entry's json0 ops to wire ops: per-op wire plus the
 * attribute collapse (one aa/ar per element and name with the entry's final
 * record-time value). Moves fall out of the li/ld branches (known-eid nodes
 * emit sr+sa); nothing is transformed against pending ops — the queue is
 * serialized, so the base version already contains every earlier local
 * commit. Returns null when ids ran out mid-translation (the pump retries
 * after a refill).
 * @param  {object} entry Queue entry ({ops, attrs}).
 * @return {[wireOp]|null} Wire ops, or null to retry after a refill.
 * @private
 */
function translateOutgoing(entry) {
	const wire = [];
	for (const op of entry.ops) {
		const result = translateOpOutgoing(op, entry);
		if (result === null) {
			return null;
		}
		// Parents an earlier op of this entry detached a node from by eid
		// (move pairs and leak recovery). The ld branch consults the set:
		// a positional slot sr into a parent whose old occupant was already
		// removed by eid hits the li's re-added node instead (the ops apply
		// sequentially), so it must not be emitted.
		for (const w of result) {
			if (w.k === 'sr' && w.e !== undefined && w.e !== null) {
				const node = coreIds.nodeOf(w.e);
				let detachParent = w.p;
				if (node) {
					const raw = node.parentElement || node.parentNode;
					const container = raw && raw.nodeType === document.DOCUMENT_FRAGMENT_NODE
						? coreIds.hostOf(raw) : raw;
					const pe = container
						? coreIds.eidOfContainer(container) : undefined;
					if (pe !== undefined && pe !== null) detachParent = pe;
				}
				if (detachParent !== undefined && detachParent !== null) {
					(entry.__srDetachParents = entry.__srDetachParents
						|| new Set()).add(detachParent);
				}
			}
		}
		wire.push(...result);
	}
	// Attribute collapse: whole-value aa (or ar) per element and attribute
	// name, with the value from the entry's last op touching it. The insert
	// position is the name's position in the element's live attribute list
	// (setAttribute semantics: an update stays in place, a new name takes
	// the current end), so concurrent local entries converge.
	for (const [element, nameMap] of entry.attrs) {
		const eid = coreIds.getEid(element);
		if (eid === undefined || eid === null) continue;
		for (const [rawName, value] of nameMap) {
			if (value === null) {
				wire.push({ k: 'ar', e: eid, n: rawName });
			} else {
				wire.push({ k: 'aa', e: eid,
					i: coreIds.attrPosition(element, rawName), n: rawName,
					v: coreUtils.unescape(value) });
			}
		}
	}
	return wire;
}

// ---------------------------------------------------------------------------
// Incoming translation: wire ops → json0 ops (+ registry updates)
// ---------------------------------------------------------------------------

/**
 * Serialized value of a live DOM node for move li ops (cached for the
 * client-side move stash, mirroring the server's detached-subtree stash).
 * The value is canonicalized (escaped attribute values), so state.data and
 * the applier's toHTML round-trip it exactly.
 * @param  {DOMNode} node Node (element, text or comment).
 * @return {{jml: JsonML, textMeta: [{eid}]}} Serialization + text metadata.
 * @private
 */
function serializeNode(node) {
	const textMeta = [];
	const collect = (n) => {
		if (n.nodeType !== document.ELEMENT_NODE) {
			textMeta.push({ eid: n.__eid });
			return;
		}
		coreUtils.getChildNodes(n).forEach((child) => {
			if (child.__pathNodes && child.__pathNodes.length > 0) collect(child);
		});
	};
	collect(node);
	return { jml: canonicalizeJml(coreJsonML.fromHTML(node)), textMeta };
}

/**
 * Queue eids for the text/comment nodes a toHTML of `jml` creates, in
 * pre-order — the DOMNodeInserted listener consumes them FIFO.
 * @param {JsonML}          jml      Serialized (canonical) value.
 * @param {[{eid}]}         textMeta Text metadata in pre-order.
 * @param {{i: int}}        offset   Shared cursor into textMeta.
 * @private
 */
function queueTextMetaInOrder(jml, textMeta, offset = { i: 0 }) {
	if (typeof jml === 'string' || typeof jml === 'number') {
		const meta = textMeta[offset.i];
		if (meta) coreIds.queueTextMeta(meta.eid);
		offset.i += 1;
		return;
	}
	if (Array.isArray(jml) && jml[0] === '!') {
		const meta = textMeta[offset.i];
		if (meta) coreIds.queueTextMeta(meta.eid);
		offset.i += 1;
		return;
	}
	if (Array.isArray(jml)) {
		for (let i = 1; i < jml.length; i++) {
			if (i === 1 && jml[i] && typeof jml[i] === 'object'
				&& !Array.isArray(jml[i])) continue;
			queueTextMetaInOrder(jml[i], textMeta, offset);
		}
	}
}

/**
 * The canonical attribute props object of the element at a json0 path.
 * @param  {JsonMLPath} elemPath Element path.
 * @return {object|null}          Props object (escaped values, &dot;-keys).
 * @private
 */
function propsAt(elemPath) {
	const props = exports.elementAtPath([...elemPath, ATTRIBUTE_INDEX]);
	return props && typeof props === 'object' ? props : null;
}

/**
 * The json0 path of a text or comment node's content STRING (without the
 * offset): text content sits at [...nodePath], comment content (the ['!',
 * content] array) at [...nodePath, 1].
 * @param  {DOMNode}     node     Text or comment node.
 * @param  {JsonMLPath}  nodePath The node's own path.
 * @return {JsonMLPath}          The content string's path.
 * @private
 */
function commentContentOps(node, nodePath) {
	return node.nodeType === document.COMMENT_NODE
		? [...nodePath, 1] : [...nodePath];
}

// ---------------------------------------------------------------------------
// Per-string edit logs
// ---------------------------------------------------------------------------

// Eids the server knows about (created or stashed by an acked or received
// commit). Outgoing move detection and the incoming known-count insertion
// rule both consult it; it grows with the document (bounded by the id
// counter, which is the same bound the server's mirror has).
const knownEids = new Set();

/**
 * Mark every node of a freshly adopted or rebuilt document as server-known.
 * Both paths start from the server's own structure, so all their eids exist
 * server-side already — without this, the incoming known-count insertion rule
 * would misplace inserts (it counts only server-known siblings).
 * @param {DOMElement} rootElement The <html> element of the final DOM.
 * @private
 */
function seedKnownEids(rootElement) {
	coreUtils.recursiveForEach(rootElement, (node) => {
		const eid = coreIds.getEid(node);
		if (eid !== undefined && eid !== null) knownEids.add(eid);
	});
}

// One log per string — element attribute values and text/comment content
// alike. The key is `${eid}:${rawName}` for an element attribute and
// `${eid}:` (empty name) for text/comment content: a node is either an
// element or a text/comment node, so the two cannot collide. `frame` holds
// incoming edits in server coordinates (each
// entry's q relative to the string as the server had it when the frame op
// applied); `pending` holds our outgoing edits in record-time coordinates,
// tagged with their entry id plus `replace` markers for whole-value
// attribute collapses. The two maps let both directions convert offsets
// without ever transforming pending json0 ops: the queue is serialized, so
// the commit base already contains every earlier local commit.
const stringLogs = new Map();

/**
 * The (create-on-demand) edit log for a string key.
 * @param  {string} key `${eid}:${rawName}` (empty name = content).
 * @return {{frame: [edit], pending: [edit]}} The log.
 * @private
 */
function stringLogFor(key) {
	let log = stringLogs.get(key);
	if (!log) {
		log = { frame: [], pending: [] };
		stringLogs.set(key, log);
	}
	return log;
}

/**
 * Forget a string's edit log (its node left the document or its attribute
 * was removed).
 * @param {string} key `${eid}:${rawName}` (empty name = content).
 * @private
 */
function clearStringLogs(key) {
	stringLogs.delete(key);
}

/**
 * Whether we hold a pending whole-value opinion on a string (an attribute
 * collapse): incoming string edits on it are dropped, since our pending
 * value overwrites whatever they insert.
 * @param  {string} key `${eid}:${rawName}` (empty name = content).
 * @return {bool}
 * @private
 */
function pendingReplaceExists(key) {
	const log = stringLogs.get(key);
	return !!log && log.pending.some((edit) => edit.replace && !edit.baked);
}

/**
 * Transform a list of string-range pieces through one edit. Pieces are
 * {q, s, l}: q the range start in the edit's post-state coordinates, s the
 * offset into the original fragment, l the surviving length. Inserts split
 * pieces (the inserted text is not ours to delete); deletes shrink and split
 * them (already-deleted chars vanish). `serverTie` picks the convention at
 * equal positions: true (a piece starting at the insert point shifts past
 * it — the server's transform) or false (the piece stays before it — our
 * pending edits were applied to the client string first).
 * @param  {[piece]} pieces    Pieces.
 * @param  {edit}    edit      {q, len, del} — insert when del is falsy.
 * @param  {bool}    serverTie Tie convention.
 * @return {[piece]}           Transformed pieces.
 * @private
 */
function applyEditToPieces(pieces, edit, serverTie) {
	const out = [];
	const eq = edit.q;
	const elen = edit.len;
	for (const piece of pieces) {
		const { q, s, l } = piece;
		if (l <= 0) continue;
		const b = q + l;
		if (!edit.del) {
			// An insert of elen chars at eq (occupying [eq, eq+elen) after).
			if (serverTie ? (q >= eq) : (q > eq)) {
				out.push({ q: q + elen, s, l });
			} else if (b > eq) {
				// Straddles the insert: split around the inserted text.
				out.push({ q, s, l: eq - q });
				out.push({ q: eq + elen, s: s + (eq - q), l: b - eq });
			} else {
				out.push(piece);
			}
		} else {
			// A delete of [eq, eq+elen) from the current coordinates.
			if (b <= eq) {
				out.push(piece);
			} else if (q >= eq + elen) {
				out.push({ q: q - elen, s, l });
			} else if (q < eq && b > eq + elen) {
				// Straddles the deleted range on both sides.
				out.push({ q, s, l: eq - q });
				out.push({ q: eq, s: s + (eq + elen - q), l: b - (eq + elen) });
			} else if (q >= eq && b <= eq + elen) {
				// Entirely inside the deleted range: gone.
			} else if (q < eq) {
				out.push({ q, s, l: eq - q });
			} else {
				out.push({ q: eq, s: s + (eq + elen - q), l: b - (eq + elen) });
			}
		}
	}
	return out.filter((piece) => piece.l > 0);
}

/**
 * The wire offset for a pending text/comment op: the record-time offset with
// the effects of other entries' pending edits (still unacked) removed and
// frame edits that arrived after the op was recorded re-applied — the state
// the commit's base version will be in when the server applies the op.
 * Same-commit siblings are not mapped (the server applies them sequentially);
 * whole-value replaces are not mapped either (the server clamps against the
 * new value itself).
 * @param  {string} key      String key.
 * @param  {int}    strVer   Index of the op's own edit in the pending log.
 * @param  {int}    frameVer Frame-log length when the op was recorded.
 * @param  {int}    q        Record-time offset.
 * @param  {int}    entryId  The op's queue entry.
 * @return {int}             Wire offset.
 * @private
 */
function mapOffsetForward(key, strVer, frameVer, q, entryId) {
	const log = stringLogs.get(key);
	if (!log) return q;
	// Pass 1: one consistent coordinate space. The live pendings' spans at
	// this op's record moment (pendSpanAt — frames and later pendings since
	// each one's record shifted it) are DISJOINT intervals in the DOM, so
	// remove them in a single ascending sweep. A sequential sweep that
	// compares the running (already shifted) offset against full-space
	// spans mixes coordinate systems: one strip can move the offset into a
	// later pending's stale span, and the clamp/strip mis-sort costs exactly
	// that pending's length. Baked-before-record pendings are skipped: the
	// server already held their text (their ack-frames are below frameVer,
	// part of the base — stripping them would never be re-added and the
	// wire offset would land too far left).
	const strips = [];
	const adds = [];
	for (let i = 0; i < Math.min(strVer, log.pending.length); i++) {
		const edit = log.pending[i];
		if (edit.entryId === entryId || edit.replace) continue;
		if (edit.baked && (edit.bakedFrameBase ?? Infinity) < frameVer) {
			continue;
		}
		const eq = pendSpanAt(log, i, frameVer, strVer);
		if (edit.del) adds.push([eq, edit.len]);
		else strips.push([eq, edit.len]);
	}
	strips.sort((a, b) => a[0] - b[0]);
	let shift = 0;
	let clamped = false;
	for (const [eq, elen] of strips) {
		if (q >= eq + elen) shift += elen;
		else if (q >= eq) { q = eq - shift; clamped = true; break; }
	}
	if (!clamped) {
		q -= shift;
		// Pending deletes: their text is gone client-side but still in the
		// base (the delete commits after this op's base): re-add it.
		adds.sort((a, b) => a[0] - b[0]);
		for (const [pq, plen] of adds) {
			if (q >= pq + plen) q += plen;
		}
	}
	for (let i = Math.min(frameVer, log.frame.length); i < log.frame.length; i++) {
		const edit = log.frame[i];
		if (edit.replace) continue;
		if (!edit.del) {
			if (edit.q <= q) q += edit.len;
		} else {
			if (edit.q + edit.len <= q) q -= edit.len;
			else if (edit.q < q) q = edit.q; // inside text the frame deleted
		}
	}
	return q;
}

/**
 * The wire range for a pending delete: like mapOffsetForward but over a
 * range, splitting it into surviving pieces (frame edits may interleave
 * with the deleted range). Returns {q, s, l} pieces: q the wire offset,
 * s/l the offset and length inside the original fragment.
 * @param  {string} key      String key.
 * @param  {int}    strVer   Index of the op's own edit in the pending log.
 * @param  {int}    frameVer Frame-log length when the op was recorded.
 * @param  {int}    q        Record-time offset.
 * @param  {int}    len      Fragment length.
 * @param  {int}    entryId  The op's queue entry.
 * @return {[piece]|null}    Pieces, or null when unmappable.
 * @private
 */
function mapRangeForward(key, strVer, frameVer, q, len, entryId) {
	const log = stringLogs.get(key);
	if (!log) return [{ q, s: 0, l: len }];
	let pieces = [{ q, s: 0, l: len }];
	// Pass 1 as one ascending sweep (see mapOffsetForward): the pendings'
	// spans are disjoint intervals in one coordinate space, applied in
	// position order with a running adjustment. A sequential full-space
	// sweep would mix coordinate systems. A pending insert strips its text
	// out of the range (del: true below); a pending delete re-adds its
	// text (del: false). Baked-before-record pendings are server-side and
	// skipped.
	const events = [];
	for (let i = 0; i < Math.min(strVer, log.pending.length); i++) {
		const edit = log.pending[i];
		if (edit.entryId === entryId || edit.replace) continue;
		if (edit.baked && (edit.bakedFrameBase ?? Infinity) < frameVer) {
			continue;
		}
		events.push({ p: pendSpanAt(log, i, frameVer, strVer),
			len: edit.len, add: !!edit.del });
	}
	events.sort((x, y) => x.p - y.p || (x.add ? 1 : -1));
	let shift = 0;
	for (const ev of events) {
		pieces = applyEditToPieces(pieces,
			{ q: ev.p + shift, len: ev.len, del: !ev.add }, true);
		shift += ev.add ? ev.len : -ev.len;
	}
	for (let i = Math.min(frameVer, log.frame.length); i < log.frame.length; i++) {
		const edit = log.frame[i];
		if (edit.replace) continue;
		pieces = applyEditToPieces(pieces, edit, true);
	}
	return pieces;
}

/**
 * A pending edit's offset as it stood in the client string at any past
 * moment: the client-string lineage replayed forward from the edit's
 * record. Each frame that arrived after it shifts the span at the frame's
 * own client-side insert position (foreign frames only — an ack-frame
 * commits text that is already in the client string), and each later
 * pending shifts it where that pending's own text went in. Record-time
 * offsets alone are stale whenever a frame arrived between two pendings'
 * records: the later pending's coordinates then include the frame's text,
 * the earlier one's do not, and every span comparison between them is off
 * by exactly that difference.
 * @param  {log}  log       The string's edit log.
 * @param  {int}  idx       Index of the pending edit in log.pending.
 * @param  {int}  frameVer  Frame-log length at the target moment.
 * @param  {int}  upto      Pending-log length at the target moment.
 * @return {int}            The edit's offset there (span start for inserts,
 *                          the collapsed point for deletes).
 * @private
 */
function pendSpanAt(log, idx, frameVer, upto) {
	const edit = log.pending[idx];
	let lo = edit.q;
	let fi = edit.frameVer || 0;
	// Frames are logged with the server offset they carry AND the client
	// offset they were applied at; the client one is what moves live
	// pendings around in this lineage. Foreign deletes split into pieces,
	// each at its own client offset.
	const applyFrames = (end) => {
		for (; fi < end && fi < log.frame.length; fi++) {
			const f = log.frame[fi];
			if (f.replace || f.ack) continue;
			if (!f.del) {
				if (f.cq <= lo) lo += f.len;
			} else {
				for (const piece of f.pieces || []) {
					if (piece.q + piece.l <= lo) lo -= piece.l;
					else if (piece.q < lo) lo = piece.q;
				}
			}
		}
	};
	// Pendings are recorded with the frame log at their frameVer, so the
	// interleave is: frames up to the next pending's frameVer, then that
	// pending's own insertion.
	for (let k = idx + 1; k < upto && k < log.pending.length; k++) {
		const p = log.pending[k];
		applyFrames(p.frameVer || 0);
		if (p.replace) continue;
		if (!p.del) {
			if (p.q <= lo) lo += p.len;
		} else if (p.q + p.len <= lo) {
			lo -= p.len;
		} else if (p.q < lo) {
			lo = p.q;
		}
	}
	applyFrames(frameVer);
	return lo;
}

/**
 * A pending edit's server-anchored offset: its record-time offset with the
 * effects of earlier pendings removed (they are client-only) and the frame
 * edits recorded after it re-applied (they are server-side now). This is
 * the position the edit occupies in the SERVER's current string — the
 * coordinate incoming offsets live in. (Comparing an incoming server offset
 * against record-time offsets is wrong whenever frames arrived since the
 * pending was recorded: the two spaces then differ by exactly those frame
 * edits and the earlier pendings.)
 * @param  {log}  log The string's edit log.
 * @param  {int}  idx Index of the pending edit in log.pending.
 * @return {int}     Server-anchored offset.
 * @private
 */
function pendingServerOffset(log, idx) {
	const edit = log.pending[idx];
	let a = edit.q;
	// Pass 1: one-pass interval removal (see mapOffsetForward's pass 1) —
	// the earlier live pendings' spans at THIS pending's record moment, in
	// one coordinate space. Pendings already baked before this edit was
	// recorded were server-side then — their text is in the base at record
	// time, so they must NOT be removed.
	const strips = [];
	const adds = [];
	for (let j = 0; j < idx; j++) {
		const p = log.pending[j];
		if (p.replace) continue;
		if (p.baked && (p.bakedFrameBase ?? Infinity) < (edit.frameVer || 0)) {
			continue;
		}
		const pq = pendSpanAt(log, j, edit.frameVer || 0, idx);
		if (p.del) adds.push([pq, p.len]);
		else strips.push([pq, p.len]);
	}
	strips.sort((x, y) => x[0] - y[0]);
	let shift = 0;
	let clamped = false;
	for (const [pq, plen] of strips) {
		if (a >= pq + plen) shift += plen;
		else if (a >= pq) { a = pq - shift; clamped = true; break; }
	}
	if (!clamped) {
		a -= shift;
		adds.sort((x, y) => x[0] - y[0]);
		for (const [dq, dlen] of adds) {
			if (a >= dq + dlen) a += dlen;
		}
	}
	// Pass 2: apply frame edits recorded after this pending (mirroring
	// mapOffsetForward's pass 2 — including its tie: a frame insert at the
	// pending's position shifts it right, committed-first wins the left
	// slot).
	for (let j = edit.frameVer || 0; j < log.frame.length; j++) {
		const f = log.frame[j];
		if (f.replace) continue;
		if (!f.del) {
			if (f.q <= a) a += f.len;
		} else {
			if (f.q + f.len <= a) a -= f.len;
			else if (f.q < a) a = f.q;
		}
	}
	return a;
}

/**
 * The client offset for an incoming frame op: the server offset with our
 * pending edits applied (they are already in the client's string), each
 * compared at its server-anchored position. The client tie convention: at
 * equal positions the frame's edit lands before our pending insert — the
 * server, having committed the frame first, transforms our pending past
 * it (committed-first wins the left slot).
 * @param  {string} key  String key.
 * @param  {int}    q    Server offset.
 * @param  {int}    [upto] Only map over the first `upto` pendings (used
 *                  recursively for the pending-delete clamp).
 * @return {int}        Client offset.
 * @private
 */
function mapIncomingOffset(key, q, upto) {
	const log = stringLogs.get(key);
	if (!log) return q;
	const end = Math.min(upto ?? log.pending.length, log.pending.length);
	// Every comparison happens in the SERVER's coordinate space: the raw
	// incoming offset against each pending's server-anchored position, with
	// the shifts accumulated only into the result. Comparing the running
	// (already shifted) offset against the anchors double-counts earlier
	// pendings and pushes incoming text past pendings it belongs before
	// (live pendings are all still in the client string, stacked in commit
	// order at their server anchors).
	let raw = q;
	let c = q;
	for (let i = 0; i < end; i++) {
		const edit = log.pending[i];
		if (edit.replace || edit.baked) continue;
		const a = pendingServerOffset(log, i);
		if (!edit.del) {
			if (raw > a) c += edit.len;
		} else if (raw >= a + edit.len) {
			c -= edit.len;
		} else if (raw > a) {
			// Inside text our pending delete removes: the insert lands at
			// the deletion's client-side start, whose own mapping runs
			// over the earlier pendings.
			c = mapIncomingOffset(key, a, i);
			raw = a;
		}
	}
	return c;
}

/**
 * The client range for an incoming frame delete: the server range with our
 * pending edits applied (at their server-anchored positions), split into
 * surviving pieces.
 * @param  {string} key String key.
 * @param  {int}    q   Server offset.
 * @param  {int}    len Range length.
 * @return {[piece]}    Pieces in client coordinates.
 * @private
 */
function mapIncomingRange(key, q, len) {
	const log = stringLogs.get(key);
	if (!log) return [{ q, s: 0, l: len }];
	// Work in the server's coordinate space: our pending inserts inside the
	// range survive the delete (they were applied to the client string
	// first) and split it; pending deletes overlapping the range have
	// already removed their text client-side, so the frame cannot delete
	// it again. Each surviving piece's client offset maps through
	// mapIncomingOffset (server-anchored comparisons throughout).
	const events = [];
	for (let i = 0; i < log.pending.length; i++) {
		const edit = log.pending[i];
		if (edit.replace || edit.baked) continue;
		const a = pendingServerOffset(log, i);
		if (!edit.del) {
			if (a > q && a < q + len) events.push({ at: a, end: a, ins: true });
		} else if (a < q + len && a + edit.len > q) {
			events.push({ at: Math.max(a, q), end: Math.min(a + edit.len, q + len),
				ins: false });
		}
	}
	events.sort((x, y) => x.at - y.at || (x.ins ? -1 : 1));
	const spans = [];
	let f = q;
	for (const ev of events) {
		if (ev.at > f) spans.push([f, ev.at]);
		f = Math.max(f, ev.ins ? ev.at : ev.end);
	}
	if (q + len > f) spans.push([f, q + len]);
	return spans.map(([f1, f2]) => ({ q: mapIncomingOffset(key, f1),
		s: f1 - q, l: f2 - f1 })).filter((piece) => piece.l > 0);
}

/**
 * Replay our pending (unacked) string edits for one (e, x) on top of a
 * server-side value — the exact composition the server will produce when the
 * pending ops land after the frame: inserts clamped into the new value,
 * deletes only where the fragment still matches (the server drops the rest).
 * @param  {string} key    String key (`${e}:${x}`).
 * @param  {string} value  Server-side (frame) value.
 * @return {string}        The value with pending edits applied.
 * @private
 */
function applyPendingToString(key, value) {
	const log = stringLogs.get(key);
	if (!log) return value;
	let target = value;
	for (let i = 0; i < log.pending.length; i++) {
		const edit = log.pending[i];
		if (edit.replace || edit.baked) continue; // a pending replace keeps its own value
		// The pending's place in the new server value: its server-anchored
		// offset, shifted past the earlier live pendings that land before
		// it (record order at equal anchors — they commit in that order).
		// The comparisons stay in the server-anchored space (raw anchor vs
		// raw anchor); only the result accumulates the shifts — comparing
		// the running offset against raw anchors double-counts the
		// pendings already passed and misplaces later-anchored pendings.
		const anchor = pendingServerOffset(log, i);
		let q = anchor;
		for (let j = 0; j < i; j++) {
			const p = log.pending[j];
			// Only LIVE pendings land on target — baked ones' text is
			// already in the server value (their ack-frames), and this
			// edit's anchor already sits in that full server space.
			if (p.replace || p.baked) continue;
			const pa = pendingServerOffset(log, j);
			if (!p.del) {
				if (anchor > pa || (anchor === pa && j < i)) q += p.len;
			} else if (anchor >= pa + p.len) {
				q -= p.len;
			} else if (anchor > pa || (anchor === pa && j < i)) {
				// Inside a pending delete's range: land at its start,
				// itself shifted past the earlier live pendings.
				let a2 = pa;
				for (let k = 0; k < j; k++) {
					const pk = log.pending[k];
					if (pk.replace || pk.baked) continue;
					const pka = pendingServerOffset(log, k);
					if (!pk.del) {
						if (pa > pka || (pa === pka && k < j)) a2 += pk.len;
					} else if (pa >= pka + pk.len) {
						a2 -= pk.len;
					}
				}
				q = a2;
			}
		}
		q = Math.max(0, Math.min(q, target.length));
		if (!edit.del) {
			target = target.slice(0, q) + edit.v + target.slice(q);
		} else if (target.slice(q, q + edit.v.length) === edit.v) {
			target = target.slice(0, q) + target.slice(q + edit.v.length);
		}
	}
	return target;
}

/**
 * Translate one {wa: 'ops'} frame (a commit's final effective wire ops) into
 * json0 ops for the applier, updating the eid registry and the client-side
 * move stash along the way.
 * @param  {[wireOp]} frameOps The frame's ops.
 * @return {{ops: [op], rootTouched: bool}} json0 ops (+ root flag).
 * @private
 */
function translateIncoming(frameOps) {
	const ops = [];
	const stash = new Map(); // eid → {jml, textMeta} (this batch's sr'd subtrees)
	const pending = new Map(); // eid → placeholder (this batch's fresh subtrees)
	const pendingRoots = []; // eids in first-sa order

	let rootTouched = false;

	// The frame's nodes are server-known from now on — the known-count
	// insertion rule counts them when several fresh roots land in one
	// parent, and outgoing move detection relies on the set.
	for (const op of frameOps) {
		if (op.k === 'sa') knownEids.add(op.e);
	}

	const pathOf = (node) => {
		const pathNode = corePathTree.getPathNode(node);
		return pathNode ? pathNode.toPath() : null;
	};

	// The json0 insertion path of a wire (p, i) pair. The wire index counts
	// only the parent's server-known children, but the client's child list
	// also holds uncommitted local ones — so the insertion lands immediately
	// after the `index`-th server-known child, never skipping local ones (the
	// server's transform convention puts a later local insert after an
	// incoming one at the same position).
	const insertionPath = (parentEid, index) => {
		if (parentEid === 0) return [ELEMENT_LIST_OFFSET + index];
		const parent = coreIds.nodeOf(parentEid);
		const parentPathNode = parent && corePathTree.getPathNode(parent);
		if (!parentPathNode) return null;
		const kids = parentPathNode.children;
		let knownSeen = 0;
		let insertAt = 0;
		for (let i = 0; i < kids.length; i++) {
			if (knownSeen >= index) break;
			const eid = coreIds.getEid(kids[i].DOMNode);
			if (eid !== undefined && eid !== null && knownEids.has(eid)) {
				knownSeen++;
				insertAt = i + 1;
			}
		}
		return [...parentPathNode.toPath(), ELEMENT_LIST_OFFSET + insertAt];
	};

	// pathOf() above resolves a node against the pre-frame DOM, but the
	// emitted ops apply sequentially — a structural op emitted earlier in
	// this same frame (an ld from an sr or a move, the paired li of a move
	// or stash re-attach) shifts the slots of everything after it in the
	// same list. Every pathOf()-based path must therefore be adjusted past
	// the frame's own earlier structural ops, and ops addressing a removed
	// subtree drop (the server never edits a detached node — the one
	// exception, a same-frame move + edit of the same node, is a known gap
	// until the move's li learns to carry them). insertionPath() results
	// need no adjustment: their known-count semantics already land them
	// relative to the earlier ops by construction, and the pending li
	// flush runs after every pathOf() call anyway.
	const frameMoves = [];
	const livePath = (node) => {
		const raw = pathOf(node);
		if (raw === null) return null;
		let path = raw;
		for (const move of frameMoves) {
			const movePath = move.path;
			const d = movePath.length - 1;
			if (d >= path.length) continue;
			let sharesList = true;
			for (let i = 0; i < d; i++) {
				if (path[i] !== movePath[i]) { sharesList = false; break; }
			}
			if (!sharesList) continue;
			if (move.insert) {
				if (path[d] >= movePath[d]) {
					path = path.slice();
					path[d]++;
				}
			} else {
				if (path[d] === movePath[d]) return null; // removed subtree
				if (path[d] > movePath[d]) {
					path = path.slice();
					path[d]--;
				}
			}
		}
		return path;
	};

	// Build the placeholder tree for a fresh eid.
	const placeholder = (op) => {
		pending.set(op.e, { eid: op.e, t: op.t, n: op.n, attrs: {}, content: null,
			kids: [], parent: op.p, index: op.i, z: op.z === true });
		pendingRoots.push(op.e);
		if (op.p === 0) rootTouched = true;
	};

	// Emit li ops for the pending trees, in first-sa order (parents precede
	// their children, so nested trees come out nested), queueing text
	// metadata in creation order as we go.
	const flushPending = () => {
		// Attach pending children to their pending parents.
		for (const entry of pending.values()) {
			if (entry.parent !== 0 && pending.has(entry.parent)) {
				pending.get(entry.parent).kids.push(entry);
			}
		}
		for (const entry of pending.values()) {
			entry.kids.sort((a, b) => a.index - b.index);
		}
		const flushed = new Set();
		const build = (entry) => {
			if (entry.t === WIRE_TEXT) {
				const value = entry.content !== null ? entry.content : '';
				// A rebuilt string whose eid we had pending edits on: the
				// pending diffs commit after this frame server-side, so they
				// must be baked into the rebuilt value here.
				return applyPendingToString(`${entry.eid}:`, value);
			}
			if (entry.t === WIRE_COMMENT) {
				const value = entry.content !== null ? entry.content : '';
				return ['!', applyPendingToString(`${entry.eid}:`, value)];
			}
			const props = { __wid: entry.eid };
			for (const [name, value] of Object.entries(entry.attrs)) {
				props[coreUtils.escapeDots(name)] = coreUtils.escape(value);
			}
			const jml = [entry.n, props];
			for (const child of entry.kids) {
				jml.push(build(child));
			}
			return jml;
		};
		for (const rootEid of pendingRoots) {
			const root = pending.get(rootEid);
			// Trees nested into an earlier flush are already emitted.
			if (!root || flushed.has(rootEid)) continue;
			const liPath = insertionPath(root.parent, root.index);
			if (liPath === null) continue; // parent gone: idempotent skip
			// Mark the whole tree flushed.
			const mark = (entry) => {
				flushed.add(entry.eid);
				entry.kids.forEach(mark);
			};
			mark(root);
			const textMeta = [];
			const collect = (entry) => {
				if (entry.t !== WIRE_ELEMENT) {
					textMeta.push({ eid: entry.eid });
					return;
				}
				entry.kids.forEach(collect);
			};
			collect(root);
			const jml = build(root);
			ops.push({ p: liPath, li: jml });
			queueTextMetaInOrder(jml, textMeta);
		}
	};

	for (const op of frameOps) {
		switch (op.k) {
			case 'sa': {
				const existing = coreIds.nodeOf(op.e);
				const stashed = stash.get(op.e);

				// The stash is checked first: for a same-batch move the sr
				// already emitted an ld for the node, but it is still in the
				// registry until the ops actually apply, so `existing` alone
				// cannot distinguish a move from a re-attach.
				if (stashed) {
					// Re-attach a subtree detached earlier in this same batch
					// (same-commit move): the stash holds its serialization.
					const liPath = insertionPath(op.p, op.i);
					if (liPath === null) break;
					ops.push({ p: liPath, li: stashed.jml });
					frameMoves.push({ path: liPath, insert: true });
					queueTextMetaInOrder(stashed.jml, stashed.textMeta);
					stash.delete(op.e);
					break;
				}

				if (existing) {
					// A live node is being sa'd. The detached test comes FIRST:
					// a node the registry remembers from an earlier commit that
					// detached it (nodeOf holds recently-detached nodes, and
					// DOMNodeDeleted fired for the removal ROOT only — a
					// descendant's entry lingers while the node went away with
					// its parent) is a node we no longer have. The server is
					// re-attaching from ITS stash, so the z re-attach of that
					// descendant MUST NOT be skipped: dropping it rebuilt the
					// parent EMPTY on every watching client, whose reactive
					// handlers then re-inserted fresh content while the server
					// kept the old — accumulating glued duplicates. Forget the
					// lingering registry entries (so this frame's descendant
					// ops and text metadata rebuild it) and placeholder the
					// subtree. The server re-sends attrs, contents and
					// synthetic ops for exactly this case — the same way a
					// client that never saw the subtree rebuilds it.
					if (!nodeAttached(existing)) {
						const forgetSubtree = (n) => {
							coreIds.forget(n);
							for (const c of n.childNodes) forgetSubtree(c);
						};
						forgetSubtree(existing);
					} else if (op.z === true) {
						// Synthetic re-attach ops (z) of a node ATTACHED to the
						// document mean the client missed nothing: its subtree
						// is intact, and the position (if any) was carried by
						// the real, non-z root sa.
						break;
					} else {
						// Otherwise this is a move: ld + li at the wire
						// position.
						const currentPath = livePath(existing);
						const liPath = insertionPath(op.p, op.i);
						if (currentPath === null || liPath === null) break;
						const { jml, textMeta } = serializeNode(existing);
						if (jml === null) break;
						ops.push({ ld: jml, p: currentPath });
						ops.push({ p: liPath, li: jml });
						frameMoves.push({ path: currentPath, insert: false });
						frameMoves.push({ path: liPath, insert: true });
						queueTextMetaInOrder(jml, textMeta);
						break;
					}
				}

				// Not live, not stashed: a fresh node — unless its parent is
				// neither live nor pending (the op replays a context we don't
				// have; the idempotent skip).
				const parentLive = op.p === 0 || coreIds.nodeOf(op.p) !== undefined;
				const parentPending = pending.has(op.p);
				if (!parentLive && !parentPending) break;
				placeholder(op);
				placeholder(op);
				break;
			}
			case 'sr': {
				const node = coreIds.nodeOf(op.e);
				// Already gone (idempotent): either never known, or removed in
				// an earlier commit — nodeOf keeps recently-detached nodes, but
				// their path-tree positions are stale and must not be ld'd.
				// (nodeAttached, not isConnected: template-content nodes are
				// attached through their host and must not read as gone.)
				if (!node || !nodeAttached(node)) break;
				const currentPath = livePath(node);
				if (currentPath === null) break;
				const { jml, textMeta } = serializeNode(node);
				if (jml === null) break;
				ops.push({ ld: jml, p: currentPath });
				frameMoves.push({ path: currentPath, insert: false });
				stash.set(op.e, { jml, textMeta });
				if (op.e === document.documentElement.__wid) rootTouched = true;
				break;
			}
			case 'aa': {
				const entry = pending.get(op.e);
				if (entry) {
					if (op.n === null) {
						entry.content = op.v;
						// A rebuilt string continues under the same eid; our
						// pending diffs on it must land on the new value, so
						// the frame log records the replacement (see the live
						// aa case below for why pending diffs survive).
						stringLogFor(`${op.e}:`).frame.push(
							{ replace: true, newLen: op.v.length });
					} else {
						entry.attrs[op.n] = op.v;
					}
					break;
				}
				const node = coreIds.nodeOf(op.e);
				if (!node) break;
				if (node.nodeType !== document.ELEMENT_NODE) {
					// Content of a live text/comment node: a full replace. Any
					// pending local diffs on this string commit AFTER this
					// frame server-side, so they must live on top of the new
					// value: apply the pending diffs to it (inserts clamped,
					// deletes only when they still match), exactly as the
					// server will apply the pending ops.
					const nodePath = livePath(node);
					if (nodePath === null) break;
					const key = `${op.e}:`;
					const base = commentContentOps(node, nodePath);
					const target = applyPendingToString(key, op.v);
					const current = node.data || '';
					if (current !== target) {
						if (current) ops.push({ sd: current, p: [...base, 0] });
						if (target) ops.push({ si: target, p: [...base, 0] });
					}
					stringLogFor(key).frame.push({ replace: true, newLen: op.v.length });
					break;
				}
				const elemPath = livePath(node);
				if (elemPath === null) break;
				// A pending local replace of the same attribute commits after
				// this frame and overwrites it server-side — skip (our value
				// is already in the model and DOM).
				if (pendingReplaceExists(`${op.e}:${op.n}`)) break;
				const canonicalKey = coreUtils.escapeDots(op.n);
				const currentProps = propsAt(elemPath);
				const currentValue = currentProps ? currentProps[canonicalKey] : undefined;
				const newValue = coreUtils.escape(op.v);
				if (currentValue === newValue) break;
				const attrOp = { p: [...elemPath, ATTRIBUTE_INDEX, canonicalKey],
					oi: newValue };
				if (currentValue !== undefined) attrOp.od = currentValue;
				ops.push(attrOp);
				// Attribute-order materialization: when the server inserts an
				// attribute our DOM does not have (a concurrent client's
				// append committed before ours) the insert position is BELOW
				// our own optimistic tail. setAttribute can only append, so
				// the DOM order would diverge from the mirror's forever — and
				// positions are load-bearing. Re-home the tail instead: each
				// modeled attribute at or beyond the insert position gets an
				// od+oi pair (delete + re-add), which moves it after the new
				// one in the DOM and in the model's props object alike. The
				// pairs must run in FORWARD order — each pair moves its attr
				// to the end, so taking the earliest survivor first leaves the
				// tail in its original relative order (backward order would
				// reverse it: [a,b,B,C] + insert A@2 → [a,b,A,C,B]).
				if (currentValue === undefined && Number.isInteger(op.i)) {
					const tail = coreIds.modeledAttrList(node);
					for (let k = op.i; k < tail.length; k++) {
						const attr = tail[k];
						if (attr.name === op.n) continue;
						const tailKey = coreUtils.escapeDots(attr.name);
						const tailValue = coreUtils.escape(attr.value);
						ops.push({ od: tailValue,
							p: [...elemPath, ATTRIBUTE_INDEX, tailKey] });
						ops.push({ oi: tailValue,
							p: [...elemPath, ATTRIBUTE_INDEX, tailKey] });
					}
				}
				break;
			}
			case 'ar': {
				const node = coreIds.nodeOf(op.e);
				if (!node || node.nodeType !== document.ELEMENT_NODE) break;
				const elemPath = livePath(node);
				if (elemPath === null) break;
				// Clients send the name (a removal is name-anchored: the DOM's
				// ordered list shifts, so a position would be ambiguous
				// against concurrent inserts — the server resolved all that
				// and hands us the survivor's name). The position form
				// ({e, i}, no name) is kept for raw/fuzz clients: resolve the
				// name through the live DOM's modeled list.
				const rawName = typeof op.n === 'string'
					? op.n : coreIds.attrNameAt(node, op.i);
				if (!rawName) break;
				const canonicalKey = coreUtils.escapeDots(rawName);
				const currentProps = propsAt(elemPath);
				const currentValue = currentProps ? currentProps[canonicalKey] : undefined;
				clearStringLogs(`${op.e}:${rawName}`);
				if (currentValue === undefined) break;
				ops.push({ od: currentValue,
					p: [...elemPath, ATTRIBUTE_INDEX, canonicalKey] });
				break;
			}
			case 'si':
			case 'sd': {
				const isInsert = op.k === 'si';
				const node = coreIds.nodeOf(op.e);
				if (!node) break;
				if (node.nodeType === document.ELEMENT_NODE) {
					// Attribute string edit: whole-value replace against a raw
					// shadow of the current value (the model's is canonical).
					// Dropped when a pending local replace exists — it wins
					// server-side, exactly like the aa case above. The name
					// comes from the live DOM's modeled list at the wire
					// position (si/sd attr ops are position-addressed).
					const rawName = coreIds.attrNameAt(node, op.i);
					if (!rawName) break;
					if (pendingReplaceExists(`${op.e}:${rawName}`)) break;
					const elemPath = livePath(node);
					if (elemPath === null) break;
					const canonicalKey = coreUtils.escapeDots(rawName);
					const currentProps = propsAt(elemPath);
					const currentValue = currentProps
						? currentProps[canonicalKey] : undefined;
					let newRaw;
					if (typeof currentValue !== 'string') {
						// The attribute does not exist client-side: adopt the
						// fragment as the whole value.
						newRaw = isInsert ? op.v : '';
					} else {
						const rawValue = coreUtils.unescape(currentValue);
						newRaw = isInsert
							? rawValue.slice(0, op.q) + op.v + rawValue.slice(op.q)
							: (rawValue.slice(0, op.q) + op.v === rawValue.slice(0,
								op.q + op.v.length)
								? rawValue.slice(0, op.q)
									+ rawValue.slice(op.q + op.v.length)
								: rawValue);
					}
					const attrPath = [...elemPath, ATTRIBUTE_INDEX, canonicalKey];
					const attrOp = { p: attrPath, oi: coreUtils.escape(newRaw) };
					if (typeof currentValue === 'string') attrOp.od = currentValue;
					ops.push(attrOp);
					break;
				}
				if (node.nodeType === document.TEXT_NODE
					|| node.nodeType === document.COMMENT_NODE) {
					const nodePath = livePath(node);
					if (nodePath === null) break;
					// A text/comment node has exactly one modeled string (its
					// content) — the eid alone addresses it.
					const key = `${op.e}:`;
					const base = commentContentOps(node, nodePath);
					if (isInsert) {
						const q = mapIncomingOffset(key, op.q);
						if (q === null) break; // pending replace wins
						ops.push({ p: [...base, q],
							si: op.v });
						// cq: where the frame's text went in the CLIENT
						// string — pendSpanAt needs it to replay this frame's
						// effect on live pendings' spans (the server offset
						// cannot: pendings live in client coordinates).
						stringLogFor(key).frame.push({ q: op.q, len: op.v.length,
							del: false, cq: q });
					} else {
						const pieces = mapIncomingRange(key, op.q, op.v.length);
						const applied = [];
						for (const piece of pieces) {
							if (piece.l <= 0) continue;
							applied.push({ q: piece.q, l: piece.l });
							ops.push({ p: [...base, piece.q],
								sd: op.v.slice(piece.s, piece.s + piece.l) });
						}
						stringLogFor(key).frame.push({ q: op.q, len: op.v.length,
							del: true, pieces: applied });
					}
					break;
				}
				break;
			}
		}
	}
	flushPending();
	return { ops, rootTouched };
}

// ---------------------------------------------------------------------------
// Wire ops → json0 replay (for the public getOps: a scratch JsonML mirror
// per commit, mirroring the server's move stash; no DOM involvement)
// ---------------------------------------------------------------------------

/**
 * Translate a list of commit log entries (wire ops) into json0 op entries,
 * replaying them on a scratch mirror so paths and positions are exact. The
 * scratch uses the server's own index semantics: kids arrays splice (a sa
 * clamps its index, an sr removes and shifts).
 * @param  {[{v, base, ops, src, ...}]} commits Commit log entries.
 * @return {[{v, base, ops, src, ...}]}        Entries with json0 ops.
 * @private
 */
function commitsWireToJson0(commits) {
	const mirror = new Map([[0, { p: null, i: null, t: WIRE_ELEMENT, n: null,
		kids: [], attrs: [], content: null }]]);
	const stash = new Map();

	const pathOf = (eid) => {
		const entry = mirror.get(eid);
		if (!entry || entry.p === null) return null;
		// The root's first child is the <html> element — in json0 it IS the
		// document array, so its path is [] (its children sit at [2+index]).
		if (entry.p === 0) return entry.i === 0 ? [] : null;
		const parentPath = pathOf(entry.p);
		return parentPath === null ? null
			: [...parentPath, ELEMENT_LIST_OFFSET + entry.i];
	};

	const materializeFrom = (source, eid) => {
		const entry = source.get(eid);
		if (!entry) return null;
		if (entry.t === WIRE_TEXT) return entry.content ? entry.content.v : '';
		if (entry.t === WIRE_COMMENT) {
			return ['!', entry.content ? entry.content.v : ''];
		}
		const props = { __wid: eid };
		for (const { n, v } of entry.attrs) {
			props[coreUtils.escapeDots(n)] = coreUtils.escape(v);
		}
		const jml = [entry.n, props];
		entry.kids.forEach((kid) => jml.push(materializeFrom(source, kid)));
		return jml;
	};

	const cloneValue = (value) => (typeof value === 'string'
		? value : JSON.parse(JSON.stringify(value)));

	const attach = (op, ops) => {
		const stashed = stash.get(op.e);
		const entry = stashed || { p: op.p, i: op.i, t: op.t, n: op.n, kids: [],
			attrs: [], content: null };
		if (stashed) {
			stash.delete(op.e);
			entry.t = op.t;
			entry.n = op.n;
		}
		entry.p = op.p;
		const parent = mirror.get(op.p);
		if (!parent) return; // idempotent skip
		const clamped = Math.min(op.i, parent.kids.length);
		parent.kids.splice(clamped, 0, op.e);
		entry.i = parent.kids.indexOf(op.e);
		mirror.set(op.e, entry);
		const parentPath = pathOf(op.p);
		const materialized = cloneValue(materializeFrom(mirror, op.e));
		ops.push({ p: parentPath === null ? null
			: [...parentPath, ELEMENT_LIST_OFFSET + entry.i], li: materialized });
	};

	const detach = (op, ops, prePath) => {
		const entry = mirror.get(op.e);
		if (!entry) return; // idempotent skip
		const parent = mirror.get(entry.p);
		const idx = parent ? parent.kids.indexOf(op.e) : -1;
		if (parent && idx !== -1) parent.kids.splice(idx, 1);
		mirror.delete(op.e);
		stash.set(op.e, entry);
		ops.push({ ld: cloneValue(materializeFrom(stash, op.e)), p: prePath });
	};

	return commits.map((commit) => {
		const ops = [];
		const prePaths = new Map();
		for (const op of commit.ops) {
			if (op.k === 'sr' && mirror.has(op.e)) {
				prePaths.set(op.e, pathOf(op.e));
			}
		}
		for (const op of commit.ops) {
			switch (op.k) {
				case 'sa': {
					if (mirror.has(op.e)) break; // attached already (z re-attach)
					attach(op, ops);
					break;
				}
				case 'sr': {
					detach(op, ops, prePaths.get(op.e) || null);
					break;
				}
				case 'aa': {
					const entry = mirror.get(op.e) || stash.get(op.e);
					if (!entry) break;
					if (op.n === null) {
						const previous = entry.content ? entry.content.v : '';
						if (previous === op.v) break; // idempotent replay
						const path = pathOf(op.e);
						if (path !== null) {
							if (entry.t === WIRE_COMMENT) {
								if (previous) ops.push({ sd: previous, p: [...path, 1, 0] });
								if (op.v) ops.push({ si: op.v, p: [...path, 1, 0] });
							} else {
								if (previous) ops.push({ sd: previous, p: [...path, 0] });
								if (op.v) ops.push({ si: op.v, p: [...path, 0] });
							}
						}
						entry.content = { v: op.v };
						break;
					}
					// Name-anchored: an existing name updates in place (its
					// position is the list position), a new name inserts at
					// the local position i (clamped) — the ordered array IS
					// the position map, mirroring the server.
					const existing = entry.attrs.find((a) => a.n === op.n);
					const path = pathOf(op.e);
					if (existing) {
						if (existing.v === op.v) break;
						if (path !== null) {
							ops.push({ p: [...path, ATTRIBUTE_INDEX,
								coreUtils.escapeDots(op.n)], od: coreUtils.escape(existing.v),
							oi: coreUtils.escape(op.v) });
						}
						existing.v = op.v;
						break;
					}
					const at = Number.isInteger(op.i)
						? Math.min(op.i, entry.attrs.length) : entry.attrs.length;
					entry.attrs.splice(at, 0, { n: op.n, v: op.v });
					if (path !== null) {
						ops.push({ p: [...path, ATTRIBUTE_INDEX,
							coreUtils.escapeDots(op.n)], oi: coreUtils.escape(op.v) });
					}
					break;
				}
				case 'ar': {
					const entry = mirror.get(op.e);
					if (!entry) break;
					// Name form (what clients and the history emit); the
					// position form ({e, i}) resolves through the ordered
					// list — the name is what json0 needs.
					const idx = typeof op.n === 'string'
						? entry.attrs.findIndex((a) => a.n === op.n)
						: (Number.isInteger(op.i) ? op.i : -1);
					const attr = idx >= 0 && idx < entry.attrs.length
						? entry.attrs[idx] : null;
					if (!attr) break;
					entry.attrs.splice(idx, 1);
					const path = pathOf(op.e);
					if (path !== null) {
						ops.push({ od: coreUtils.escape(attr.v),
							p: [...path, ATTRIBUTE_INDEX, coreUtils.escapeDots(attr.n)] });
					}
					break;
				}
				case 'si':
				case 'sd': {
					const isInsert = op.k === 'si';
					const entry = mirror.get(op.e);
					if (!entry) break;
					const path = pathOf(op.e);
					if (path === null) break;
					if (entry.t !== WIRE_ELEMENT) {
						const current = entry.content ? entry.content.v : '';
						const next = isInsert
							? current.slice(0, op.q) + op.v + current.slice(op.q)
							: current.slice(0, op.q) + current.slice(op.q + op.v.length);
						ops.push(entry.t === WIRE_COMMENT
							? { p: [...path, 1, op.q], [isInsert ? 'si' : 'sd']: op.v }
							: { p: [...path, op.q], [isInsert ? 'si' : 'sd']: op.v });
						entry.content = { v: next };
						break;
					}
					// Attribute strings are position-addressed on the wire;
					// the ordered list gives the name json0 needs.
					const attr = Number.isInteger(op.i)
						? entry.attrs[op.i] : null;
					if (!attr) break;
					const canonical = coreUtils.escape(attr.v);
					const offset = rawOffsetToEscaped(canonical, op.q);
					ops.push({ p: [...path, ATTRIBUTE_INDEX,
						coreUtils.escapeDots(attr.n), offset],
					[isInsert ? 'si' : 'sd']: coreUtils.escape(op.v) });
					attr.v = isInsert
						? attr.v.slice(0, op.q) + op.v + attr.v.slice(op.q)
						: attr.v.slice(0, op.q) + attr.v.slice(op.q + op.v.length);
					break;
				}
			}
		}
		return { ...commit, ops: ops.filter((op) => op.p !== null) };
	});
}

// ---------------------------------------------------------------------------
// Primary document state, the doc object and the commit queue
// ---------------------------------------------------------------------------

const state = {
	webstrateId: coreUtils.getLocationObject().webstrateId,
	version: 0,
	data: [],
	exists: false
};

let ready = false; // adoption + population complete: frames may be applied
let syncing = false; // startLive resync in progress: frames queue
let ownSocketId = null; // this client's socket id (hello frame)
let ownSource = null; // our createdOps source marker
let subscribedHead = 0; // head at join time (startLive resync target)
let receivedDocumentFired = false; // receivedDocument: once per live load

/**
 * Fire receivedDocument for the live document, once per page load. Every
 * live boot path triggers it exactly once (empty-document subscribe,
 * finalizeAdoption for an adopted page, rebuildFromStructure before its DOM
 * build); rebuilds later in the page's life must NOT re-trigger it, as
 * document-modifying listeners (protected mode's DOM overrides among them)
 * are not re-installable.
 * @private
 */
function fireReceivedDocument() {
	if (receivedDocumentFired) return;
	receivedDocumentFired = true;
	coreEvents.triggerEvent('receivedDocument', doc, { static: false });
}

// Commit queue. Entries are {id, ops, attrs, source, wire?}: ops are the
// json0 ops as submitted (with annotations), attrs the attribute collapse
// map, wire the translated ops (stashed by the pump for the ack). The queue
// is serialized — an entry is translated and sent only when every earlier
// entry is acked — so a translation always sees a base version that already
// contains all earlier local commits, and a pending op's coordinates only
// ever need mapping past frames (see the string logs above). Frames are
// NEVER deferred: the incoming translation is state-based and composes with
// pending userland effects directly.
const pendingCommits = [];
let inFlight = null;
let nextEntryId = 1;
// The most recent own-commit broadcast ({v, ops} with the server's final
// effective positions). The ack that follows it uses these to record where
// the server actually placed the committed string edits (they may have been
// transformed past concurrent commits).
let lastOwnFrame = null;
const preReadyFrames = []; // frames arrived before adoption finished

const docListeners = { 'op batch': new Set(), 'nothing pending': new Set(),
	'error': new Set() };

/**
 * The live document object — the same shape the ShareDB doc had: id, version,
 * data (canonical JsonML), type, submitOp, hasPending and a tiny event
 * emitter ('op batch', 'nothing pending', 'error') for userland parity.
 * @type {object}
 * @private
 */
const doc = {
	get id() { return state.webstrateId; },
	get version() { return state.version; },
	get v() { return state.version; },
	get data() { return state.data; },
	get type() {
		return state.exists ? { name: 'json0', uri: TYPE_JSONv0 } : null;
	},
	// ShareDB's create() — creation goes through the root-insert op instead.
	create() {},
	submitOp(ops, options) { submitOp(ops, options); },
	hasPending() { return inFlight !== null || pendingCommits.length > 0; },
	on(event, listener) {
		if (docListeners[event]) docListeners[event].add(listener);
	},
	off(event, listener) {
		if (docListeners[event]) docListeners[event].delete(listener);
	}
};

/**
 * Trigger the doc-level 'nothing pending' event (and the opsAcknowledged core
 * event, which dataSaved listens for) when the submission queue drains.
 * @private
 */
function signalQueueDrained() {
	if (inFlight === null && pendingCommits.length === 0) {
		coreEvents.triggerEvent('opsAcknowledged');
		docListeners['nothing pending'].forEach((listener) => listener());
	}
}

/**
 * Copy a batch of json0 ops without their '__'-prefixed annotations (DOM
 * node references and translation metadata). json0.apply deep-clones ops
 * through JSON.stringify, so annotated ops (circular DOM references) must
 * never reach it. The values (op.li, op.oi, ...) stay shared by reference —
 * only the op objects themselves are copied.
 * @param  {[op]} ops Ops, possibly annotated.
 * @return {[op]}     Plain json0 ops.
 * @private
 */
function stripAnnotations(ops) {
	// __wireOnly ops (the leak-recovery sr markers) consist ENTIRELY of
	// annotation keys — after stripping they would collapse into empty
	// objects {}. An empty op has no .p, and json0.apply then throws
	// "Missing path", which submitOp reads as a model divergence and
	// answers by dropping the WHOLE entry — including the perfectly
	// healthy li ops beside it. The dropped li's pathNode is already
	// spliced into the path tree, so the path tree and the model diverge
	// from that point on: every later path computed via toPath() misses
	// the model (removals fall into the leak-recovery branch, inserts
	// fail their model apply), each failure drops further entries, and
	// the divergence compounds — the tldraw corruption spiral (insert-
	// only survivors, string-log pendings composing into glued records,
	// and eventually a fully frozen commit pipeline). Wire-only ops have
	// no model counterpart BY DESIGN (the pump translates them to wire
	// sr at send time — see translateOutgoing): dropping the emptied
	// husk here keeps them out of json0's path validation.
	const stripped = [];
	for (const op of ops) {
		const clean = {};
		for (const key of Object.keys(op)) {
			if (!key.startsWith('__')) clean[key] = op[key];
		}
		if (Object.keys(clean).length > 0) stripped.push(clean);
	}
	return stripped;
}

/**
 * Apply a batch of (annotation-free) json0 ops to the model. Root
 * replacements ({p: [], oi/od}) reassign the whole snapshot, which
 * json0.apply performs on an internal container ({data: snapshot}) — the
 * reassignment would never reach state.data. Those are applied by hand;
 * everything else goes through json0.apply untouched.
 * @param {[op]} ops Annotation-free json0 ops, in application order.
 * @throws {Error} Whatever json0.apply throws (diverged model).
 * @private
 */
function applyToModel(ops) {
	const rest = [];
	for (const op of ops) {
		if (op.__wireOnly) {
			// Wire-only recovery ops have no model counterpart by design.
			continue;
		}
		if ((!op.p || op.p.length === 0) && ('oi' in op || 'od' in op)) {
			state.data = 'oi' in op ? op.oi : [];
			continue;
		}
		rest.push(op);
	}
	if (rest.length > 0) json0.apply(state.data, rest);
}

/**
 * Build the inverse of a batch of json0 ops (in reverse order), annotating
 * re-creating li ops with the eids of the text/comment nodes they rebuild
 * (from the ld's __node annotation). Used on the commit-error path to
 * restore the model and the DOM together.
 * @param  {[op]} ops json0 ops (as submitted).
 * @return {[op]}     Inverse ops, in application order.
 * @private
 */
function invertOps(ops) {
	const inverse = [];
	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i];
		if ('li' in op) {
			inverse.push({ ld: op.li, p: op.p });
		} else if ('ld' in op) {
			const inv = { li: op.ld, p: op.p };
			if (op.__node && op.__node.nodeType !== document.ELEMENT_NODE) {
				inv.__textEid = coreIds.getEid(op.__node);
			}
			inverse.push(inv);
		} else if ('oi' in op && 'od' in op) {
			inverse.push({ oi: op.od, od: op.oi, p: op.p });
		} else if ('oi' in op) {
			inverse.push({ od: op.oi, p: op.p });
		} else if ('od' in op) {
			inverse.push({ oi: op.od, p: op.p });
		} else if ('si' in op) {
			inverse.push({ sd: op.si, p: op.p });
		} else if ('sd' in op) {
			inverse.push({ si: op.sd, p: op.p });
		}
	}
	return inverse;
}

/**
 * Apply json0 ops to the DOM without firing receivedOps (the commit-error
 * rollback). Text re-creation annotations (__textEid from invertOps) prime
 * the eid queue in creation order.
 * @param {[op]} ops json0 ops.
 * @private
 */
function applyOpsSilently(ops) {
	for (const op of ops) {
		if ('li' in op && op.__textEid !== undefined) {
			coreIds.queueTextMeta(op.__textEid);
		}
	}
	coreOpApplier.applyOpsDirectly(ops);
}

/**
 * Does an eid belong to a node a queued entry still intends to (re-)insert?
 * A move is recorded as two entries — the detach (ack'd, then echoed) and
 * the re-insert (still queued) — and the echo of the detach must not detach
 * the node from the live DOM: the queued li's re-add resolves its parent
 * from the node, and detaching it first orphans the op (its parent is gone,
 * the op is dropped and the move becomes a deletion).
 * @param  {int} eid Element id from the echo's sr op.
 * @return {bool}    True when a queued entry li's this eid's node.
 * @private
 */
function isPendingReinsert(eid) {
	if (eid === undefined || eid === null) return false;
	const node = coreIds.nodeOf(eid);
	if (!node) return false;
	const hasLi = (entry) => (entry.ops || []).some((op) =>
		'li' in op && op.__node === node);
	if (inFlight && hasLi(inFlight)) return true;
	for (const entry of pendingCommits) {
		if (hasLi(entry)) return true;
	}
	return false;
}

/**
 * Whether a node is in the live document — attachedness that understands
 * template contents: their nodes walk up into the content fragment (no
 * parent, no host in Chromium) and must continue through the registered host
 * template to the document. (Node.isConnected alone reports false for
 * template-content nodes.)
 *
 * The walk compares against _document, the RAW document from
 * wrapper-header.js — the `document` binding inside the bundle is a Proxy
 * (coreDOM.js's internal/external overrides), and `node === document` is
 * false for every node of the real tree, so an identity check must not go
 * through the proxy.
 * @param  {DOMNode} node Node.
 * @return {bool}         True when the node is in the document.
 * @private
 */
function nodeAttached(node) {
	let n = node;
	while (n) {
		if (n === _document) return true;
		if (n.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
			n = coreIds.hostOf(n);
			continue;
		}
		n = n.parentNode;
	}
	return false;
}

/**
 * Does an own frame's structural op set need reconciliation? Compares the
 * server's effective placements against the client's optimistic ones. The
 * index basis matches the server's: children that are server-known already
 * (snapshot, foreign frames, acked own commits) plus children this same
 * frame sa'd EARLIER (the server applies the batch sequentially) — but not
 * own in-flight nodes from later ops, which the server has not applied yet.
 * A matching tree (the overwhelmingly common case, including every
 * document-creation commit) needs no reconciliation, so the move machinery
 * never touches it.
 * @param  {[wireOp]} structural The frame's sa/sr ops, in order.
 * @return {bool}                True when any placement differs.
 * @private
 */
function ownStructuralNeedsRecon(structural) {
	// eids re-attached later in this batch (sr+sa move pairs): the sr alone
	// is judged by its sa's target.
	const reattach = new Map();
	for (let i = structural.length - 1; i >= 0; i--) {
		const op = structural[i];
		if (op.k === 'sa' && op.e !== undefined && !reattach.has(op.e)) {
			reattach.set(op.e, i);
		}
	}
	for (let i = 0; i < structural.length; i++) {
		const op = structural[i];
		if (op.k === 'sr') {
			if (op.z === true) continue;
			if ((reattach.get(op.e) ?? -1) > i) continue; // move pair
			const node = coreIds.nodeOf(op.e);
			if (node === undefined) continue; // already gone
			// Only a node still ATTACHED to the document is a divergence we
			// must fix: an own removal's echo always finds the node detached
			// (we removed it ourselves) while the registry still holds it —
			// the weak reference just has not been collected yet. Detached
			// nodes are none of the server's concern.
			if (!nodeAttached(node)) continue;
			return true; // the server removed it, but we still show it
		}
		if (op.k !== 'sa' || op.z === true) continue;
		const node = coreIds.nodeOf(op.e);
		// A node the registry lost, or that is detached from the live DOM,
		// is one userland has already churned past: the echo trails the
		// local state (the queue is serialized, so the removal that
		// replaced it is in a pending or already-acked entry, and the
		// server will converge to it). Re-creating the node here (the
		// "we lost it" re-create, or a re-placement of a detached node)
		// manufactures a ghost copy in the DOM and the model — under
		// textContent churn (tldraw's record writes) every echo would
		// re-insert its superseded text and the two pile up: the seed of
		// the mirror ghosts. Detached nodes are none of the server's
		// concern — the same rule the sr branch applies.
		if (node === undefined) continue;
		if (!nodeAttached(node)) continue;
		// Resolve the parent DOWNWARD from the server's parent id. Walking up
		// from the node is wrong for template contents: their parentNode is
		// the content fragment, which carries no eid (and no .host in
		// Chromium) — every template-child sa would read as a placement
		// divergence and trigger a re-play that churns the whole subtree.
		const parent = op.p === 0 ? document : coreIds.nodeOf(op.p);
		if (!parent) return true; // parent unknown: cannot verify
		let found = false;
		for (const child of coreUtils.getChildNodes(parent)) {
			if (child === node) { found = true; break; }
		}
		// The node must actually sit under the server's parent (getChildNodes
		// already resolves template contents). Its INDEX is deliberately
		// NOT checked: the frame's sa index is the client-side optimistic
		// guess against the mutation observer's added-first sibling basis —
		// it counts the sibling that our own removal deleted, a removal
		// that may sit in a SEPARATE commit (the coalescer can pair-drop the
		// li/ld into different entries), so no in-frame sr guard can
		// account for it. By the time the echo processes, every earlier
		// frame has already applied in wire order, each at its
		// server-effective index, and insertions at correct indices push
		// existing nodes to their converged positions — the DOM's current
		// index IS the truth, and op.i may be stale. "Repairing" toward
		// op.i would re-create the node through the move machinery (a
		// fresh DOM node, rebinds through the text-meta FIFO) on every
		// echo — destroying DOM identity held by userland (tldraw keeps
		// node references) — and, for unpaired frames, splice the path
		// tree at an index that no longer exists, the seed of the 07:07
		// mirror pile and glued records.
		if (!found) return true;
	}
	return false;
}

/**
 * Apply one {wa: 'ops'} frame immediately (no deferral, no inversion — the
 * state-based translation composes the frame with every pending userland
 * effect). Our own commits' frames are skips: the DOM and the model already
 * hold the userland effect (applied when the ops were created), and the ack
 * already bumped the version.
 * @param {object} frame {wa: 'ops', d, v, ops, s, x}.
 * @param {bool}   force Apply even when the version is not newer (resync).
 * @private
 */
function applyFrame(frame, force) {
	if (!force && frame.v <= state.version) return;
	if (frame.s === ownSocketId) {
		// Our own commit's broadcast: already accounted for — but remember
		// the server's final effective ops: the ack needs them to record
		// where the server actually placed the entry's string edits.
		lastOwnFrame = { v: frame.v, ops: frame.ops };
		// The server may have TRANSFORMED our structural placements: the
		// child index we optimistically inserted at is only our guess —
		// concurrent commits committed first shift it (committed-first-
		// wins, same tie-break the string offsets get). We never re-apply
		// our own string edits (their text is already in the DOM, and the
		// ack-frame bake records the server's effective offsets), and
		// attribute values are never position-transformed — but the ORDER
		// of children is: without reconciliation our optimistic node order
		// diverges from the server's forever (e.g. typing into a fresh
		// text node the browser split off, while other clients race to
		// insert theirs). Re-play the frame's structural ops through the
		// incoming pipeline ONLY when a placement actually differs: the
		// ld+li move machinery re-creates nodes, so re-playing a
		// matching tree (the normal case, and every document-creation
		// commit) would churn the DOM for nothing and wreck boot.
		const structural = (frame.ops || []).filter((op) =>
			op && (op.k === 'sa' || op.k === 'sr')
			&& !(op.k === 'sr' && isPendingReinsert(op.e)));
		if (structural.length > 0 && ownStructuralNeedsRecon(structural)) {
			const rec = translateIncoming(structural);
			const recOps = stripAnnotations(rec.ops);
			if (recOps.length > 0) {
				try {
					applyToModel(recOps);
				} catch (err) {
					// The model diverged from the server — clean rebuild.
					console.warn('coreDatabase: model divergence (own frame'
						+ ' reconciliation), scheduling rebuild:', err);
					scheduleRebuild();
					return;
				}
				coreOpApplier.applyOpsDirectly(recOps);
			}
			if (rec.rootTouched) scheduleRebuild();
		}
		state.version = Math.max(state.version, frame.v);
		return;
	}
	// A restore diff (r): thousands of interleaved move/removal/re-attach
	// ops whose incremental translation relies on a cascade of positional
	// bookkeeping (live-path adjustment, insertion-path baselines, the
	// re-attach stash) that does not survive frames of this shape. Converge
	// structurally instead: bump the version and rebuild from the server's
	// current structure — the same thing a freshly loaded page does (always
	// correct, and cheaper than replaying the diff for large documents).
	if (frame.r === true) {
		state.version = frame.v;
		scheduleRebuild();
		return;
	}
	state.version = frame.v;
	const translated = translateIncoming(frame.ops);
	const ops = stripAnnotations(translated.ops);
	if (ops.length > 0) {
		try {
			applyToModel(ops);
		} catch (err) {
			// The model diverged from the server — clean rebuild.
			console.warn('coreDatabase: model divergence, scheduling rebuild:',
				err && err.stack || err);
			scheduleRebuild();
			return;
		}
		coreEvents.triggerEvent('receivedOps', ops);
		docListeners['op batch'].forEach((listener) => listener(ops, frame.s));
	}
	if (translated.rootTouched) scheduleRebuild();
}

/**
 * Handle a commit acknowledgement.
 * @param {object} entry  The submitted entry ({id, ops, attrs, source, wire}).
 * @param {Error}  error  Transport error, if any.
 * @param {object} reply  {v, firstOpid, xformed} or {error}.
 * @private
 */
function handleAck(entry, error, reply) {
	inFlight = null;

	if (error || !reply || reply.error) {
		// The commit failed: restore the model and the DOM to the last
		// server state (the userland edit is lost, like ShareDB's rollback),
		// drop the entry's edit-log entries, and tell userland.
		const inverse = invertOps(entry.ops);
		try {
			applyToModel(stripAnnotations(inverse));
		} catch (err) { /* model already diverged; the rebuild will fix it */ }
		applyOpsSilently(inverse);
		for (const [key, log] of stringLogs) {
			log.pending = log.pending.filter((edit) =>
				edit.entryId !== entry.id);
			let hasLive = false;
			for (const edit of log.pending) {
				if (!edit.baked) { hasLive = true; break; }
			}
			if (!hasLive && !log.keep) stringLogs.delete(key);
		}
		const message = (error && error.message)
			|| (reply && reply.error) || 'Commit failed';
		const dbError = { data: { a: 'op', op: entry.ops }, message };
		coreEvents.triggerEvent('databaseError', dbError);
		docListeners.error.forEach((listener) => listener(dbError));
		signalQueueDrained();
		pump();
		return;
	}

	state.version = reply.v;
	state.exists = true;

	// Everything this entry created is server-known from now on: future moves
	// of those nodes emit sr+sa instead of fresh subtrees, and the incoming
	// known-count insertion rule counts them.
	for (const op of entry.wire || []) {
		if (op.k === 'sa') knownEids.add(op.e);
	}
	// Raw string edits (no string-log pendings — userland ops with
	// unresolvable paths, or the rare edit held past every retry) still
	// moved the SERVER's string: their ack-frames must be recorded even
	// though the bake loop below will not fire for them.
	const rawAckOps = (lastOwnFrame && lastOwnFrame.v === reply.v)
		? lastOwnFrame.ops : (entry.wire || []);
	const rawStringKeys = new Set();
	for (const op of rawAckOps || []) {
		if (op.k !== 'si' && op.k !== 'sd') continue;
		// Own si/sd ops are always text/comment content (attribute values
		// collapse into whole-value aa per commit), so the eid alone keys
		// the string log — the server's normalized copy carries i:0, which
		// the incoming translation ignores for non-elements.
		const key = `${op.e}:`;
		const log = stringLogs.get(key);
		if (!log || !log.pending.some((edit) => edit.entryId === entry.id)) {
			rawStringKeys.add(key);
		}
	}
	// The entry's string edits are baked into the base version. They stay in
	// the pending log marked `baked` — later pendings' record-time offsets
	// were measured with them in the string, so the send-path pass 1 must keep
	// removing their client-side effect — but the server may have TRANSFORMED
	// them past concurrent commits, moving them from their optimistic spots:
	// record the server's final positions (from the own frame's ops, which
	// carry them) as frame entries, so every later mapping re-applies them at
	// server coordinates. Live-pending mapping loops skip baked edits (they
	// are server-side now, nothing to map around). With no live pendings left
	// on a string, its whole log is dead weight: drop it.
	for (const [key, log] of stringLogs) {
		let touched = false;
		// Frame-log index where this entry's ack-frames begin: pendings
		// baked now remember it, so later mapping passes can tell whether
		// they were already server-side before a given op was recorded
		// (bakedFrameBase below the op's record-time frameVer).
		const frameBase = log.frame.length;
		for (const edit of log.pending) {
			if (edit.entryId === entry.id && !edit.baked) {
				edit.baked = true;
				edit.bakedFrameBase = frameBase;
				touched = true;
			}
		}
		if (touched) {
			const ownOps = (lastOwnFrame && lastOwnFrame.v === reply.v)
				? lastOwnFrame.ops : (entry.wire || []);
			for (const op of ownOps || []) {
				if ((op.k === 'si' || op.k === 'sd')
					&& `${op.e}:` === key) {
					// ack: this frame commits text that is ALREADY in the
					// client string (its pending's own text) — it adds no
					// client text, so pendSpanAt's lineage skips it (pass-2
					// loops still apply it: server-side, it is new).
					log.frame.push({ q: op.q, len: (op.v || '').length,
						del: op.k === 'sd', ack: true });
				}
			}
		}
		let hasLive = false;
		for (const edit of log.pending) {
			if (!edit.baked) { hasLive = true; break; }
		}
		if (!hasLive && !rawStringKeys.has(key)) stringLogs.delete(key);
	}

	// Push the raw entries' ack-frames now (the bake loop above only fires
	// for keys with pendings): the server's effective placements feed every
	// later offset mapping on that key, and — the client string can differ
	// from the server's for these — the log must survive the idle cleanup.
	for (const key of rawStringKeys) {
		const log = stringLogFor(key);
		log.keep = true;
		for (const op of rawAckOps) {
			if ((op.k !== 'si' && op.k !== 'sd')
				|| `${op.e}:` !== key) continue;
			log.frame.push({ q: op.q, len: (op.v || '').length,
				del: op.k === 'sd', ack: true });
		}
	}

	signalQueueDrained();
	coreIds.maybeRefill();
	pump();
}

// Starved re-diff timers (one per held node at most — a refill failure
// retries through these; any later mutation on the node re-emits the held
// text as well, so nothing is ever lost).
const rediffTimers = new WeakMap();

/**
 * Re-run the string diff for nodes whose edits were held back for lack of
 * element ids, once the id pool has refilled. The synthetic characterData
 * mutation goes through the ordinary creator pipeline (which diffs the
 * model against the live DOM), so the re-emitted ops carry current offsets
 * and land in the string log as pendings. On a failed refill (the server
 * may be unreachable) retry on a timer instead.
 * @param {Set<DOMNode>} nodes Starved text/comment nodes.
 * @private
 */
function scheduleStarvedRediff(nodes) {
	if (!nodes || nodes.size === 0) return;
	const reemit = () => {
		for (const node of nodes) {
			coreEvents.triggerEvent('mutation',
				{ type: 'characterData', target: node });
		}
	};
	Promise.resolve(coreIds.refill(2, 32)).then(reemit, () => {
		for (const node of nodes) {
			if (rediffTimers.has(node)) continue;
			rediffTimers.set(node, setTimeout(() => {
				rediffTimers.delete(node);
				coreEvents.triggerEvent('mutation',
					{ type: 'characterData', target: node });
			}, 1000));
		}
	});
}

/**
 * Submit a batch of json0 ops (from createdOps or userland): apply them
 * optimistically to the model, fold attribute changes into the entry's
 * per-element collapse map (whole values, one aa/ar per name per commit),
 * record text/comment string edits into the per-string logs (for offset
 * mapping in both directions), and queue the wire translation + commit.
 * @param {[op]}   ops     json0 ops (with __node/__target annotations).
 * @param {object} options {source}.
 * @private
 */
function submitOp(ops, options = {}) {
	ops = (ops || []).filter((op) => op && typeof op === 'object');
	if (ops.length === 0) return;

	const entry = { id: nextEntryId++, source: options.source, ops,
		attrs: new Map() };

	// Canonicalize node values first (fromHTML emits raw attribute values,
	// while the model and the wire both speak escaped — attributeMutation
	// ops already arrive escaped). The op and the model share the value
	// object afterwards, so the eids minted below show up in the model too.
	for (const op of ops) {
		if ('li' in op && op.li && typeof op.li === 'object') {
			op.li = canonicalizeJml(op.li);
		} else if (op.p && op.p.length === 0 && 'oi' in op
			&& op.oi && typeof op.oi === 'object') {
			op.oi = canonicalizeJml(op.oi);
		}
	}
	const noteAttrCollapse = (element, rawName, value) => {
		let nameMap = entry.attrs.get(element);
		if (!nameMap) {
			nameMap = new Map();
			entry.attrs.set(element, nameMap);
		}
		nameMap.set(rawName, value);
		// A pending whole-value opinion also masks incoming string edits on
		// the same attribute (they would be overwritten by our value anyway).
		// The log key carries the NAME (stable under the position shifts
		// concurrent removals cause — the DOM's ordered list is the position
		// map, the name is the identity).
		const eid = coreIds.getEid(element);
		if (eid !== undefined && eid !== null) {
			stringLogFor(`${eid}:${rawName}`).pending.push({ replace: true,
				entryId: entry.id });
		}
	};

	let starved = false;
	const starvedNodes = new Set();

	for (const op of ops) {
		const p = op.p || [];
		const key = p[p.length - 2];

		// Attribute set/replace/remove: collapse. Attribute ops end in
		// [..., ATTRIBUTE_INDEX, name] (ATTRIBUTE_INDEX is the jml props slot,
		// a number — the root-insert and node replacement ops have empty or
		// name-less paths and fall through).
		if (('oi' in op || 'od' in op) && key === ATTRIBUTE_INDEX
			&& typeof p[p.length - 1] === 'string') {
			const element = op.__target || nodeAtPath(p.slice(0, -2));
			if (!element || element.nodeType !== document.ELEMENT_NODE) continue;
			const rawName = coreUtils.unescapeDots(p[p.length - 1]);
			noteAttrCollapse(element, rawName, 'oi' in op ? op.oi : null);
			continue;
		}

		// Attribute string edits (userland — the creator emits whole values):
		// fold into the same collapse with the resulting value. These end in
		// [..., ATTRIBUTE_INDEX, name, offset].
		if (('si' in op || 'sd' in op) && typeof key === 'string') {
			const element = op.__target || nodeAtPath(p.slice(0, -3));
			if (!element || element.nodeType !== document.ELEMENT_NODE) continue;
			const rawName = coreUtils.unescapeDots(key);
			const offset = p[p.length - 1];
			const isInsert = 'si' in op;
			const fragment = isInsert ? op.si : op.sd;
			let current;
			const nameMap = entry.attrs.get(element);
			if (nameMap && nameMap.has(rawName)) {
				current = nameMap.get(rawName) || '';
			} else {
				const props = propsAt(p.slice(0, -3)) || {};
				current = typeof props[key] === 'string' ? props[key] : '';
			}
			if (isInsert) {
				current = current.slice(0, offset) + fragment
					+ current.slice(offset);
			} else {
				current = current.slice(0, offset)
					+ current.slice(offset + fragment.length);
			}
			noteAttrCollapse(element, rawName, current);
			continue;
		}

		// Text or comment content: record into the string's edit log (the
		// node gets an eid now if it never had one — the fresh-node
		// translation reuses it; the content needs no index of its own,
		// position 0 is the node's only entry).
		if ('si' in op || 'sd' in op) {
			const node = op.__target || nodeAtPath(p.slice(0, -1));
			if (!node || node.nodeType === document.ELEMENT_NODE) continue;
			let eid = coreIds.getEid(node);
			if (eid === undefined || eid === null) {
				const mintedEid = coreIds.mintId();
				if (mintedEid !== null) {
					coreIds.registerTextOrComment(node, mintedEid);
					eid = mintedEid;
				}
			}
			if (eid === undefined || eid === null
				&& coreIds.availableIds() <= 0) {
				// The id pool is empty (it refills asynchronously): hold the
				// edit. An unmapped si/sd would carry its record-time offset
				// against a send-time base, so any frame landing on this
				// string in between would place our text on its wrong side —
				// and own frames never re-apply, so the divergence would be
				// permanent.
				op.__starved = true;
				starved = true;
				starvedNodes.add(node);
				continue;
			}
			if (eid === undefined || eid === null) {
				// Unregistrable for another reason (the pool has ids but the
				// node resists registration): the op goes unmapped (the
				// server clamps), and fresh-node translation will register
				// the node.
				continue;
			}
			const strKey = `${eid}:`;
			const log = stringLogFor(strKey);
			op.__strKey = strKey;
			op.__strVer = log.pending.length;
			op.__frameVer = log.frame.length;
			op.__entryId = entry.id;
			const isInsert = 'si' in op;
			const fragment = isInsert ? op.si : op.sd;
			let offset = p[p.length - 1];
			if (isInsert) {
				// The browser intermittently leaves the caret inside (or at
				// the start of) our own live pending text, so the next
				// keystroke lands inside that fragment in the DOM. Every
				// wire convention (pass-1 clamp, pass-2 ack-frame tie,
				// server committed-first-wins) places it AFTER the whole
				// fragment once the pending commits, and own frames are
				// never re-applied to our DOM — the misplacement would be
				// permanent. Normalize at record time: move the new text
				// past the enclosing pending in the op, the DOM and the
				// caret — and keep walking: the live pendings usually form a
				// contiguous run at the caret, and the wire conventions put
				// the fragment after every committed-first pending in the
				// run, so leaving it between two pendings could never
				// converge. Baked pendings need no correction (the server
				// can insert inside their span) and neither do same-entry
				// siblings (the server applies a commit's ops sequentially).
				for (let guard = 0; guard < 64; guard++) {
					let hit = -1;
					let spanQ = -1;
					for (let i = Math.min(op.__strVer, log.pending.length) - 1;
						i >= 0; i--) {
						const edit = log.pending[i];
						if (edit.del || edit.baked || edit.replace
							|| edit.entryId === entry.id) {
							continue;
						}
						// The pending's CURRENT span, not its record-time
						// offset: frames that arrived since it was recorded
						// (and later pendings) shifted the fragment in the
						// DOM, so the record-time offset no longer points at
						// it.
						const sq = pendSpanAt(log, i, log.frame.length,
							log.pending.length);
						if (offset < sq || offset >= sq + edit.len) continue;
						hit = i;
						spanQ = sq;
						break;
					}
					if (hit === -1) break;
					const edit = log.pending[hit];
					// Rewrite only when the DOM matches the assumed layout:
					// a stale rewrite would corrupt the text (head+tail must
					// BE the pending's fragment, NBSP-normalized since ops
					// speak spaces but the DOM keeps NBSPs).
					const nbsp = (s) => s.replace(/\u00A0/g, ' ');
					const data = node.data || '';
					const head = data.slice(spanQ, offset);
					const tail = data.slice(offset + fragment.length,
						spanQ + edit.len + fragment.length);
					if (nbsp(head + tail) !== nbsp(edit.v)) break;
					const fresh = data.slice(offset, offset + fragment.length);
					node.data = data.slice(0, spanQ) + head + tail + fresh
						+ data.slice(spanQ + edit.len + fragment.length);
					// Follow the moved text with the caret, like a normal
					// insertion would.
					try {
						const sel = window.getSelection();
						if (sel && sel.rangeCount > 0) {
							const r = sel.getRangeAt(0);
							if (r.collapsed && r.startContainer === node) {
								const caret = document.createRange();
								caret.setStart(node, spanQ + edit.len
									+ fragment.length);
								caret.collapse(true);
								sel.removeAllRanges();
								sel.addRange(caret);
							}
						}
					} catch (e) { /* selection is advisory */ }
					offset = spanQ + edit.len;
					p[p.length - 1] = offset;
				}
			}
			log.pending.push({ q: offset, len: fragment.length,
				del: !isInsert, v: fragment, entryId: entry.id,
				frameVer: log.frame.length });
			continue;
		}
	}

	if (starved) {
		// Drop the held edits from the entry and keep their text out of the
		// model: the string diff is model-vs-live, so the next checkpoint on
		// the node — or the re-diff scheduled below once ids arrive —
		// re-emits the delta with current offsets and a string-log pending.
		// Everything else in the batch commits normally (structure
		// self-heals through the own-frame reconciliation; attribute
		// collapses carry whole values).
		for (let i = ops.length - 1; i >= 0; i--) {
			if (ops[i].__starved) ops.splice(i, 1);
		}
		scheduleStarvedRediff(starvedNodes);
		if (ops.length === 0) return;
	}

	try {
		applyToModel(stripAnnotations(ops));
	} catch (err) {
		coreEvents.triggerEvent('databaseError', { data: { a: 'op', op: ops },
			message: err.message });
		return;
	}

	pendingCommits.push(entry);
	pump();
}

/**
 * Coalesce superseded text-node churn out of the queued entries before the
 * pump drains them. Rapid text churn (innerHTML += per iteration, spellcheck
 * rewrites, collaborative bursts) makes the browser REPLACE the node — each
 * mutation is an insert of a new node plus a removal of the old one — so the
 * queue fills with [li N, ld N-1] pairs whose intermediate nodes are already
 * detached from the live DOM and already undone by a later queued entry.
 * Sending them all would mean one commit (and a round-trip) per intermediate
 * state that no observer ever saw.
 *
 * A queued [li] whose node is (a) detached from the live DOM and (b) removed
 * again by a queued [ld] of the same node can never become visible on the
 * server: that ld undoes it. Both ops are dropped — the li (nothing to add)
 * and the ld (it would reference a node the server never received) — and
 * entries left with no ops vanish entirely. Moves are unaffected: a
 * re-inserted node stays connected, and the detach/re-insert race case has no
 * queued ld behind it (its ld already left with an earlier entry). The model
 * is untouched — it already carries the final state (every entry is applied
 * on submit), so skipping the wire ops of superseded intermediates converges
 * exactly.
 * @private
 */
function coalesceSupersededEntries() {
	// Nodes any queued [ld] removes — position-agnostic: an ld before the li
	// (the first half of a move) never shares its node with a detached li,
	// because the only way the node leaves the DOM again is a later ld.
	const ldLater = new Set();
	for (const entry of pendingCommits) {
		for (const op of entry.ops) {
			if ('ld' in op && op.__node) ldLater.add(op.__node);
		}
	}

	// Superseded inserts: node detached from the live DOM, removal queued.
	// (nodeAttached, not isConnected: a node moved INTO template content is
	// attached through its host — isConnected would read it as gone and drop
	// the insert that put it there.)
	const superseded = new Set();
	for (const entry of pendingCommits) {
		for (const op of entry.ops) {
			if ('li' in op && op.__node && !nodeAttached(op.__node) && ldLater.has(op.__node)) {
				op.__superseded = true;
				superseded.add(op.__node);
			}
		}
	}
	if (superseded.size === 0) return;

	// Drop the marked lis, the lds undoing them, and emptied entries.
	for (let i = pendingCommits.length - 1; i >= 0; i--) {
		const entry = pendingCommits[i];
		let drop = false;
		for (const op of entry.ops) {
			if ('ld' in op && op.__node && superseded.has(op.__node)) {
				op.__superseded = true;
			}
			if (op.__superseded) drop = true;
		}
		if (drop) {
			entry.ops = entry.ops.filter((op) => !op.__superseded);
			if (entry.ops.length === 0) pendingCommits.splice(i, 1);
		}
	}
}

/**
 * Pump the commit queue: translate the next entry to wire ops and send it
 * (one in flight; ids refilled first when the pool cannot cover the entry).
 * @return {Promise} Resolves when the queue is idle (used by tests).
 * @private
 */
async function pump() {
	coalesceSupersededEntries();
	while (!inFlight && pendingCommits.length > 0) {
		const entry = pendingCommits[0];
		const budget = estimateIdBudget(entry.ops);
		if (!coreIds.ensureIds(budget)) {
			try {
				await coreIds.refill(budget, budget);
			} catch (err) { /* fail the commit below */ }
			if (!coreIds.ensureIds(budget)) {
				pendingCommits.shift();
				const dbError = { data: { a: 'op', op: entry.ops },
					message: 'Could not allocate element ids.' };
				coreEvents.triggerEvent('databaseError', dbError);
				docListeners.error.forEach((listener) => listener(dbError));
				signalQueueDrained();
				continue;
			}
			continue;
		}
		let wire;
		try {
			wire = translateOutgoing(entry);
		} catch (err) {
			// A translation bug must not stall the whole queue: report it,
			// roll the entry back and carry on with the next.
			console.error('coreDatabase: translation failed:', err);
			pendingCommits.shift();
			const dbError = { data: { a: 'op', op: entry.ops },
				message: `Translation failed: ${err.message}` };
			coreEvents.triggerEvent('databaseError', dbError);
			docListeners.error.forEach((listener) => listener(dbError));
			signalQueueDrained();
			continue;
		}
		if (wire === null) {
			// The budget estimate was too low (very large subtrees): retry
			// with a bigger refill — translation reuses minted eids.
			try {
				await coreIds.refill(64, 64);
			} catch (err) { /* fail below */ }
			// Re-entrancy: every submitOp pumps, so a concurrent pump may
			// have claimed this very entry during the await — shifted it,
			// translated it against the refilled pool, set inFlight and
			// sent. Resuming blind would shift the NEXT queued entry out
			// of existence (its ops silently vanish — held removals,
			// unpaired frames) and commit this entry a second time with a
			// second ack. If we no longer own the head, stand down; the
			// other invocation is driving it. (The ensureIds await path
			// above is already safe: its `continue` re-tests inFlight.)
			if (inFlight !== null || pendingCommits[0] !== entry) return;
			try {
				wire = translateOutgoing(entry);
			} catch (err) {
				// Same policy as the first translation: report, roll the
				// entry back, carry on — never stall the queue.
				console.error('coreDatabase: translation failed:', err);
				pendingCommits.shift();
				const dbError = { data: { a: 'op', op: entry.ops },
					message: `Translation failed: ${err.message}` };
				coreEvents.triggerEvent('databaseError', dbError);
				docListeners.error.forEach((listener) => listener(dbError));
				signalQueueDrained();
				continue;
			}
			if (wire === null) {
				pendingCommits.shift();
				const dbError = { data: { a: 'op', op: entry.ops },
					message: 'Could not allocate element ids.' };
				coreEvents.triggerEvent('databaseError', dbError);
				docListeners.error.forEach((listener) => listener(dbError));
				signalQueueDrained();
				continue;
			}
		}
		pendingCommits.shift();
		if (wire.length === 0) {
			// Nothing to commit (e.g. transient-only changes): acknowledge
			// immediately.
			signalQueueDrained();
			continue;
		}
		entry.wire = wire;
		inFlight = entry;
		coreWebsocket.send({ wa: 'commit',
			base: state.version, ops: wire },
		(error, reply) => handleAck(entry, error, reply), { waitForOpen: true });
		// The send callback resolves asynchronously; stop pumping.
		break;
	}
}
// ---------------------------------------------------------------------------
// Adoption (pre-rendered page → live document)
// ---------------------------------------------------------------------------

const paintAdoption = require('./paintAdoption');

/**
 * A served paint is stable by construction — the server re-parses its own
 * paint with the WHATWG algorithm and commits any divergence before
 * serving — so the content digest here is an integrity assert, never a
 * server-made mismatch. A failure means extension interference or a
 * browser/parser divergence: one sessionStorage-guarded reload gets a
 * fresh page (an extension race may not repeat); a second failure shows a
 * visible error state and stops the client.
 * @param  {string}  digest Expected content digest (the bundle's data-d).
 * @return {Promise<bool>}   Whether the digest matched.
 * @private
 */
async function verifyPaintIntegrity(digest) {
	let clientDigest = null;
	try {
		clientDigest = await computeDigest(document.documentElement);
	} catch (err) { /* crypto unavailable: treat as a mismatch */ }
	if (clientDigest === digest) {
		// A healthy load resets the reload budget (a manual reload after
		// an earlier failure gets a fresh one-shot).
		const okKey = '__wsPaintReload:' + state.webstrateId + ':'
			+ paintAdoption.pageVersion();
		try {
			sessionStorage.removeItem(okKey);
		} catch (err) { /* unavailable — the guard is stale at worst */ }
		return true;
	}
	reportPaintDivergence(digest, clientDigest);
	return reloadOnceOrDie('content digest mismatch');
}

/**
 * Forensics for a content-digest mismatch: fetch the server's digest rows
 * (the exact rows its data-d hashed — GET /:webstrateId/paint-rows), diff
 * them against the rows of the DOM this browser actually adopted, and report
 * the first divergences to the console, window.__wsPaintDivergence and the
 * server log (POST /_paint-debug; keepalive lets the report survive the
 * imminent reload). Fire-and-forget: the reload/dead-end path proceeds
 * without waiting for it.
 * @param  {string}      expectedDigest The digest the server stamped (data-d).
 * @param  {string|null} clientDigest   The digest this browser computed.
 * @private
 */
async function reportPaintDivergence(expectedDigest, clientDigest) {
	try {
		const clientRows = computeRows(document.documentElement);
		const res = await fetch('/' + state.webstrateId + '/paint-rows');
		if (!res.ok) return;
		const server = await res.json();
		const divergences = [];
		const max = Math.max(clientRows.length, (server.rows || []).length);
		for (let i = 0; i < max && divergences.length < 8; i++) {
			const a = JSON.stringify(clientRows[i]);
			const b = JSON.stringify((server.rows || [])[i]);
			if (a !== b) divergences.push({
				i,
				client: a === undefined ? null : a.slice(0, 240),
				server: b === undefined ? null : b.slice(0, 240)
			});
		}
		if (server.v !== undefined && server.v !== paintAdoption.pageVersion()) {
			divergences.unshift({ note: 'head revision moved since the paint',
				serverV: server.v, pageV: paintAdoption.pageVersion() });
		}
		const report = { d: state.webstrateId, v: paintAdoption.pageVersion(),
			expectedDigest, clientDigest, rowsClient: clientRows.length,
			rowsServer: (server.rows || []).length, divergences };
		window.__wsPaintDivergence = report;
		console.error('webstrates: paint divergence:',
			JSON.stringify(report).slice(0, 1000));
		fetch('/_paint-debug', { method: 'POST', keepalive: true,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(report)
		}).catch(() => { /* the report is best-effort */ });
	} catch (err) { /* forensics must never block the failure path */ }
}

/**
 * The dead-end recovery for a failed adoption: reload the page once (an
 * extension race during the stream may not repeat), then show a visible
 * error state and stop. The sessionStorage guard makes the reload a
 * one-shot per (webstrate, version) — never a loop.
 * @param {string} reason Human-readable failure reason.
 * @return {bool} False — the client never continues.
 * @private
 */
function reloadOnceOrDie(reason) {
	// state.version is only assigned after a successful adoption — during
	// the failure path the painted page's revision is the live one, and the
	// guard key must be per-revision (a later revision's load deserves its
	// own one-shot, not an inherited dead-end).
	const reloadKey = '__wsPaintReload:' + state.webstrateId + ':'
		+ paintAdoption.pageVersion();
	try {
		if (sessionStorage.getItem(reloadKey) === null) {
			sessionStorage.setItem(reloadKey, '1');
			location.reload();
			return false; // the page unloads; this client never continues
		}
	} catch (err) { /* sessionStorage unavailable: show the error state */ }
	showLoadError(reason);
	return false;
}

/**
 * Visible dead-end: the initial load could not be adopted and a reload did
 * not help. A red banner explains what happened; the client stops (the
 * subscribe promise never resolves, so no populate, no ops).
 * @param {string} reason Human-readable failure reason.
 * @private
 */
function showLoadError(reason) {
	console.error('webstrates: initial load could not be adopted:', reason);
	// The wire-only boot style (SnapshotCacheManager.bootStyle) hides the
	// body during parse+adoption; finish() removes it, but the paths that
	// fail before/inside finish (a bundle tag an extension mangled, an
	// unparsable identity) never get there. Strip it here — the one choke
	// point of every dead end — so the banner lands on a revealed document;
	// paintAdoption.reveal also tears down its hold machinery (marker
	// observer, hold observer, deadline timer) so nothing stays armed on a
	// stopped page.
	paintAdoption.reveal();
	const banner = document.createElement('div');
	banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
		+ 'background:#a00;color:#fff;font:13px/1.4 monospace;padding:8px 12px;'
		+ 'text-align:center';
	banner.textContent = 'Webstrates: could not adopt this document'
		+ ' (' + reason + '). Try reloading.';
	(document.body || document.documentElement).appendChild(banner);
}

/**
 * Adopt the pre-rendered page. The stream pass in paintAdoption has been
 * decorating the document as it parsed — stripping the _ attributes,
 * trimming the identity prefixes, registering ids, un-neutering scripts,
 * reparenting the mirror head and moving the html-level region back — so
 * by the time the subscribe handshake wants a result there is (almost)
 * nothing left to do: finish() waits for DOMContentLoaded, sweeps what a
 * document-subtree observer cannot see (template contents), and runs the
 * structural transforms if their stream triggers never fired. The content
 * digest is then verified — an integrity assert on a
 * stable-by-construction paint.
 * @return {Promise<{ok: bool, version: int}>} Whether a painted page was
 *   adopted, and at which revision.
 * @private
 */
async function adoptPaintedDocument() {
	if (!paintAdoption.isPainted()) return { ok: false, version: 0 };
	const version = paintAdoption.pageVersion();
	const digest = paintAdoption.pageDigest();
	if (!await paintAdoption.finish()) {
		// An identity did not parse — the same class of trouble as a
		// digest mismatch (extension interference, a parser divergence):
		// the same recovery, with the real reason named.
		reloadOnceOrDie('unparsable identity in the served paint');
		return { ok: false, version };
	}
	if (!await verifyPaintIntegrity(digest)) return { ok: false, version };
	return { ok: true, version };
}



/**
 * Clean rebuild: replace the whole DOM with a render of the structure (used
 * for unparsable adoptions, root-touching commits and divergences; rare).
 * @param  {object}  structure Parsed fetchStructure payload.
 * @return {Promise}          Resolves when rebuilt.
 * @private
 */
async function rebuildFromStructure(structure) {
	const { jml, textMeta } = jsonmlFromStructure(structure);
	const scripts = [];

	// The model and revision are known before the DOM is built, so
	// receivedDocument fires NOW (once per page load): document-modifying
	// modules — protected mode above all — install their DOM overrides on
	// it, and the elements this rebuild creates through createElement must
	// be created with those overrides active to come out approved. The
	// original population flow had the same ordering (receivedDocument,
	// then the toHTML build).
	state.version = structure.v;
	state.exists = structure.v > 0;
	state.data = jml[0] || [];
	fireReceivedDocument();

	const html = coreJsonML.toHTML(jml[0], undefined, scripts);
	// Swap the document element: clear the document (the doctype stays),
	// then append the new one.
	const rootElement = document;
	coreUtils.clearPreservingDoctype(rootElement);
	coreUtils.appendChildWithoutScriptExecution(rootElement, html);
	// documentElement, not childNodes[0]: the doctype is kept, so it is
	// (and on adopted pages always was) the first child node.
	const newHtmlElement = rootElement.documentElement;
	// Register every node's eid against the DOM, walking the canonical jml
	// and the freshly built DOM in lockstep (they are isomorphic — the DOM
	// was just built from that jml): elements take their eids from the jml's
	// __wid properties (toHTML skips those), text and comment nodes from the
	// pre-order textMeta queue. Attributes need no registration at all:
	// a position IS the index in the element's own attribute list, and the
	// build preserved the state rows' order (props order = DOM order =
	// the server's dense local positions).
	let metaIdx = 0;
	const registerTree = (jmlNode, domNode) => {
		const props = jmlNode[1];
		if (props && typeof props === 'object' && !Array.isArray(props)
			&& props.__wid !== undefined) {
			coreIds.registerElement(domNode, props.__wid);
		}
		const domKids = Array.from(coreUtils.getChildNodes(domNode));
		let dk = 0;
		for (let i = 1; i < jmlNode.length; i++) {
			const child = jmlNode[i];
			if (i === 1 && child && typeof child === 'object'
				&& !Array.isArray(child)) continue; // the props object
			const node = domKids[dk++];
			if (!node) continue;
			if (typeof child === 'string') {
				const meta = textMeta[metaIdx++];
				if (meta) coreIds.registerTextOrComment(node, meta.eid);
			} else if (Array.isArray(child)) {
				if (child[0] === '!') {
					const meta = textMeta[metaIdx++];
					if (meta) coreIds.registerTextOrComment(node, meta.eid);
				} else {
					registerTree(child, node);
				}
			}
		}
	};
	registerTree(jml[0], newHtmlElement);
	seedKnownEids(newHtmlElement);
	doc.domReady = true;
	doc.scriptsExecuted = true;
	// (receivedDocument fired before the DOM build above; state.version,
	// state.exists and state.data were set there.)
	// The applier must apply to the NEW root from now on (the old one left
	// with the replaced DOM).
	coreOpApplier.setRootElement(newHtmlElement);
	// The rebuild replaces every node: re-collect the scripts and execute
	// them, then rebuild the path tree on the result and announce the
	// document as populated (index.js's populate flow, inlined — populate
	// itself only runs at boot). The returned promise resolves when the
	// document is fully rebuilt.
	return new Promise((resolve) => {
		coreUtils.executeScripts(scripts, () => {
			const pathTree = corePathTree.create(newHtmlElement, null, true);
			// The tree only fails to build when the root ends up transient
			// (a protection even the rebuild could not satisfy). The rebuilt
			// document still stands — it just cannot produce ops until some
			// later rebuild succeeds.
			if (pathTree) pathTree.check();
			else console.warn('coreDatabase: rebuilt root admitted no path tree');
			coreEvents.triggerEvent('populated', newHtmlElement, state.webstrateId);
			resolve();
		});
	});
}

let rebuildScheduled = false;
/**
 * Schedule a clean rebuild (divergences, root-touching commits).
 * @private
 */
function scheduleRebuild() {
	if (rebuildScheduled || !ready) return;
	rebuildScheduled = true;
	setTimeout(async () => {
		rebuildScheduled = false;
		// A single lost reply must not wedge the client at a stale DOM
		// forever (the restore path converges through here): retry the
		// fetch a few times before giving up.
		for (let attempt = 0; attempt < 3; attempt++) {
			const structure = await fetchStructure(state.webstrateId);
			if (structure) {
				// rebuildFromStructure executes scripts, rebuilds the path
				// tree and fires 'populated' itself.
				await rebuildFromStructure(structure);
				return;
			}
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
		}
		console.warn('coreDatabase: rebuild failed after retries'
			+ ' (fetchStructure unavailable).');
	}, 0);
}

/**
 * Finish adoption after the populator built the path tree (the DOM is in its
 * final state): derive the canonical model from the DOM and fire
 * receivedDocument, so userland sees a complete document.
 * @public
 */
function finalizeAdoption() {
	state.data = canonicalizeJml(
		coreJsonML.fromHTML(document.documentElement));
	state.exists = state.version > 0 || state.data.length > 0;
	seedKnownEids(document.documentElement);
	fireReceivedDocument();
}
exports.finalizeAdoption = finalizeAdoption;

/**
 * Hand the populator's bootstrap text metadata (the eids and content indexes
 * it minted and registered while building the empty document's DOM) to the
 * root-insert translation: the commit's sa/aa pairs for text and comment
 * nodes take them in JsonML pre-order. Without metadata (a userland root
 * insert), the translation mints its own.
 * @param {[{eid, x}]} meta Text metadata, JsonML pre-order.
 * @public
 */
exports.setBootstrapTextMeta = (meta) => {
	bootstrapTextMeta = Array.isArray(meta) ? meta.slice() : [];
};

// ---------------------------------------------------------------------------
// Live: start, frame routing, resync, subscribe
// ---------------------------------------------------------------------------

// The head revision from the most recent own-document hello (the server
// sends it the moment the websocket stands — opening the socket IS the
// subscription), and the subscribe() calls waiting for it.
let lastHelloHead = null;
const helloWaiters = new Set();

/**
 * Route {wa: 'ops'} frames to the primary or a secondary document, and
 * hello frames to the socketId bookkeeping and the head-revision handshake.
 * @param {object} message Parsed frame.
 * @private
 */
function onJsonMessage(message) {
	if (message.wa === 'hello' && message.d === state.webstrateId) {
		ownSocketId = message.id;
		if (typeof message.v === 'number') {
			lastHelloHead = message.v;
			for (const waiter of Array.from(helloWaiters)) {
				helloWaiters.delete(waiter);
				waiter(message.v);
			}
		}
		return;
	}
	if (message.wa !== 'ops') return;
	// No d = a frame for this socket's own document (the one in its URL);
	// a d names another document riding the same socket (a secondary).
	if (message.d === undefined || message.d === state.webstrateId) {
		if (!ready || syncing) {
			preReadyFrames.push(message);
			return;
		}
		// Frames apply immediately, even while a commit is in flight: the
		// state-based translation composes them with pending userland
		// effects, and the server's transformOps rebases the in-flight
		// commit's ops.
		applyFrame(message);
		return;
	}
	const secondary = secondaryDocs.get(message.d);
	if (secondary) secondary.acceptFrame(message);
}

/**
 * Begin live operation (called by index.js after the populator finished and
 * the applier's root element is set): resync the adoption revision to the
 * subscribed head (replaying the commits between), then drain the frames
 * that arrived meanwhile.
 * @return {Promise} Resolves when live.
 * @public
 */
exports.startLive = async () => {
	ready = true;
	syncing = true;
	try {
		if (state.version !== subscribedHead) {
			if (state.version < subscribedHead) {
				// Replay the commits between the adopted revision and head.
				const entries = await new Promise((resolve) => {
					coreWebsocket.send({ wa: 'getOps',
						from: state.version, to: subscribedHead },
					(error, reply) => resolve(error ? null : reply),
					{ waitForOpen: true });
				});
				if (Array.isArray(entries)) {
					for (const entry of entries) {
						// Commits from this socket's session are already in
						// the DOM (userland); everything else replays as a
						// normal frame.
						applyFrame({ v: entry.v, ops: entry.ops, s: entry.src });
					}
				}
			} else {
				// The page was newer than the server's head (the document was
				// recreated): rebuild at the server's head.
				const structure = await fetchStructure(state.webstrateId,
					subscribedHead);
				if (structure) await rebuildFromStructure(structure);
			}
		}
	} finally {
		syncing = false;
		const frames = preReadyFrames.splice(0);
		for (const frame of frames) {
			if (frame.v <= state.version) continue;
			applyFrame(frame);
		}
		pump();
	}
};

/**
 * Subscribe to a live webstrate: open the connection (the join itself — the
 * hello carries the head revision), adopt the pre-rendered page when one was
 * served (or rebuild from structure / await the empty-document bootstrap),
 * and resolve the doc.
 * @param  {string}   webstrateId Webstrate id.
 * @return {Promise}              The live doc object.
 * @public
 */
exports.subscribe = (webstrateId) => {
	return new Promise((resolve, reject) => {
		(async () => {
			const websocket = coreWebsocket.copy((event) =>
				event.data.startsWith('{"wa":"ops"')
			|| event.data.startsWith('{"wa":"hello"'));
			websocket.onjsonmessage = onJsonMessage;

			let head;
			try {
				// Opening the websocket is the subscription: the server joins
				// the connection to its own document (the one in the socket's
				// URL) and sends the hello — document id and head revision —
				// without the client sending anything. A hello that already
				// went by is just as good. A server that never sends one is
				// broken (no read permission means the page was never served
				// in the first place), so give up loudly instead of hanging.
				head = await new Promise((resolveHead, rejectHead) => {
					if (lastHelloHead !== null) return resolveHead(lastHelloHead);
					let safetyTimer = null;
					const waiter = (v) => {
						clearTimeout(safetyTimer);
						resolveHead(v);
					};
					helloWaiters.add(waiter);
					safetyTimer = setTimeout(() => {
						helloWaiters.delete(waiter);
						rejectHead(new Error('no hello from the server '
							+ '(the subscription never completed)'));
					}, 10000);
				});
			} catch (err) {
				return reject(err);
			}
			subscribedHead = head;

			ownSource = coreUtils.randomString();
			coreEvents.addEventListener('createdOps', (ops) => {
				doc.submitOp(ops, { source: ownSource });
			}, coreEvents.PRIORITY.IMMEDIATE);

			if (head === 0) {
			// Empty document: the shell stays; corePopulator bootstraps it
			// with a root-insert commit.
				state.version = 0;
				state.exists = false;
				state.data = [];
				doc.domReady = false;
				fireReceivedDocument();
				resolve(doc);
				return;
			}

			const adopted = await adoptPaintedDocument();
			if (!adopted.ok) {
			// A painted page exists only for the head revision of a
			// non-empty document — anything that reaches here failed the
			// adoption: the digest mismatch path already reloaded once and
			// showed its banner, and an unpainted shell for a non-empty
			// document means the server's render failed. Either way the
			// client never comes live on a DOM it could not adopt; there is
			// deliberately no fetchStructure fallback on the initial load.
				if (!paintAdoption.isPainted()) {
					showLoadError('the server served an unpainted shell');
				}
				return reject(new Error(
					'Could not adopt the painted page of "' + webstrateId + '".'));
			}
			state.version = adopted.version;
			doc.domReady = true;
			resolve(doc);
		})();
	});
};

// ---------------------------------------------------------------------------
// Secondary documents (webstrate.getDocument for other webstrates)
// ---------------------------------------------------------------------------

const secondaryDocs = new Map(); // webstrateId → SecondaryDoc

/**
 * A secondary document: another webstrate opened for its data (no DOM). It
 * keeps its own wire mirror (from fetchStructure), its canonical JsonML
 * model, and its own serialized commit queue — the same protocol as the
 * primary document, minus the DOM.
 * @param {string} webstrateId Webstrate id.
 * @private
 */
class SecondaryDoc {
	constructor(webstrateId) {
		this.id = webstrateId;
		this.state = { version: 0, data: [], exists: false };
		this.mirror = new Map(); // eid → mirror entry (see below)
		this.pendingCommits = [];
		this.inFlight = null;
		this.deferredFrames = [];
		this.listeners = { 'op batch': new Set(), 'nothing pending': new Set(),
			'error': new Set() };
		this.ready = false;
		this.preReadyFrames = [];
	}

	get version() { return this.state.version; }
	get v() { return this.state.version; }
	get data() { return this.state.data; }
	get type() {
		return this.state.exists ? { name: 'json0', uri: TYPE_JSONv0 } : null;
	}
	create() {}
	hasPending() { return this.inFlight !== null || this.pendingCommits.length > 0; }
	on(event, listener) {
		if (this.listeners[event]) this.listeners[event].add(listener);
	}
	off(event, listener) {
		if (this.listeners[event]) this.listeners[event].delete(listener);
	}

	signalDrained() {
		if (this.inFlight === null && this.pendingCommits.length === 0) {
			this.listeners['nothing pending'].forEach((listener) => listener());
		}
	}

	// -- initialization --------------------------------------------------

	/**
	 * Build the mirror and model from a fetchStructure payload.
	 * @param {object} structure {v, struct, state}.
	 * @private
	 */
	initializeFromStructure(structure) {
		const { jml } = jsonmlFromStructure(structure);
		const entries = new Map([[0, { p: null, i: null, t: WIRE_ELEMENT,
			n: null, kids: [], attrs: [], content: null }]]);
		for (const [p, i, e, t, n] of structure.struct) {
			entries.set(e, { p, i, t, n, kids: [], attrs: [], content: null });
			entries.get(p).kids[i] = e;
		}
		// State rows arrive ordered (eid, local position) — the push order
		// IS each element's attribute order, exactly like the server's rows.
		for (const [e, i, n, v] of structure.state) {
			const entry = entries.get(e);
			if (!entry) continue;
			if (n === null) entry.content = { v };
			else entry.attrs.push({ n, v });
		}
		this.mirror = entries;
		this.state.data = jml.length > 0 ? jml[0] : [];
		this.state.version = structure.v;
		this.state.exists = structure.v > 0;
	}

	// -- paths and materialization ----------------------------------------

	pathOfEid(eid) {
		const entry = this.mirror.get(eid);
		if (!entry || entry.p === null) return null;
		if (entry.p === 0) return entry.i === 0 ? [] : null;
		const parentPath = this.pathOfEid(entry.p);
		return parentPath === null ? null
			: [...parentPath, ELEMENT_LIST_OFFSET + entry.i];
	}

	materialize(eid, source) {
		const entry = (source || this.mirror).get(eid);
		if (!entry) return null;
		if (entry.t === WIRE_TEXT) return entry.content ? entry.content.v : '';
		if (entry.t === WIRE_COMMENT) {
			return ['!', entry.content ? entry.content.v : ''];
		}
		const props = { __wid: eid };
		for (const { n, v } of entry.attrs) {
			props[coreUtils.escapeDots(n)] = coreUtils.escape(v);
		}
		const jml = [entry.n, props];
		entry.kids.forEach((kid) => jml.push(this.materialize(kid, source)));
		return jml;
	}

	propsOfEid(eid) {
		const path = this.pathOfEid(eid);
		if (path === null) return null;
		let cursor = this.state.data;
		for (const step of [...path, ATTRIBUTE_INDEX]) {
			if (cursor === undefined || cursor === null) return null;
			cursor = cursor[step];
		}
		return cursor && typeof cursor === 'object' ? cursor : null;
	}

	// -- outgoing translation (json0 on the model → wire ops) -------------

	// (Attribute positions resolve inline in translateOutgoing below: an
	// existing name keeps its index in the mirror's ordered list, a new
	// name appends at the end — setAttribute semantics.)

	/**
	 * Mint an id for a secondary doc: secondary docs share the PRIMARY
	 * document's allocids blocks — ids are only valid per document, so a
	 * secondary document mints from its own 'allocids' request.
	 * @param  {int} count Number of ids needed.
	 * @return {Promise}   Resolves when the ids are in stock.
	 * @private
	 */
	ensureIds(count) {
		this.idPool = this.idPool || { next: 1, end: 0, refilling: null };
		const pool = this.idPool;
		if (pool.end - pool.next + 1 >= count) return Promise.resolve();
		if (pool.refilling) return pool.refilling;
		pool.refilling = new Promise((resolve, reject) => {
			coreWebsocket.send({ wa: 'allocids', d: this.id,
				count: Math.max(count, 64) }, (error, block) => {
				pool.refilling = null;
				if (error || !block || typeof block.start !== 'number') {
					return reject(new Error('allocids failed'));
				}
				if (block.start > pool.end) {
					if (pool.end - pool.next + 1 > 0) {
						console.warn('coreDatabase: secondary id blocks out of order');
					}
					pool.next = block.start;
				}
				pool.end = Math.max(pool.end, block.end);
				resolve();
			}, { waitForOpen: true });
		});
		return pool.refilling;
	}

	mintId() {
		const pool = this.idPool;
		return pool && pool.next <= pool.end ? pool.next++ : null;
	}

	/**
	 * Translate a batch of json0 ops against the model into wire ops (paths
	 * resolve on the mirror; li values mint eids for their whole subtree).
	 * @param  {[op]}   ops json0 ops.
	 * @return {Promise<[wireOp]>}       Wire ops.
	 * @private
	 */
	async translateOutgoing(ops) {
		// Budget: nodes in li values, plus slack for string/attr ops (no
		// attr consumes an id anymore — only eids are minted).
		let budget = 16;
		const valueCount = (jml) => {
			if (typeof jml === 'string' || typeof jml === 'number') return 1;
			if (!Array.isArray(jml)) return 0;
			let n = 1;
			for (let i = 1; i < jml.length; i++) {
				if (i === 1 && jml[i] && typeof jml[i] === 'object'
					&& !Array.isArray(jml[i])) continue;
				n += valueCount(jml[i]);
			}
			return n;
		};
		for (const op of ops) budget += valueCount(op.li || op.ld) + 2;
		await this.ensureIds(budget);

		const eidAt = (path) => {
			let entry = this.mirror.get(0);
			for (let i = 0; i < path.length; i++) {
				const step = path[i];
				if (step === ATTRIBUTE_INDEX) return entry === this.mirror.get(0)
					? null : entry;
				if (typeof step === 'string') return entry;
				const kidIndex = step - ELEMENT_LIST_OFFSET;
				entry = entry && entry.kids[kidIndex]
					? this.mirror.get(entry.kids[kidIndex]) : null;
				if (!entry) return null;
			}
			return entry;
		};

		const wire = [];
		const stash = new Map(); // same-batch moves

		const movedNodes = new Set();
		const ldEids = [];
		for (const op of ops) {
			if ('ld' in op) {
				const entry = eidAt(op.p.slice(0, -1));
				// (Resolved fully below in the ld branch.)
			}
		}
		// Move detection: an ld followed by an li of an identical value.
		for (let i = 0; i < ops.length; i++) {
			if (!('ld' in ops[i])) continue;
			for (let j = 0; j < ops.length; j++) {
				if (!('li' in ops[j]) || j === i) continue;
				if (JSON.stringify(ops[i].ld) === JSON.stringify(ops[j].li)) {
					movedNodes.add(i);
				}
			}
		}

		const emitSubtree = (jml, parentEid, index) => {
			if (typeof jml === 'string' || typeof jml === 'number') {
				const eid = this.mintId();
				const value = String(jml);
				this.mirror.set(eid, { p: parentEid, i: index, t: WIRE_TEXT,
					n: null, kids: [], attrs: [],
					content: { v: value } });
				wire.push({ k: 'sa', p: parentEid, i: index, e: eid, t: WIRE_TEXT,
					n: null });
				// The content write carries no position: a text node's only
				// "attribute" is its content, at implicit position 0.
				wire.push({ k: 'aa', e: eid, n: null, v: value });
				return eid;
			}
			if (Array.isArray(jml) && jml[0] === '!') {
				const eid = this.mintId();
				const value = typeof jml[1] === 'string' ? jml[1] : '';
				this.mirror.set(eid, { p: parentEid, i: index, t: WIRE_COMMENT,
					n: null, kids: [], attrs: [],
					content: { v: value } });
				wire.push({ k: 'sa', p: parentEid, i: index, e: eid, t: WIRE_COMMENT,
					n: null });
				wire.push({ k: 'aa', e: eid, n: null, v: value });
				return eid;
			}
			let eid = jml[1] && jml[1].__wid;
			if (typeof eid !== 'number') {
				eid = this.mintId();
				if (jml[1] && typeof jml[1] === 'object' && !Array.isArray(jml[1])) {
					jml[1].__wid = eid;
				} else {
					jml.splice(1, 0, { __wid: eid });
				}
			}
			this.mirror.set(eid, { p: parentEid, i: index, t: WIRE_ELEMENT,
				n: jml[0], kids: [], attrs: [], content: null });
			wire.push({ k: 'sa', p: parentEid, i: index, e: eid, t: WIRE_ELEMENT,
				n: jml[0] });
			const parentEntry = this.mirror.get(eid);
			let childIndex = 0;
			for (let i = 1; i < jml.length; i++) {
				const child = jml[i];
				if (i === 1 && child && typeof child === 'object'
					&& !Array.isArray(child)) {
					for (const [name, value] of Object.entries(child)) {
						if (name === '__wid') continue;
						const rawName = coreUtils.unescapeDots(name);
						// Insert at the running end: a fresh element's attrs
						// populate 0..n-1 in jml order, matching the server's
						// dense rows.
						const pos = parentEntry.attrs.length;
						parentEntry.attrs.push({ n: rawName,
							v: coreUtils.unescape(value) });
						wire.push({ k: 'aa', e: eid, i: pos, n: rawName,
							v: coreUtils.unescape(value) });
					}
					continue;
				}
				const childEid = emitSubtree(child, eid, childIndex);
				if (childEid === null) return null;
				childIndex += 1;
			}
			return eid;
		};

		for (let i = 0; i < ops.length; i++) {
			const op = ops[i];
			const path = op.p;
			const last = path[path.length - 1];

			if ('li' in op && movedNodes.has(i)) {
				const parentEid = this.eidOfPath(path.slice(0, -1));
				const eid = this.eidOfValue(op.li);
				wire.push({ k: 'sa', p: parentEid,
					i: last - ELEMENT_LIST_OFFSET, e: eid,
					t: this.mirror.get(eid).t, n: this.mirror.get(eid).n });
				continue;
			}

			if ('li' in op) {
				// Root insert on an empty model: the whole tree at p=[].
				if (path.length === 0) {
					const eid = emitSubtree(op.li, 0, 0);
					if (eid === null) return null;
					continue;
				}
				const parentEntry = eidAt(path.slice(0, -1));
				if (!parentEntry) continue;
				const parentEid = this.eidOfPath(path.slice(0, -1));
				const eid = emitSubtree(op.li, parentEid, last - ELEMENT_LIST_OFFSET);
				if (eid === null) return null;
				continue;
			}

			if ('ld' in op) {
				if (movedNodes.has(i)) {
					const entry = eidAt(path);
					const eid = this.eidOfPath(path);
					wire.push({ k: 'sr', e: eid, p: entry.p });
					// Detach on the mirror now; the paired li re-attaches.
					const parent = this.mirror.get(entry.p);
					const idx = parent.kids.indexOf(eid);
					if (idx !== -1) parent.kids.splice(idx, 1);
					const captured = {};
					const walk = (e) => {
						const node = this.mirror.get(e);
						if (!node) return;
						captured[e] = node;
						this.mirror.delete(e);
						node.kids.forEach(walk);
					};
					walk(eid);
					stash.set(eid, captured);
					continue;
				}
				const entry = eidAt(path);
				if (!entry) continue;
				const eid = this.eidOfPath(path);
				wire.push({ k: 'sr', e: eid, p: entry.p });
				const parent = this.mirror.get(entry.p);
				const idx = parent ? parent.kids.indexOf(eid) : -1;
				if (parent && idx !== -1) parent.kids.splice(idx, 1);
				const walk = (e) => {
					const node = this.mirror.get(e);
					if (!node) return;
					this.mirror.delete(e);
					node.kids.forEach(walk);
				};
				walk(eid);
				continue;
			}

			if ('oi' in op || 'od' in op) {
				const entry = eidAt(path.slice(0, -2));
				if (!entry || entry.t !== WIRE_ELEMENT) continue;
				const eid = this.eidOfPath(path.slice(0, -2));
				const rawName = coreUtils.unescapeDots(last);
				const idx = entry.attrs.findIndex((a) => a.n === rawName);
				if ('oi' in op && !('od' in op) && idx === -1) {
					// A brand-new attribute: setAttribute appends, so the
					// insert position is the current end of the list.
					entry.attrs.push({ n: rawName,
						v: coreUtils.unescape(op.oi) });
					wire.push({ k: 'aa', e: eid, i: entry.attrs.length - 1,
						n: rawName, v: coreUtils.unescape(op.oi) });
					continue;
				}
				if ('od' in op && !('oi' in op)) {
					// Plain removal — name-anchored on the wire (the server
					// resolved all concurrent shifts).
					if (idx !== -1) entry.attrs.splice(idx, 1);
					wire.push({ k: 'ar', e: eid, n: rawName });
					continue;
				}
				// A value update (od+oi on one key, or a bare set on an
				// existing name): in-place update, position preserved —
				// exactly what setAttribute did on the model's DOM twin.
				if (idx === -1) {
					entry.attrs.push({ n: rawName,
						v: coreUtils.unescape(op.oi) });
					wire.push({ k: 'aa', e: eid, i: entry.attrs.length - 1,
						n: rawName, v: coreUtils.unescape(op.oi) });
				} else {
					entry.attrs[idx].v = coreUtils.unescape(op.oi);
					wire.push({ k: 'aa', e: eid, i: idx, n: rawName,
						v: coreUtils.unescape(op.oi) });
				}
				continue;
			}

			if ('si' in op || 'sd' in op) {
				const isInsert = 'si' in op;
				const containerIndex = path[path.length - 2];
				if (typeof containerIndex === 'string') {
					const elemPath = path.slice(0, -3);
					const entry = eidAt(elemPath);
					if (!entry || entry.t !== WIRE_ELEMENT) continue;
					const eid = this.eidOfPath(elemPath);
					const rawName = coreUtils.unescapeDots(containerIndex);
					const idx = entry.attrs.findIndex((a) => a.n === rawName);
					if (idx === -1) continue;
					const attr = entry.attrs[idx];
					const canonical = coreUtils.escape(attr.v);
					const rawOffset = escapedOffsetToRaw(canonical, last);
					if (rawOffset === null) {
						// The fragment straddles an escape boundary — fall
						// back to a whole-value write at the same position.
						wire.push({ k: 'aa', e: eid, i: idx, n: rawName,
							v: coreUtils.unescape(attr.v) });
						continue;
					}
					wire.push({ k: isInsert ? 'si' : 'sd', e: eid, i: idx,
						q: rawOffset, v: coreUtils.unescape(isInsert ? op.si : op.sd) });
					if (isInsert) {
						attr.v = attr.v.slice(0, rawOffset)
							+ coreUtils.unescape(op.si) + attr.v.slice(rawOffset);
					} else {
						const fragment = coreUtils.unescape(op.sd);
						attr.v = attr.v.slice(0, rawOffset)
							+ attr.v.slice(rawOffset + fragment.length);
					}
					continue;
				}
				// Text/comment content op: the eid alone addresses the
				// string (implicit position 0).
				const entry = eidAt(path.slice(0, -1));
				if (!entry || entry.t === WIRE_ELEMENT) continue;
				const eid = this.eidOfPath(path.slice(0, -1));
				wire.push({ k: isInsert ? 'si' : 'sd', e: eid, q: last,
					v: isInsert ? op.si : op.sd });
				if (isInsert) {
					entry.content = {
						v: entry.content.v.slice(0, last) + op.si
							+ entry.content.v.slice(last) };
				} else {
					entry.content = { v: entry.content.v.slice(0, last)
						+ entry.content.v.slice(last + op.sd.length) };
				}
				continue;
			}
		}
		return wire;
	}

	eidOfPath(path) {
		const entry = this.pathEntry(path);
		if (!entry) return null;
		for (const [eid, candidate] of this.mirror.entries()) {
			if (candidate === entry) return eid;
		}
		return null;
	}

	eidOfValue() { return null; } // unused; moves are detected by value match

	pathEntry(path) {
		let entry = this.mirror.get(0);
		for (const step of path) {
			if (typeof step === 'string' || step === ATTRIBUTE_INDEX) return entry;
			const kidIndex = step - ELEMENT_LIST_OFFSET;
			if (kidIndex < 0 || !entry || !entry.kids[kidIndex]) return null;
			entry = this.mirror.get(entry.kids[kidIndex]);
			if (!entry) return null;
		}
		return entry;
	}

	submitOp(ops, options = {}) {
		ops = (ops || []).filter((op) => op && typeof op === 'object');
		if (ops.length === 0) return;
		try {
			json0.apply(this.state.data, ops);
		} catch (err) {
			this.listeners.error.forEach((listener) =>
				listener({ data: { a: 'op', op: ops }, message: err.message }));
			return;
		}
		this.pendingCommits.push({ ops, source: options.source });
		this.pump();
	}

	async pump() {
		while (!this.inFlight && this.pendingCommits.length > 0) {
			const entry = this.pendingCommits[0];
			let wire;
			try {
				wire = await this.translateOutgoing(entry.ops);
			} catch (err) {
				this.pendingCommits.shift();
				this.listeners.error.forEach((listener) =>
					listener({ data: { a: 'op', op: entry.ops },
						message: err.message }));
				this.signalDrained();
				continue;
			}
			this.pendingCommits.shift();
			if (!wire || wire.length === 0) {
				this.signalDrained();
				continue;
			}
			this.inFlight = entry;
			coreWebsocket.send({ wa: 'commit', d: this.id,
				base: this.state.version, ops: wire },
			(error, reply) => this.handleAck(entry, error, reply),
			{ waitForOpen: true });
			break;
		}
	}

	handleAck(entry, error, reply) {
		this.inFlight = null;
		if (error || !reply || reply.error) {
			try { json0.apply(this.state.data, invertOps(entry.ops)); }
			catch (err) { /* model already diverged */ }
			this.listeners.error.forEach((listener) => listener(
				{ data: { a: 'op', op: entry.ops },
					message: (error && error.message) || (reply && reply.error) }));
			this.signalDrained();
			this.pump();
			return;
		}
		this.state.version = reply.v;
		this.state.exists = true;
		if (reply.xformed === true) {
			// The server rebased our ops against a concurrent commit: the
			// model and mirror hold our original application, not the merged
			// result. Rebuild both from the server's head instead of trying
			// to un-apply; the deferred frames are already part of it.
			this.deferredFrames.length = 0;
			this.resync().then(() => {
				this.signalDrained();
				this.pump();
			});
			return;
		}
		const frames = this.deferredFrames.splice(0);
		for (const frame of frames) {
			if (frame.s === ownSocketId && frame.x !== true) continue;
			this.acceptFrame(frame, true);
		}
		this.signalDrained();
		this.pump();
	}

	acceptFrame(frame, force) {
		if (!force && frame.v <= this.state.version) return;
		if (!this.ready) {
			this.preReadyFrames.push(frame);
			return;
		}
		// Defer while anything is queued: the wire translation applies
		// pending ops to the mirror as it goes, so a frame may only be
		// translated against a mirror that holds exactly the server's
		// committed state (which is the case once every entry is acked).
		if (this.inFlight || this.pendingCommits.length > 0) {
			this.deferredFrames.push(frame);
			return;
		}
		this.applyFrame(frame);
	}

	applyFrame(frame) {
		if (frame.s === ownSocketId && frame.x !== true) {
			this.state.version = frame.v;
			return;
		}
		this.state.version = frame.v;
		// Translate against the mirror (json0 ops for the model + events).
		// A single-frame replay through the shared scratch translator keeps
		// positions exact without reimplementing the walk here.
		const translated = singleFrameWireToJson0(this, frame.ops);
		if (translated.length > 0) {
			try {
				json0.apply(this.state.data, translated);
			} catch (err) {
				this.resync();
				return;
			}
			this.listeners['op batch'].forEach((listener) =>
				listener(translated, frame.s));
		}
	}

	async resync() {
		const structure = await fetchStructure(this.id);
		if (structure) {
			this.initializeFromStructure(structure);
			this.ready = true;
			const frames = this.preReadyFrames.splice(0);
			for (const frame of frames) {
				if (frame.v <= this.state.version) continue;
				this.applyFrame(frame);
			}
		}
	}
}

/**
 * Translate one frame's wire ops into json0 for a secondary document, using
 * the doc's own mirror (updated along the way, stash semantics included).
 * @param  {SecondaryDoc} doc      Secondary document.
 * @param  {[wireOp]}     frameOps Wire ops of the frame.
 * @return {[op]}                 json0 ops.
 * @private
 */
function singleFrameWireToJson0(doc, frameOps) {
	const ops = [];
	const prePaths = new Map();
	for (const op of frameOps) {
		if (op.k === 'sr' && doc.mirror.has(op.e)) {
			prePaths.set(op.e, doc.pathOfEid(op.e));
		}
	}
	const mirror = doc.mirror;
	const cloneValue = (value) => (typeof value === 'string' ? value
		: JSON.parse(JSON.stringify(value)));
	const stash = new Map();
	const materializeFrom = (source, eid) => doc.materialize(eid, source);

	const pathOf = (eid) => doc.pathOfEid(eid);

	for (const op of frameOps) {
		switch (op.k) {
			case 'sa': {
				if (mirror.has(op.e)) break; // z re-attach of a live node
				const stashed = stash.get(op.e);
				const entry = stashed || { t: op.t, n: op.n, kids: [],
					attrs: [], content: null };
				if (stashed) stash.delete(op.e);
				entry.t = op.t;
				entry.n = op.n;
				entry.p = op.p;
				const parent = mirror.get(op.p);
				if (!parent) break;
				const clamped = Math.min(op.i, parent.kids.length);
				parent.kids.splice(clamped, 0, op.e);
				entry.i = parent.kids.indexOf(op.e);
				mirror.set(op.e, entry);
				const parentPath = pathOf(op.p);
				if (parentPath !== null) {
					ops.push({ p: [...parentPath, ELEMENT_LIST_OFFSET + entry.i],
						li: cloneValue(materializeFrom(mirror, op.e)) });
				}
				break;
			}
			case 'sr': {
				const entry = mirror.get(op.e);
				if (!entry) break;
				const parent = mirror.get(entry.p);
				const idx = parent ? parent.kids.indexOf(op.e) : -1;
				if (parent && idx !== -1) parent.kids.splice(idx, 1);
				mirror.delete(op.e);
				const captured = new Map([[op.e, entry]]);
				entry.kids.forEach(function walk(e) {
					const kid = mirror.get(e);
					if (kid) {
						captured.set(e, kid);
						mirror.delete(e);
						kid.kids.forEach(walk);
					}
				});
				stash.set(op.e, entry);
				const prePath = prePaths.get(op.e);
				if (prePath) {
					ops.push({ ld: cloneValue(materializeFrom(captured, op.e)),
						p: prePath });
				}
				break;
			}
			case 'aa': {
				const entry = mirror.get(op.e);
				if (!entry) break;
				if (op.n === null) {
					const previous = entry.content ? entry.content.v : '';
					if (previous === op.v) break;
					const path = pathOf(op.e);
					if (path !== null) {
						if (entry.t === WIRE_COMMENT) {
							if (previous) ops.push({ sd: previous, p: [...path, 1, 0] });
							if (op.v) ops.push({ si: op.v, p: [...path, 1, 0] });
						} else {
							if (previous) ops.push({ sd: previous, p: [...path, 0] });
							if (op.v) ops.push({ si: op.v, p: [...path, 0] });
						}
					}
					entry.content = { v: op.v };
					break;
				}
				// Name-anchored: in-place update keeps the position, a new
				// name inserts at the local position i (clamped) — the
				// ordered array mirrors the server.
				const existing = entry.attrs.find((a) => a.n === op.n);
				const path = pathOf(op.e);
				if (existing) {
					if (existing.v === op.v) break;
					if (path !== null) {
						ops.push({ p: [...path, ATTRIBUTE_INDEX,
							coreUtils.escapeDots(op.n)],
						od: coreUtils.escape(existing.v),
						oi: coreUtils.escape(op.v) });
					}
					existing.v = op.v;
					break;
				}
				const at = Number.isInteger(op.i)
					? Math.min(op.i, entry.attrs.length) : entry.attrs.length;
				entry.attrs.splice(at, 0, { n: op.n, v: op.v });
				if (path !== null) {
					ops.push({ p: [...path, ATTRIBUTE_INDEX,
						coreUtils.escapeDots(op.n)], oi: coreUtils.escape(op.v) });
				}
				break;
			}
			case 'ar': {
				const entry = mirror.get(op.e);
				if (!entry) break;
				// Name form from clients/history; position form ({e, i})
				// resolves through the ordered list.
				const idx = typeof op.n === 'string'
					? entry.attrs.findIndex((a) => a.n === op.n)
					: (Number.isInteger(op.i) ? op.i : -1);
				const attr = idx >= 0 && idx < entry.attrs.length
					? entry.attrs[idx] : null;
				if (!attr) break;
				entry.attrs.splice(idx, 1);
				const path = pathOf(op.e);
				if (path !== null) {
					ops.push({ od: coreUtils.escape(attr.v),
						p: [...path, ATTRIBUTE_INDEX, coreUtils.escapeDots(attr.n)] });
				}
				break;
			}
			case 'si':
			case 'sd': {
				const isInsert = op.k === 'si';
				const entry = mirror.get(op.e);
				if (!entry) break;
				const path = pathOf(op.e);
				if (path === null) break;
				if (entry.t !== WIRE_ELEMENT) {
					const current = entry.content ? entry.content.v : '';
					ops.push(entry.t === WIRE_COMMENT
						? { p: [...path, 1, op.q], [isInsert ? 'si' : 'sd']: op.v }
						: { p: [...path, op.q], [isInsert ? 'si' : 'sd']: op.v });
					entry.content = { v: isInsert
						? current.slice(0, op.q) + op.v + current.slice(op.q)
						: current.slice(0, op.q) + current.slice(op.q + op.v.length) };
					break;
				}
				// Attribute strings are position-addressed on the wire.
				const attr = Number.isInteger(op.i)
					? entry.attrs[op.i] : null;
				if (!attr) break;
				const canonical = coreUtils.escape(attr.v);
				const offset = rawOffsetToEscaped(canonical, op.q);
				ops.push({ p: [...path, ATTRIBUTE_INDEX,
					coreUtils.escapeDots(attr.n), offset],
				[isInsert ? 'si' : 'sd']: coreUtils.escape(op.v) });
				attr.v = isInsert
					? attr.v.slice(0, op.q) + op.v + attr.v.slice(op.q)
					: attr.v.slice(0, op.q) + attr.v.slice(op.q + op.v.length);
				break;
			}
		}
	}
	return ops;
}

// Having multiple subscriptions to the same webstrate behaves oddly, so
// getDocument returns nothing when a subscription already exists (the same
// guard the ShareDB client had).
const subscriptions = new Set();
Object.defineProperty(globalObject.publicObject, 'getDocument', {
	value: (webstrateId) => {
		// In case this document is transcluded as well, we recursively ask the
		// parent for the document.
		if (!ready && !coreUtils.getLocationObject().staticMode) {
			try {
				return window.parent.window.webstrate.getDocument(webstrateId);
			} catch (err) { /* not transcluded (or the parent lacks it) */ }
		}

		if (subscriptions.has(webstrateId)) return;
		subscriptions.add(webstrateId);

		if (webstrateId === state.webstrateId) return doc;

		const secondary = new SecondaryDoc(webstrateId);
		secondaryDocs.set(webstrateId, secondary);
		// Boot: fetch the structure at head, then replay anything newer.
		secondary.resync();
		return secondary;
	}
});

// ---------------------------------------------------------------------------
// Parity exports (fetch / restore / getOps / getDocument / elementAtPath)
// ---------------------------------------------------------------------------

/**
 * Set the version (`v`) or tag label (`l`) property on a message object.
 * @param {Object}        msgObj       Message object.
 * @param {string|Number} tagOrVersion Tag label or version number.
 * @private
 */
function setVersionOrTag(msgObj, tagOrVersion) {
	if (/^\d+$/.test(String(tagOrVersion))) {
		// Version 0 is a valid version, so the coerced value mustn't be tested
		// for truthiness.
		msgObj.v = Number(tagOrVersion);
	} else {
		msgObj.l = tagOrVersion;
	}
}

exports.fetch = (webstrateId, tagOrVersion) => {
	return new Promise((resolve, reject) => {
		// The document is named only when it is not this socket's own.
		const msgObj = { wa: 'fetchdoc' };
		if (webstrateId !== state.webstrateId) msgObj.d = webstrateId;

		setVersionOrTag(msgObj, tagOrVersion);

		coreWebsocket.send(msgObj, (err, doc) => {
			if (err) return reject(err);
			coreEvents.triggerEvent('receivedDocument', doc, { static: true });
			resolve(doc);
		}, { waitForOpen: true });
	});
};

/**
 * Restore document to a previous version, either by version number or tag
 * label. The server applies the diff as a commit, which arrives (to every
 * subscriber, including us) as a regular {wa: 'ops'} frame.
 * @param {string}        webstrateId  Webstrate id.
 * @param {string|Number} tagOrVersion Tag label or version number.
 * @param {Function}      callback     Callback.
 * @public
 */
exports.restore = (webstrateId, tagOrVersion, callback) => {
	const msgObj = { wa: 'restore' };
	if (webstrateId !== state.webstrateId) msgObj.d = webstrateId;

	setVersionOrTag(msgObj, tagOrVersion);

	coreWebsocket.send(msgObj, callback);
};

/**
 * Get a range of ops from a specific webstrate (json0 ops, replayed from the
 * wire log).
 * @param  {string}   webstrateId Webstrate to get ops from.
 * @param  {Number}   fromVersion Version to start the op range from (inclusive).
 * @param  {Number}   toVersion   Version to end the op range at (exclusive).
 * @param  {Function} callback    Callback.
 * @return {Array}                (async) Array of ops in the range.
 * @public
 */
exports.getOps = (webstrateId, fromVersion, toVersion, callback) => {
	const msgObj = {
		wa: 'getOps',
		from: fromVersion,
		to: toVersion
	};
	if (webstrateId !== state.webstrateId) msgObj.d = webstrateId;
	coreWebsocket.send(msgObj, (error, reply) => {
		if (error || !Array.isArray(reply)) return callback && callback(error, reply);
		callback && callback(null, commitsWireToJson0(reply));
	});
};

/**
 * Get the document, or get an element at a certain path in the document if a
 * path is provided.
 * @param  {Array} path  (optional) Path into the document.
 * @return {mixed}       The live doc object or a path into its data.
 * @public
 */
exports.getDocument = (path) => {
	if (!path || !Array.isArray(path)) return doc;
	return path.reduce((data, step) => data && data[step], state.data);
};

/**
 * Get the element at a given path in a JsonML document.
 * @param  {JsonML}     snapshot (optional) JsonML to navigate; defaults to
 *                       the live document.
 * @param  {JsonMLPath} path     Path to follow in snapshot.
 * @return {JsonML}              Element at path.
 * @public
 */
exports.elementAtPath = (snapshot, path) => {
	if (!path) {
		path = snapshot;
		snapshot = state.data;
	}

	if (path.length > 0 && typeof path[path.length - 1] === 'string') {
		return null;
	}

	const [head, ...tail] = path;
	if (!head || snapshot[head] === undefined) {
		return snapshot;
	}

	return exports.elementAtPath(snapshot[head], tail);
};
