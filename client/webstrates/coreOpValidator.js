'use strict';
/*
 * Webstrates op validator (coreOpValidator.js)
 *
 * The client translates DOM mutations into json0 operations (coreOpCreator) by
 * replaying MutationObserver records against the DOM as it looks at the *end* of
 * each mutation batch, while maintaining a PathTree and a JsonML snapshot that
 * are only partially updated mid-batch. If those models ever diverge,
 * the replay can produce operations that do not
 * apply to the document at all: paths that end in `undefined`, string ops aimed
 * at arrays. Submitting such an op makes ShareDB apply it locally first, where
 * it throws (e.g. `undefined.slice` in ot-json0's text injection), triggers a
 * hard rollback (fetching the server state and discarding everything pending),
 * and the user's edit is silently lost; the resulting client-side error also
 * lacks the payload the databaseErrors handler expects.
 *
 * This module is the tripwire: before any locally created op is submitted, it is
 * applied to a throw-away clone of the snapshot. If it doesn't apply cleanly,
 * it never reaches ShareDB. The failure is reported through the regular
 * databaseError event instead, and the DOM keeps the user's edit — a loud,
 * debuggable failure mode rather than a silent one.
 *
 * The check is deliberately *only* "applies cleanly": it runs the exact same
 * json0.apply the submission itself would run, so it cannot reject anything the
 * submission would have accepted. (In particular it does not try to verify op
 * payloads against the snapshot: replaying a batch that replaces a subtree in
 * one go can legitimately emit e.g. a list-delete whose payload doesn't match —
 * json0 ignores list-delete payloads when applying, and only the path matters —
 * and any stricter check would refuse such batches outright, which is worse
 * than what it protects against.) The single exception is a *null* insertion
 * payload: json0 would accept it, but null is not a JsonML value — it would
 * crash toHTML on the next load and brick the document. See validateOps.
 */
const json0 = require('ot-json0/lib/json0');

/**
 * Shallow-copy an array or plain object (one level).
 * @param  {mixed} node Array or object to copy.
 * @return {mixed}      Shallow copy.
 * @private
 */
function shallowCloneNode(node) {
	return Array.isArray(node) ? node.slice() : Object.assign({}, node);
}

/**
 * Clone, in `root` (a working copy), the chain of arrays/objects along one
 * op's path, so that applying the op cannot reach — and mutate — a node that
 * is still shared with the live snapshot. Siblings along the chain stay
 * shared by reference: json0.apply only ever mutates nodes ON an op's path
 * (list splices and object writes at the walked keys); everything off the
 * path is only read.
 *
 * Called per op, immediately before that op is applied, against the state
 * left by the previous ops: if an earlier op in the list shifted siblings
 * around (li/ld), a position may now hold a node that was not on any earlier
 * spine, so the spine has to be refreshed for the current op.
 *
 * @param  {JsonML} root Working copy (already detached from the snapshot).
 * @param  {Object} op   Operation about to be applied.
 * @private
 */
function cloneOpPathSpine(root, op) {
	if (!op || !Array.isArray(op.p)) return;
	if (root === null || typeof root !== 'object') return;
	let node = root;
	for (let i = 0; i < op.p.length; i++) {
		const child = node[op.p[i]];
		// Strings (attribute values, text nodes) and other leaves are
		// immutable — json0 replaces them wholesale, so they need no clone.
		// Missing (undefined) children are left as-is; json0.apply reports
		// them ('Path invalid').
		if (child === null || typeof child !== 'object') break;
		node[op.p[i]] = shallowCloneNode(child);
		node = node[op.p[i]];
	}
}

/**
 * Validate that a list of json0 operations applies, in order, to a clone of the
 * snapshot.
 *
 * The clone is a working copy in which only each op's path spine is private
 * (see cloneOpPathSpine); the real submission re-applies the ops through
 * ShareDB as usual. An earlier version of this check deep-cloned the whole
 * snapshot with a JSON round-trip on every createdOps event; validateOps runs
 * synchronously per event inside the MutationObserver callback, so a batch
 * emitting one op per record (hundreds of multi-KB attribute updates) cloned
 * the entire document once per op — quadratic transient allocation (GBs of
 * churn on multi-MB documents) and multi-second main-thread CPU (measured
 * ~4-8s for a 600-op storm on a 1-2.4MB document, growing with document size
 * and op count). Cloning only
 * the op paths is equivalent for apply purposes (json0 mutates nothing off an
 * op's path) and costs O(siblings along the op paths) instead of O(document
 * bytes).
 *
 * @param  {JsonML} snapshot Document snapshot the ops will be applied to.
 * @param  {Array}   ops     Operations as triggered through the createdOps event.
 * @return {Error?}         First operation that does not apply, or null.
 * @public
 */
exports.validateOps = (snapshot, ops) => {
	// JsonML is plain JSON, so a JSON round-trip is an exact, dependency-free
	// clone — kept as the fallback for degenerate snapshots, where it
	// preserves the exact previous behavior (including what json0.apply then
	// throws on).
	let clone;
	if (!snapshot || typeof snapshot !== 'object') {
		clone = JSON.parse(JSON.stringify(snapshot || null));
	} else {
		clone = shallowCloneNode(snapshot);
	}

	for (const op of ops) {
		// json0 would happily insert null into the document (listInsert/objectInsert
		// never look at the value), but null is fromHTML's "not part of the model"
		// marker, not a JsonML value. The one thing null in a document does is
		// crash toHTML (null.nodeType) on the next load, bricking the document.
		// No legitimate creator output ever contains an insertion payload of null.
		if (('li' in op && op.li === null) || ('oi' in op && op.oi === null)) {
			const nullError = new Error('insertion op has a null payload '
				+ '(null is not a JsonML value; the document would become unloadable)');
			nullError.op = op;
			return nullError;
		}

		try {
			cloneOpPathSpine(clone, op);
			json0.apply(clone, [op]);
		} catch (error) {
			const validationError = new Error('op does not apply to the snapshot: '
				+ (error && error.message ? error.message : error));
			validationError.op = op;
			validationError.cause = error;
			return validationError;
		}
	}

	return null;
};
