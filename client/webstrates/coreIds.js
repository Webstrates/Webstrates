'use strict';
/*
coreIds (client/webstrates/coreIds.js)

Element ids (eids) and attribute indexes for the document protocol.

In the SQLite-backed storage architecture, every node of a webstrate —
element, text or comment — is identified by an integer element id (eid)
minted from the document's global id counter. The counter is handed out in
blocks through the 'allocids' protocol action, and eids are never rewritten
by the server, so a client-minted id is globally valid for the lifetime of
the document. The same eid identifies the node in the DOM, the path tree,
the wire operations and the server's two SQLite stores. Attribute indexes
(x) — including the single unnamed "content" attribute of text and comment
nodes — come from the same counter, which is what lets several clients add
nodes and attributes concurrently without coordination.

Elements carry their eid in the __wid property (an integer now; it used to
be a random string owned by the server). Text and comment nodes carry theirs
in a __eid property. This module owns:

  - the eid pool: 'allocids' blocks with eager refill and promise-based
    waiting for whoever needs ids that aren't in stock,
  - the registries: eid → DOM node, and the local attribute-position
    helpers (the DOM's own ordered attribute list IS the name↔position
    map — no parallel registry is kept),
  - the DOM event listeners that keep the registries current: incoming
    text/comment nodes (created by the op applier from wire sa/aa pairs)
    pick their eids from a FIFO of pending metadata; deleted nodes are
    forgotten synchronously so that a detached-then-re-inserted subtree
    is rebuilt fresh, like the server's move stash.
*/
const coreEvents = require('./coreEvents');
const coreConfig = require('./coreConfig');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');

// These events are also created (idempotently) by coreOpCreator and
// coreOpApplier — creating them here too lets coreIds register its
// listeners at load time, before any of those modules load.
coreEvents.createEvent('DOMNodeInserted', { idempotent: true });
coreEvents.createEvent('DOMNodeDeleted', { idempotent: true });

const coreIds = {};

// Pool: the ids [poolNext, poolEnd] are ours to hand out.
let poolNext = 1;
let poolEnd = 0;

// One 'allocids' roundtrip at a time; everyone else awaits the same promise.
let refillInFlight = null;

// Resolvers waiting for ids to become available (woken on every refill).
const waiters = [];

// How many ids to request per 'allocids' call. Larger blocks mean fewer
// roundtrips when a client inserts whole subtrees, but more ids stranded in
// a client that never uses them. 256 covers a medium-sized paste.
const REFILL_BLOCK_SIZE = 256;

// Never let the pool go below this share of a block when a refill is
// triggered opportunistically (after a commit consumed ids).
const REFILL_THRESHOLD = 32;

/**
 * Number of ids currently in the pool.
 * @return {int} Available ids.
 * @public
 */
coreIds.availableIds = () => poolEnd - poolNext + 1;

/**
 * Mint one id from the pool, or null if the pool is empty. Callers that
 * cannot proceed without an id should use ensureIds/refill instead.
 * @return {int|null} A fresh eid.
 * @public
 */
coreIds.mintId = () => (poolNext <= poolEnd ? poolNext++ : null);

/**
 * Whether at least `count` ids are available right now (synchronously).
 * @param  {int} count Number of ids needed.
 * @return {bool}      True if minting can proceed without a roundtrip.
 * @public
 */
coreIds.ensureIds = (count) => coreIds.availableIds() >= count;

/**
 * Request more ids from the server. Safe to call repeatedly: concurrent
 * callers share one roundtrip. Resolves only once at least `minAvailable`
 * ids are actually in the pool — a piggybacked caller whose need exceeds
 * the in-flight request's size keeps the loop going with a fresh, bigger
 * roundtrip instead of being woken early (an early wake made the commit
 * pump drop whole entries whenever a small opportunistic refill was in
 * flight when a large insert needed the pool).
 * @param  {int}      minAvailable Ids that must be available afterwards.
 * @param  {int}      minExtra    Extra ids to request beyond that.
 * @return {Promise}              Resolves when ids are in stock; rejects
 *                                when the server refuses to allocate.
 * @public
 */
