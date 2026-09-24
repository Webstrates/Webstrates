'use strict';

const util = require('util');
const db = require(APP_PATH + '/helpers/database.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentStore = require(APP_PATH + '/helpers/DocumentStore.js');
const diffMirrors = require(APP_PATH + '/helpers/mirrorDiff.js');

// Commit listeners (see onCommit): documentMiddleware registers a broadcaster
// so server-side commits (no-ops, permission updates, restores) reach the
// subscribers exactly like client commits do.
const commitListeners = [];

/**
 * Register a listener invoked as fn(webstrateId, handle, commitResult) after
 * every commit applied through this module (client commits are applied in
 * documentMiddleware, which does its own broadcasting).
 * @param {Function} fn Listener.
 * @public
 */
module.exports.onCommit = function(fn) {
	commitListeners.push(fn);
};

function notifyCommit(webstrateId, handle, result) {
	for (const fn of commitListeners) {
		try {
			fn(webstrateId, handle, result);
		} catch (err) {
			console.error('DocumentManager: commit listener failed:', err);
		}
	}
}

/**
 * Creates a new document and returns the id. If the document to be created is
 * not to be prototyped off of another document, we don't actually create the
 * document — we just return a new id. The document is created when first
 * visited (client bootstrap) or by the first prototype commit.
 * @param {string}   webstrateId         WebstrateId (name of new document).
 * @param {string}   options.prototypeId Name of the webstrate to base the prototype on.
 * @param {string}   options.version     Version of the prototype.
 * @param {string}   options.tag         Tag of the prototype. Either tag or version.
 * @param {Snapshot} options.snapshot    JsonML snapshot to create from (the REST
 *                                       ingest paths: zip import, remote prototype).
 * @return {string}                      (async) Name of new webstrate.
 * @public
 */
module.exports.createNewDocument = async function({ webstrateId, prototypeId, version, tag,
	snapshot }) {
	// The REST ingest paths still hand a freshly parsed JsonML snapshot; it
	// becomes the initial commit as before (see fromJsonML).
	if (snapshot) {
		if (!snapshot.type) throw new Error('Snapshot has no type.');
		const handle = documentStore.getHandle(webstrateId);
		try {
			if (handle.revision > 0) throw new Error('Webstrate already exists.');
			const createdVersion = handle.fromJsonML(snapshot.data, 'server', 'prototype');
			if (snapshot.label || snapshot.tag) {
				await module.exports.tagDocument(webstrateId, createdVersion,
					snapshot.label || snapshot.tag);
			}
			return webstrateId;
		} finally {
			documentStore.releaseHandle(webstrateId);
		}
	}

	if (!prototypeId) return webstrateId;

	// If the document already exists and is empty, we just delete it, so
	// unused documents won't take up webstrate names.
	const existing = documentStore.getHandle(webstrateId);
	let empty = false;
	try {
		empty = existing.revision > 0 && isMirrorEmpty(existing);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
	if (empty) await module.exports.deleteDocument(webstrateId);

	// Copy the prototype's mirror at the resolved revision — eid model to
	// eid model, no JsonML in between.
	const protoHandle = documentStore.getHandle(prototypeId);
	try {
		let protoV = protoHandle.revision;
		let tagLabel;
		if (tag) {
			const tagRow = protoHandle.getTag(tag);
			if (!tagRow) throw new Error(`Requested tag ${tag} does not exist.`);
			protoV = tagRow.v;
			tagLabel = tag;
		} else if (version !== undefined && version !== '' && version !== 'head') {
			protoV = Number(version);
			if (!Number.isInteger(protoV) || protoV < 0) {
				throw new Error('Version must be a number or \'head\'');
			}
		}
		const handle = documentStore.getHandle(webstrateId);
		try {
			handle.copyFrom(protoHandle, protoV, 'server', 'prototype');
			if (tagLabel) {
				await module.exports.tagDocument(webstrateId, handle.revision, tagLabel);
			}
		} finally {
			documentStore.releaseHandle(webstrateId);
		}
	} finally {
		documentStore.releaseHandle(prototypeId);
	}
	return webstrateId;
};

/**
 * Checks whether a document's mirror is "empty": nothing but the html shell
 * with a head (holding at most a title) and a body, carrying no content and
 * no attributes. When in doubt, err towards "not empty" (an "empty" verdict
 * allows the document to be deleted to free its webstrate name).
 * @param  {Handle}  handle DocumentStore handle.
 * @return {Boolean}        Whether the mirror is empty.
 * @private
 */
function isMirrorEmpty(handle) {
	const nodes = handle.nodes;
	const root = nodes.get(0);
	const htmlEid = root && root.kids[0];
	if (htmlEid === undefined) return true;
	const html = nodes.get(htmlEid);
	if (!html || html.t !== 1) return true; // NODE_ELEMENT
	if (html.attrs.length > 0) return false; // any html attribute is content

	let head = null, body = null;
	// Whitespace-only text between the shell elements is not content
	// (the JsonML variant stripped it before deciding).
	const isWhitespaceText = (eid) => {
		const node = nodes.get(eid);
		return node && node.t === 3 && node.attrs[0] && node.attrs[0].v.trim() === '';
	};

	for (const kid of html.kids) {
		if (isWhitespaceText(kid)) continue;
		const node = nodes.get(kid);
		if (!node || node.t !== 1) return false; // text/comment/… at html level
		const name = String(node.n).toLowerCase();
		if (name === 'head' && !head) head = node;
		else if (name === 'body' && !body) body = node;
		else return false;
	}

	if (body) {
		for (const kid of body.kids) {
			if (!isWhitespaceText(kid)) return false; // any body content
		}
	}
	if (!head) return true;
	if (head.attrs.length > 0) return false;
	// An empty head, or one holding nothing but a single title, is still
	// "empty" (the JsonML variant's verdict; the title's own content does
	// not count).
	const headContent = head.kids.filter((kid) => !isWhitespaceText(kid));
	if (headContent.length === 0) return true;
	if (headContent.length > 1) return false;
	const only = nodes.get(headContent[0]);
	return !!only && only.t === 1 && String(only.n).toLowerCase() === 'title';
}

/**
 * Retrieve a document's lightweight header — everything the HTTP, asset and
 * permission paths need, read straight off the mirror with no serialization:
 * the revision (version- or tag-resolved, like the old snapshot API),
 * existence (v > 0), and the html element's data-auth permissions and
 * data-cors strings.
 * @param  {string} options.webstrateId WebstrateId.
 * @param  {string} options.version      Desired document version (or 'head').
 * @param  {string} options.tag          Desired document tag.
 * @return {Header}                      {id, v, exists, dataAuth, dataCors,
 *                                        tag?}.
 * @public
 */
module.exports.getDocumentHeader = async function({ webstrateId, version, tag }) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		let v = handle.revision;
		let tagLabel;
		if (tag) {
			const tagRow = handle.getTag(tag);
			if (!tagRow) throw new Error(`Requested tag ${tag} does not exist.`);
			v = tagRow.v;
			tagLabel = tag;
		} else if (version !== undefined && version !== '' && version !== 'head') {
			// Versions may arrive as numeric strings from clients that don't coerce.
			if (typeof version === 'string' && /^\d+$/.test(version)) version = Number(version);
			if (typeof version !== 'number' || Number.isNaN(version)) {
				throw new Error('Version must be a number or \'head\'');
			}
			v = version;
		}
		if (v > handle.revision) {
			throw new Error(`Version ${v} does not exist (newest is ${handle.revision}).`);
		}
		const header = { id: webstrateId, v, exists: v > 0,
			dataAuth: null, dataCors: null };
		if (tagLabel !== undefined) header.tag = tagLabel;
		if (header.exists) {
			const nodes = v === handle.revision ? handle.nodes : handle.snapshotAt(v);
			const root = nodes.get(0);
			const htmlEid = root && root.kids[0];
			const htmlNode = nodes.get(htmlEid);
			// The html-level attributes (data-auth, data-cors) belong to an
			// <html> root: a document rooted in any other element (legacy /
			// REST-created) must not grant permissions or CORS through them —
			// the old snapshot readers checked data[0] === 'html' the same way.
			if (htmlNode && htmlNode.t === 1 && htmlNode.n === 'html') {
				const authAttr = htmlNode.attrs.find((a) => a.n === 'data-auth');
				header.dataAuth = authAttr ? authAttr.v : null;
				const corsAttr = htmlNode.attrs.find((a) => a.n === 'data-cors');
				header.dataCors = corsAttr ? corsAttr.v : null;
			}
		}
		return header;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Checks whether a document exists (has committed content).
 * @param  {string} webstrateId WebstrateId.
 * @return {bool}               Whether the document exists.
 * @public
 */
module.exports.documentExists = async function(webstrateId) {
	return documentStore.exists(webstrateId);
};

/**
 * Set (or remove) an attribute on the document's html element as one
 * server-side commit — the permission-update path's data-auth writes. Like
 * every server-side commit it notifies the onCommit listeners (which
 * broadcast it to the subscribers).
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   name        Attribute name.
 * @param  {string?}  value       New value (null/undefined removes the attribute).
 * @param  {string}   source      Source of the operation.
 * @param  {Function} next        Callback (optional).
 * @public
 */
module.exports.setHtmlAttribute = function(webstrateId, name, value, source, next) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		const root = handle.nodes.get(0);
		const htmlEid = root && root.kids[0];
		if (!htmlEid) {
			throw new Error('Cannot submit op to an empty document.');
		}
		const htmlNode = handle.nodes.get(htmlEid);
		const existingPos = htmlNode.attrs.findIndex((a) => a.n === name);
		const ops = [];
		const removing = value === null || value === undefined;
		if (removing) {
			// Deleting a nonexistent attribute is a no-op commit, but we still
			// commit so the version bump semantics match the old system.
			if (existingPos !== -1) {
				ops.push({ k: 'ar', e: htmlEid, n: name });
			}
		} else {
			// An existing name is replaced in place (remove, then re-insert at
			// its own position); a new one appends.
			if (existingPos !== -1) {
				ops.push({ k: 'ar', e: htmlEid, n: name });
			}
			const i = existingPos !== -1 ? existingPos : htmlNode.attrs.length;
			ops.push({ k: 'aa', e: htmlEid, i, n: name, v: String(value) });
		}
		const result = handle.applyCommit({ base: handle.revision, ops,
			userId: 'server', source });
		notifyCommit(webstrateId, handle, result);
		next && next(null, result);
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Apply a paint-normalization commit: ops the server derived by re-parsing
 * its own rendered paint with the spec HTML parsing algorithm (parse5) —
 * the changes the browser would have made to an unparseable shape, committed
 * as the document's own ops for that revision so every served paint
 * re-parses to exactly the mirror (moves keep element ids; parser-synthesized
 * nodes are minted fresh).
 * @param  {string} webstrateId WebstrateId.
 * @param  {Handle} handle      Open handle (caller keeps the reference).
 * @param  {[op]}   ops         Forward ops.
 * @return {object}             Commit result ({v, firstOpid, ops, xformed}).
 * @public
 */
module.exports.submitPaintNormalization = function(webstrateId, handle, ops) {
	const result = handle.applyCommit({ base: handle.revision, ops,
		userId: 'server', source: 'documentNormalize' });
	notifyCommit(webstrateId, handle, result);
	return result;
};

/**
 * Submit a no-op commit to a document — bumps the version, which happens when
 * we add an asset to avoid file name conflicts, or when restoring.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   reason     Reason for the no-op (e.g. "assetAdded").
 * @param  {string}   source     Source of the operation.
 * @param  {Function} next       Callback (optional).
 * @public
 */
module.exports.sendNoOp = function(webstrateId, reason, source, next) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		if (handle.revision === 0) {
			throw new Error(`Webstrate ${webstrateId} does not exist.`);
		}
		const result = handle.applyCommit({ base: handle.revision, ops: [],
			userId: 'server', source: source || reason });
		notifyCommit(webstrateId, handle, result);
		next && next(null, result);
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Restores a document to a specific version or tag: diff the current head
 * against the target snapshot and commit the difference (ops reuse the
 * target's ids, so restored content keeps its element ids).
 * @param  {string} options.webstrateId WebstrateId.
 * @param  {string} options.version     Desired document version.
 * @param  {string} options.tag         Desired document tag.
 * @return {int}                        (async) Version of the restored state.
 * @public
 */
module.exports.restoreDocument = async function({ webstrateId, version, tag }, source) {
	// Resolve the target revision (the tag's label survives into the restore
	// tag) — a header read, no serialization.
	const header = await module.exports.getDocumentHeader({ webstrateId, version, tag });
	const label = header.tag; // old system read .label (always undefined); we use the tag

	// A no-op first marks the restore in the op log and bumps the version to
	// avoid asset name conflicts (as the old system did).
	await util.promisify(module.exports.sendNoOp)(webstrateId, 'documentRestore', source);

	const handle = documentStore.getHandle(webstrateId);
	try {
		const ops = diffMirrors(handle, handle.snapshotAt(header.v));
		if (ops.length > 0) {
			// The restore's sa fix-ups must not re-attach stashed (removed)
			// subtrees: the stash holds the removal-time shape of nodes —
			// children replaced or re-keyed since then — which need not match
			// the target. With the stash swapped out, every fix-up creates its
			// node fresh from the target state (the ops still carry the
			// target's element ids), and the in-commit sr+sa moves pair up
			// through the temporary stash like any other move.
			const stash = handle.detached;
			handle.detached = new Map();
			let result;
			try {
				// The source is prefixed so the commit (and its broadcast)
				// can be recognized as a restore diff: subscribers converge
				// on such frames with a full rebuild instead of replaying
				// thousands of interleaved move/removal/re-attach ops
				// through the incremental path.
				result = handle.applyCommit({ base: handle.revision, ops,
					userId: 'server', source: `documentRestore ${source}` });
			} finally {
				handle.detached = stash;
			}
			notifyCommit(webstrateId, handle, result);
		}
		const newVersion = handle.revision;
		return await module.exports.tagDocument(webstrateId, newVersion,
			`${label} (restored at ${new Date()})`);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Delete a document: broadcast, drop the SQLite files and caches. If
 * nothing was ever committed, the (empty) databases are cleaned up and an
 * error is thrown — the old system's "No webstrate to delete".
 * @param  {string} webstrateId WebstrateId.
 * @public
 */
module.exports.deleteDocument = async function(webstrateId) {
	let hadContent = false;
	const handle = documentStore.getHandle(webstrateId);
	try {
		hadContent = handle.revision > 0;
		handle.destroy(); // also removes the handle from the store's map
	} finally {
		documentStore.releaseHandle(webstrateId);
	}

	if (!hadContent) throw new Error('No webstrate to delete');

	clientManager.sendToClients(webstrateId, {
		wa: 'delete',
		d: webstrateId
	});
};

/**
 * Retrieves the current version (revision) of the document.
 * @param  {string} webstrateId WebstrateId.
 * @return {int}                (async) Document version.
 * @public
 */
module.exports.getDocumentVersion = async function(webstrateId) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		if (handle.revision === 0) {
			throw new Error(`Webstrate ${webstrateId} does not exist.`);
		}
		return handle.revision;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Get a document's structure — the eid-native rows the client rebuilds from
 * (fetchdoc replies with them as JSON, fetchStructure as a brotli binary
 * frame). `struct` rows are [parentEid, index, eid, type, name] in document
 * order; `state` rows are [eid, attrIndex, attrName, attrValue] where a null
 * name marks the node's content row. Version resolution matches
 * getDocumentHeader (tag wins over version; head when neither is given).
 * @param {string} options.webstrateId WebstrateId.
 * @param {mixed}  options.version     Requested version (number or 'head').
 * @param {string} options.tag          Requested tag.
 * @return {object}                    (async) {v, struct, state}.
 * @public
 */
module.exports.getStructure = async function({ webstrateId, version, tag }) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		let v = handle.revision;
		if (tag !== undefined && tag !== null && tag !== '') {
			const tagRow = handle.getTag(tag);
			if (!tagRow) throw new Error(`Requested tag ${tag} does not exist.`);
			v = tagRow.v;
		} else if (version !== undefined && version !== '' && version !== 'head') {
			const requested = Number(version);
			if (!Number.isInteger(requested) || requested < 0) {
				throw new Error('Invalid version.');
			}
			v = requested;
		}
		if (v > handle.revision) {
			throw new Error(`Version ${v} does not exist (newest is ${handle.revision}).`);
		}

		const nodes = v === handle.revision ? handle.nodes : handle.snapshotAt(v);
		const struct = [];
		const state = [];
		const walk = (p) => {
			const node = nodes.get(p);
			if (!node) return;
			node.kids.forEach((e, i) => {
				const child = nodes.get(e);
				struct.push([p, i, e, child.t, child.n]);
				// state rows come out in the mirror's attribute order — a
				// rebuilt DOM's attribute list matches these positions.
				child.attrs.forEach((attr, ai) => {
					state.push([e, ai, attr.n, attr.v]);
				});
				walk(e);
			});
		};
		walk(0);
		return { v, struct, state };
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Retrieves the version a tag points at.
 * @param  {string} webstrateId WebstrateId.
 * @param  {string} tag         Tag label.
 * @return {int}                (async) Document version.
 * @public
 */
module.exports.getVersionFromTag = async function(webstrateId, tag) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		const tagRow = handle.getTag(tag);
		if (!tagRow) {
			throw new Error(`Requested tag ${tag} does not exist.`);
		}
		return tagRow.v;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Get the commit log for a document (one entry per commit). Sessions from the
 * session log are attached to entries whose source matches, exactly as the
 * old ShareDB-backed getOps did.
 * @param  {string} options.webstrateId    WebstrateId.
 * @param  {number} options.initialVersion Only entries after this revision.
 * @param  {number} options.version        Only entries up to and including this revision.
 * @return {[Op]}                          (async) Commit log entries.
 * @public
 */
module.exports.getOps = async function({ webstrateId, initialVersion, version }) {
	const coerce = (value) => {
		if (value === undefined || value === null || value === '') return undefined;
		const num = Number(value);
		return Number.isInteger(num) && num >= 0 ? num : undefined;
	};
	const from = coerce(initialVersion) ?? 0;
	const to = coerce(version) ?? Infinity;

	const handle = documentStore.getHandle(webstrateId);
	let commits;
	try {
		commits = handle.allCommits().filter((entry) => entry.v > from && entry.v <= to);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}

	if (db.sessionLog && !config.disableSessionLog) {
		const sessionsInOps = new Set(commits.map((entry) => entry.src).filter(Boolean));
		if (sessionsInOps.size > 0) {
			const sessions = await db.sessionLog.find({ sessionId:
				{ $in: Array.from(sessionsInOps) } }).toArray();
			commits.forEach((entry) => {
				entry.session = sessions.find((session) => entry.src === session.sessionId);
			});
		}
	}

	return commits;
};

/**
 * Get the tag for a specific version of a webstrate, or the newest tag for
 * 'head'.
 * @param {string}   webstrateId WebstrateId.
 * @param {string}   version     Version ('head' for the newest tag).
 * @param {Function} next        Callback.
 * @public
 */
module.exports.getTag = function(webstrateId, version, next) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		if (version === undefined || version === 'head') {
			const tags = handle.getTags();
			return next && next(null, tags[tags.length - 1]);
		}
		next && next(null, handle.getTagForVersion(Number(version)));
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Get all tags for a webstrate, oldest first.
 * @param {string}   webstrateId WebstrateId.
 * @param {Function} next         Callback.
 * @public
 */
module.exports.getTags = function(webstrateId, next) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		next && next(null, handle.getTags());
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Add tag to a document (at a specific revision).
 * @param  {string} webstrateId WebstrateId.
 * @param  {string} version     Version to apply the tag to.
 * @param  {string} label       Tag label.
 * @return {int}                (async) Tagged version.
 * @public
 */
module.exports.tagDocument = async function(webstrateId, version, label) {
	if (!label || label.includes('.')) throw new Error('Tag names should not contain periods.');

	const handle = documentStore.getHandle(webstrateId);
	try {
		// Clients are told about the tag before it happens (shouldn't fail).
		clientManager.sendToClients(webstrateId, {
			wa: 'tag',
			d: webstrateId,
			v: version,
			l: label
		});

		handle.tag(label, version);
		return version;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Remove a tag from a document, either by version or by tag label.
 * @param {string}   webstrateId     WebstrateId.
 * @param {string}   options.version  Version.
 * @param {string}   options.tag      Tag label.
 * @param {Function} next             Callback (optional).
 * @public
 */
module.exports.untagDocument = function(webstrateId, { version, tag }, next) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		const existing = (version !== undefined && version !== null)
			? handle.getTagForVersion(Number(version))
			: handle.getTag(tag);
		if (existing) {
			handle.untag({ label: existing.label, opid: existing.v });
			clientManager.sendToClients(webstrateId, {
				wa: 'untag',
				d: webstrateId,
				v: existing.v,
				l: existing.label
			});
		}
		next && next();
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

module.exports._diffMirrors = diffMirrors;
