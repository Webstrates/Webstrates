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
 * Validate that a list of json0 operations applies, in order, to a clone of the
 * snapshot.
 * @param  {JsonML} snapshot Document snapshot the ops will be applied to.
 * @param  {Array}   ops     Operations as triggered through the createdOps event.
 * @return {Error?}         First operation that does not apply, or null.
 * @public
 */
exports.validateOps = (snapshot, ops) => {
	// JsonML is plain JSON, so a JSON round-trip is an exact, dependency-free
	// clone. The clone is discarded afterwards; the real submission re-applies
	// the ops through ShareDB as usual.
	const clone = JSON.parse(JSON.stringify(snapshot || null));

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