coreIds.refill = async (minAvailable = 1, minExtra = 0) => {
	while (coreIds.availableIds() < minAvailable) {
		// Only one caller performs a roundtrip at a time; the rest
		// piggyback on the same promise and re-check their minimum after
		// it settles.
		if (!refillInFlight) {
			const need = Math.max(
				minAvailable - coreIds.availableIds(), minExtra);
			const count = Math.max(need, REFILL_BLOCK_SIZE);
			refillInFlight = new Promise((resolve, reject) => {
				coreWebsocket.send({ wa: 'allocids', count },
					(error, block) => {
						if (error || !block || typeof block.start !== 'number') {
							return reject(new Error(
								`allocids failed: ${error || 'invalid reply'}`));
						}
						// Blocks come back ascending and never overlap (the
						// server hands them out from a single counter), so
						// extending works even if a previous block is still
						// partly unused.
						if (block.start > poolEnd) {
							if (coreIds.availableIds() > 0) {
								// Leave a note rather than silently stranding
								// ids. Expected whenever another client on the
								// same document refilled in between (blocks
								// interleave on the shared per-document counter):
								// a few of our unused ids are stranded, but
								// uniqueness is unaffected.
								console.warn('coreIds: id blocks out of order '
									+ '— resetting pool.');
							}
							poolNext = block.start;
						}
						poolEnd = Math.max(poolEnd, block.end);
						resolve();
					}, { waitForOpen: true });
			}).finally(() => {
				refillInFlight = null;
				coreIds.wakeWaiters();
			});
		}
		// A rejection propagates to every piggybacking caller (the pool did
		// not grow); a resolve loops: callers whose minimum is not yet met
		// start the next, larger roundtrip themselves. A resolved roundtrip
		// that somehow grew the pool by nothing would loop forever — bail
		// instead.
		const availBefore = coreIds.availableIds();
		await refillInFlight;
		if (coreIds.availableIds() <= availBefore) {
			throw new Error('allocids made no progress');
		}
	}
};

/**
 * Resolve everyone waiting on a refill (or on nothing at all — callers may
 * have been able to proceed without ids after all).
 * @public
 */
coreIds.wakeWaiters = () => {
	while (waiters.length > 0) {
		waiters.shift()();
	}
};

/**
 * Refill opportunistically when the pool runs low, so the next commit never
 * has to wait for a roundtrip. Called after every consumed commit.
 * @public
 */
coreIds.maybeRefill = () => {
	if (coreIds.availableIds() <= REFILL_THRESHOLD && !refillInFlight) {
		coreIds.refill(REFILL_BLOCK_SIZE, REFILL_BLOCK_SIZE);
	}
};

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

// eid → WeakRef of the DOM node (elements, text and comment nodes alike).
// The registry holds weak references on purpose: a node nothing else anchors
// (removed from the document, no queued op carrying it as __node, no frame
// stash) must be collectable — every DOM removal used to leak the entire
// subtree here (see the subtree-removal benchmark wedge). Live nodes are
// always reachable through the document; transiently detached ones are
// anchored by whatever still needs them (queue entries, move echoes); the
// rest are garbage and so is their registry entry (pruned lazily by
// nodeOf/forget).
const eidToNode = new Map();

/**
 * Register a node under an eid (replacing any older node for that eid —
 * a recreated node legitimately takes over the id).
 * @param {int}      eid  Element id.
 * @param {DOMNode}  node Node to register.
 * @private
 */
const pin = (eid, node) => eidToNode.set(eid, new WeakRef(node));

// Template content fragment → its template element. Chromium's content
// fragments expose no host property, and the fragment has no parent to walk
// up to — so the mapping is recorded at registration time (every modeled
// template passes through registerElement, from the paint adoption or the
// op creator alike).
const contentHosts = new WeakMap();

/**
 * Get the template element whose content is the given fragment.
 * @param  {DocumentFragment} fragment Content fragment.
 * @return {DOMElement}                Template element, if known.
 * @public
 */
coreIds.hostOf = (fragment) => {
	if (!fragment) return undefined;
	const host = contentHosts.get(fragment);
	return host;
};

/**
 * The eid of a node acting as a parent container: the document is 0, a
 * template content fragment resolves to its template (children of a template
 * belong to the template itself on the wire), anything else to its own eid.
 * @param  {DOMNode} container Parent node (element, document or fragment).
 * @return {int}               Container eid, if known.
 * @public
 */
coreIds.eidOfContainer = (container) => {
	if (!container) return undefined;
	if (container.nodeType === document.DOCUMENT_NODE) return 0;
	if (container.nodeType === document.DOCUMENT_FRAGMENT_NODE) {
		const host = contentHosts.get(container);
		return host ? coreIds.getEid(host) : undefined;
	}
	return coreIds.getEid(container);
};

/**
 * Register an element's eid (defines the non-modifiable __wid property).
 * Re-registering an existing eid is a no-op.
 * @param {DOMElement} node Element.
 * @param {int}        eid  Element id.
 * @public
 */
coreIds.registerElement = (node, eid) => {
	if (node.tagName === 'TEMPLATE' && node.content) {
		contentHosts.set(node.content, node);
	}
	if (node.__wid !== undefined && node.__wid !== null) {
		// The node already carries an id (toHTML set it from the jml): only
		// attach the registry entry when it is the very id being registered —
		// re-registering a moved node refreshes the mapping.
		if (node.__wid === eid) pin(eid, node);
		return;
	}
	coreUtils.setWidOnElement(node, eid);
	pin(eid, node);
};

/**
 * Register a text or comment node's eid. The eid is stored as a plain
 * property (the node keeps it through DOM moves, which detach but do not
 * recreate it). The node's single "attribute" — its content — needs no
 * index: the eid alone addresses it (local position 0).
 * @param {DOMNode} node       Text or comment node.
 * @param {int}     eid        Element id.
 * @public
 */
coreIds.registerTextOrComment = (node, eid) => {
	if (node.__eid !== undefined && node.__eid !== null) {
		pin(node.__eid, node); // re-registering a moved node
		return;
	}
	node.__eid = eid;
	pin(eid, node);
};

/**
 * Get the eid of any node (element, text or comment), or undefined.
 * @param  {DOMNode} node Node.
 * @return {int}          Element id, if the node has one.
 * @public
 */
coreIds.getEid = (node) => {
	if (!node) return undefined;
	if (node.nodeType === document.ELEMENT_NODE) return node.__wid;
	return node.__eid;
};

/**
 * Get the DOM node of an eid (live or recently detached).
 * @param  {int}      eid Element id.
 * @return {DOMNode}     Node, if known.
 * @public
 */
coreIds.nodeOf = (eid) => {
	const ref = eidToNode.get(eid);
	if (ref === undefined) return undefined;
	const node = ref.deref();
	if (node === undefined) eidToNode.delete(eid); // pruned: entry was dead
	return node;
};

/**
 * Forget a node (synchronously — a detached node that gets re-inserted
 * later is rebuilt as a fresh node, mirroring the server's move stash).
 * @param {DOMNode} node Node to forget.
 * @public
 */
coreIds.forget = (node) => {
	const eid = coreIds.getEid(node);
	if (eid === undefined) return;
	const ref = eidToNode.get(eid);
	if (ref !== undefined && ref.deref() === node) {
		eidToNode.delete(eid);
	}
};

// ---------------------------------------------------------------------------
// Attribute positions (the DOM's own attribute list IS the index map)
// ---------------------------------------------------------------------------

// The element's modeled attributes in DOM order: transient attributes and
// the two transport-only names never count. Attribute positions address
// the mirror's ordered list, which holds exactly these — the DOM preserves
// that order by construction (setAttribute appends a new name, updates an
// existing one in place, removeAttribute shifts later ones left).
const modeledAttrs = (element) => {
	const out = [];
	for (const attr of element.attributes) {
		if (attr.name === '_' || attr.name === 'data-webstrates-type') continue;
		if (coreConfig.isTransientAttribute(element, attr.name)) continue;
		out.push(attr);
	}
	return out;
};

/**
 * The local (wire) position of an element's attribute: its index among the
 * modeled attributes. A name not in the list takes the current end —
 * append, matching DOM creation semantics.
 * @param  {DOMElement} element       Element.
 * @param  {string}     attributeName Raw attribute name.
 * @return {int}                      Local attribute position.
 * @public
 */
coreIds.attrPosition = (element, attributeName) => {
	const attrs = modeledAttrs(element);
	const pos = attrs.findIndex((a) => a.name === attributeName);
	return pos !== -1 ? pos : attrs.length;
};

/**
 * The name of the modeled attribute at a local position (incoming
 * position-addressed ops resolve through the live DOM).
 * @param  {DOMElement} element Element.
 * @param  {int}        i       Local attribute position.
 * @return {string}             Raw attribute name, or undefined.
 * @public
 */
coreIds.attrNameAt = (element, i) => {
	return modeledAttrs(element)[i]?.name;
};

/**
 * The number of modeled attributes (the position a fresh append takes).
 * @param  {DOMElement} element Element.
 * @return {int}                 Count.
 * @public
 */
coreIds.modeledAttrCount = (element) => modeledAttrs(element).length;

/**
 * The element's modeled attributes in DOM order (raw Attr objects) — for
 * incoming ops that must materialize the mirror's attribute order.
 * @param  {DOMElement} element Element.
 * @return {[Attr]}             Modeled attributes, DOM order.
 * @public
 */
coreIds.modeledAttrList = (element) => modeledAttrs(element);

// ---------------------------------------------------------------------------
// Incoming text/comment metadata queue
// ---------------------------------------------------------------------------

// {eid} entries, in creation order, for the text and comment nodes that
// the op applier is about to insert. The applier creates a text node from a
// bare JsonML string (which cannot carry an eid), so the translation layer
// queues the metadata here and the DOMNodeInserted listener picks it up.
// (No content index rides along — a text node's single "attribute" is its
// content, at implicit position 0.)
const pendingTextMeta = [];

/**
 * Queue the eid of an incoming text/comment node.
 * @param {int} eid Element id.
 * @public
 */
coreIds.queueTextMeta = (eid) => {
	pendingTextMeta.push({ eid });
};

// Keep the registries current as nodes come and go. Elements register their
// eids themselves (through toHTML's __wid handling on the incoming path, and
// through the op translation on the outgoing path); only text and comment
// nodes need the queue. The op applier fires DOMNodeInserted for the ROOT of
// an inserted subtree only, so an element insert with pending metadata walks
// its subtree pre-order, consuming the queue in document order (which is the
// JsonML order the translation queued). IMMEDIATE priority so registration
// happens before anything reacts to the insertion.
coreEvents.addEventListener('DOMNodeInserted', (node) => {
	if (node.nodeType === document.ELEMENT_NODE) {
		// Remote inserts carry their eids on the wire (toHTML set __wid from
		// the jml); register every element of the subtree — the registry is
		// how incoming sr/aa frames resolve nodes by eid — while consuming
		// the text/comment metadata queue in the same pre-order (the walk
		// mirrors queueTextMetaInOrder's JsonML order). Local inserts mint
		// and register their ids through the creator path instead.
		if (node.__wid !== undefined && node.__wid !== null) {
			pin(node.__wid, node);
		}
		let exhausted = false;
		const register = (element) => {
			for (const child of element.childNodes) {
				if (exhausted) return;
				if (child.nodeType !== document.TEXT_NODE
					&& child.nodeType !== document.COMMENT_NODE) {
					if (child.nodeType === document.ELEMENT_NODE) {
						if (child.__wid !== undefined && child.__wid !== null) {
							pin(child.__wid, child);
						}
						register(child);
					}
					continue;
				}
				if (child.__eid !== undefined && child.__eid !== null) {
					// A moved node: keep the registry entry, no queue use.
					pin(child.__eid, child);
					continue;
				}
				const meta = pendingTextMeta.shift();
				if (!meta) {
					exhausted = true; // do not steal later frames' entries
					return;
				}
				coreIds.registerTextOrComment(child, meta.eid);
			}
		};
		register(node);
		return;
	}
	if (node.nodeType !== document.TEXT_NODE
		&& node.nodeType !== document.COMMENT_NODE) return;
	if (node.__eid !== undefined && node.__eid !== null) {
		// The node is being moved, not created: keep the registry entry
		// (forget() may have dropped it when it was detached).
		pin(node.__eid, node);
		return;
	}
	const meta = pendingTextMeta.shift();
	if (!meta) return; // local insert: the op translation mints the eid
	coreIds.registerTextOrComment(node, meta.eid);
}, coreEvents.PRIORITY.IMMEDIATE);

coreEvents.addEventListener('DOMNodeDeleted', (node) => {
	if (node.nodeType === document.ELEMENT_NODE) {
		coreIds.forget(node);
		return;
	}
	// Text and comment nodes may come back (a same-batch move removes and
	// re-inserts them, and the DOM node object survives the detour), so only
	// drop the registry entry — the __eid property stays for the re-insert.
	coreIds.forget(node);
}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = coreIds;
