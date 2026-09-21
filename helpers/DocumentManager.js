'use strict';

const util = require('util');
const db = require(APP_PATH + '/helpers/database.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentStore = require(APP_PATH + '/helpers/DocumentStore.js');
const diffMirrors = require(APP_PATH + '/helpers/mirrorDiff.js');

const TYPE_JSONv0 = 'http://sharejs.org/types/JSONv0';

// Commit listeners (see onCommit): documentMiddleware registers a broadcaster
// so server-side commits (no-ops, permission updates, restores) reach the
// subscribers exactly like client commits do.
const commitListeners = [];

// Head-snapshot cache: getDocument(head) is called on every HTTP request and
// by PermissionManager, so the JsonML walk is cached per revision. The cached
// object is NEVER handed out (PermissionManager mutates snapshot.data), only
// cloned.
const headCache = new Map(); // webstrateId → {v, jsonml}

/**
 * Drop the cached head snapshot of a webstrate (call after any commit applied
 * outside this module, i.e. client commits in documentMiddleware).
 * @param {string} webstrateId WebstrateId.
 * @public
 */
module.exports.invalidateCache = function(webstrateId) {
	headCache.delete(webstrateId);
};

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
 * Build a snapshot object from a mirror, in the shape every consumer of
 * getDocument expects (ShareDB-compatible: type null = empty/missing).
 * @param  {Handle}  handle   DocumentStore handle.
 * @param  {Map}     nodes    Mirror at the wanted revision.
 * @param  {number}  v        Revision.
 * @param  {string?} tagLabel Tag label, if resolved from a tag.
 * @return {Snapshot}         {id, v, type, data, tag?}
 * @private
 */
function snapshotFrom(handle, nodes, v, tagLabel) {
	const snapshot = { id: handle.id, v, type: v > 0 ? TYPE_JSONv0 : null };
	if (v > 0) snapshot.data = handle.toJsonML(nodes);
	if (tagLabel !== undefined) snapshot.tag = tagLabel;
	return snapshot;
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
 * @param {Snapshot} options.snapshot    Snapshot to base the prototype off.
 * @return {string}                      (async) Name of new webstrate.
 * @public
 */
module.exports.createNewDocument = async function({ webstrateId, prototypeId, version, tag,
	snapshot }) {
	if (!prototypeId && !snapshot) return webstrateId;

	if (!snapshot) {
		snapshot = await module.exports.getDocument({ webstrateId: prototypeId, version, tag });
		return await module.exports.createNewDocument({ webstrateId, prototypeId, version,
			tag, snapshot });
	}

	// A prototype without a type is an empty (or nonexistent) webstrate.
	if (!snapshot.type) throw new Error('Prototype webstrate doesn\'t exist.');

	// If the document already exists and is empty, we just delete it, so
	// unused documents won't take up webstrate names.
	const existingSnapshot = await module.exports.getDocument({ webstrateId });
	if (isSnapshotEmpty(existingSnapshot.data) && existingSnapshot.v > 0) {
		await module.exports.deleteDocument(webstrateId);
	}

	const handle = documentStore.getHandle(webstrateId);
	try {
		if (handle.revision > 0) throw new Error('Webstrate already exists.');
		const createdVersion = handle.fromJsonML(snapshot.data, 'server', 'prototype');
		// Preserve the prototype's tag label, if it had one (the old system
		// tagged the new document's version 1).
		if (snapshot.label || snapshot.tag) {
			await module.exports.tagDocument(webstrateId, createdVersion,
				snapshot.label || snapshot.tag);
		}
		return webstrateId;
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Checks whether a snapshot is "empty", i.e. nothing but a shell of html,
 * head and body elements (with an optional title) that carries no content.
 * When in doubt, err towards "not empty" (an "empty" verdict allows the
 * document to be deleted to free its webstrate name).
 * @param  {Snapshot} snapshot Snapshot data (JsonML).
 * @return {Boolean}           Whether snapshot is empty or not.
 * @private
 */
function isSnapshotEmpty(snapshot) {
	if (!snapshot) return true;
	if (typeof snapshot === 'string') return snapshot.trim() === '';
	if (!Array.isArray(snapshot)) return false;

	snapshot = stripWhitespaceStrings(snapshot);
	if (snapshot.length === 0) return true;
	if (elementTag(snapshot) !== 'html') return false;
	if (elementEmpty(snapshot)) return true;
	if (!hasOnlyWidAttributes(snapshot)) return false;

	let head = null, body = null;
	for (const child of elementChildren(snapshot)) {
		if (elementTag(child) === 'head' && !head) head = child;
		else if (elementTag(child) === 'body' && !body) body = child;
		else return false;
	}

	if (body && !elementEmpty(body)) return false;
	if (!head || elementEmpty(head)) return true;

	const headChildren = elementChildren(head);
	return hasOnlyWidAttributes(head) && headChildren.length === 1
		&& elementTag(headChildren[0]) === 'title';
}

function elementEmpty(element) {
	return hasOnlyWidAttributes(element) && elementChildren(element).length === 0;
}

function hasOnlyWidAttributes(element) {
	const attributes = element[1];
	if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return true;
	return Object.keys(attributes).every(key => key === '__wid');
}

function elementTag(element) {
	if (!Array.isArray(element) || typeof element[0] !== 'string') return null;
	return element[0].toLowerCase();
}

function elementChildren(element) {
	const maybeAttributes = element[1];
	const childrenStart = (maybeAttributes && typeof maybeAttributes === 'object'
		&& !Array.isArray(maybeAttributes)) ? 2 : 1;
	return element.slice(childrenStart);
}

function stripWhitespaceStrings(node) {
	if (!Array.isArray(node)) return node;
	return node
		.map(child => stripWhitespaceStrings(child))
		.filter(child => !(typeof child === 'string' && child.trim() === ''));
}

/**
 * Retrieve a document snapshot. Versions are revisions (the commit opids the
 * history un-winds from); a tag resolves to the revision it was set at. The
 * snapshot's data is JsonML in the canonical escaped form, type is
 * 'http://sharejs.org/types/JSONv0' (null when the document is empty).
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {string}   options.version     Desired document version (or 'head').
 * @param  {string}   options.tag         Desired document tag.
 * @return {Snapshot}                     (async) Document snapshot.
 * @public
 */
module.exports.getDocument = async function({ webstrateId, version, tag }) {
	if (tag) {
		const handle = documentStore.getHandle(webstrateId);
		try {
			const tagRow = handle.getTag(tag);
			if (!tagRow) throw new Error(`Requested tag ${tag} does not exist.`);
			return snapshotFrom(handle, handle.snapshotAt(tagRow.v), tagRow.v, tag);
		} finally {
			documentStore.releaseHandle(webstrateId);
		}
	}

	if (version === undefined || version === '' || version === 'head') {
		const handle = documentStore.getHandle(webstrateId);
		try {
			const cached = headCache.get(webstrateId);
			if (cached && cached.v === handle.revision) {
				return { id: webstrateId, v: handle.revision,
					type: handle.revision > 0 ? TYPE_JSONv0 : null,
					data: structuredClone(cached.jsonml) };
			}
			const snapshot = snapshotFrom(handle, handle.nodes, handle.revision);
			if (handle.revision > 0) {
				if (headCache.size > 1024) headCache.clear();
				headCache.set(webstrateId, { v: handle.revision,
					jsonml: structuredClone(snapshot.data) });
			}
			return snapshot;
		} finally {
			documentStore.releaseHandle(webstrateId);
		}
	}

	// Versions may arrive as numeric strings from clients that don't coerce.
	if (typeof version === 'string' && /^\d+$/.test(version)) version = Number(version);
	if (typeof version !== 'number' || Number.isNaN(version)) {
		throw new Error('Version must be a number or \'head\'');
	}

	const handle = documentStore.getHandle(webstrateId);
	try {
		return snapshotFrom(handle, handle.snapshotAt(version), version);
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
 * Apply ops to a document as one commit, from the server side (used by
 * restore and the permission-update path). Like the old ShareDB submitOp, the
 * op shape is the legacy json0 form limited to root-element attribute paths
 * (p: [1, name]) — PermissionManager's data-auth updates.
 * @param  {string} webstrateId WebstrateId.
 * @param  {Op}     op          Legacy json0 op ({p: [1, name], od?, oi?}).
 * @param  {string} source      Source of the operation.
 * @param  {Function} next      Callback (optional).
 * @public
 */
module.exports.submitOp = function(webstrateId, op, source, next) {
	if (!op || !Array.isArray(op.p) || op.p.length !== 2 || op.p[0] !== 1
		|| typeof op.p[1] !== 'string') {
		const err = new Error('Only root-element attribute ops are supported '
			+ 'server-side.');
		return next && next(err);
	}
	const attrName = op.p[1];
	const handle = documentStore.getHandle(webstrateId);
	try {
		const root = handle.nodes.get(0);
		const htmlEid = root && root.kids[0];
		if (!htmlEid) {
			throw new Error('Cannot submit op to an empty document.');
		}
		const ops = [];
		const htmlNode = handle.nodes.get(htmlEid);
		const existingPos = htmlNode.attrs.findIndex((a) => a.n === attrName);
		if (op.od !== undefined && existingPos !== -1) {
			ops.push({ k: 'ar', e: htmlEid, n: attrName });
		}
		if (op.oi !== undefined) {
			// An existing name updates in place; a new one appends.
			const i = existingPos !== -1 ? existingPos : htmlNode.attrs.length;
			ops.push({ k: 'aa', e: htmlEid, i, n: attrName, v: String(op.oi) });
		}
		if (ops.length === 0) {
			// Deleting a nonexistent attribute is a no-op, but we still commit
			// so the version bump semantics match the old system.
		}
		const result = handle.applyCommit({ base: handle.revision, ops,
			userId: 'server', source });
		headCache.delete(webstrateId);
		notifyCommit(webstrateId, handle, result);
		next && next(null, result);
	} catch (err) {
		next && next(err);
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};

/**
 * Recursively submits ops to a document (each as its own commit).
 * @param {string}   webstrateId WebstrateId.
 * @param {Ops}      ops         Ops to be applied.
 * @param {string}   source      Source.
 * @param {Function} next       Callback (optional).
 * @public
 */
module.exports.submitOps = function(webstrateId, ops, source, next) {
	const op = ops.shift();
	if (!op) return next && next();
	module.exports.submitOp(webstrateId, op, source, function(err) {
		if (err) return next && next(err);
		module.exports.submitOps(webstrateId, ops, source, next);
	});
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
	headCache.delete(webstrateId);
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
		headCache.delete(webstrateId);
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
	const oldVersion = await module.exports.getDocument({ webstrateId, version, tag });
	const label = oldVersion.tag; // old system read .label (always undefined); we use the tag

	// A no-op first marks the restore in the op log and bumps the version to
	// avoid asset name conflicts (as the old system did).
	await util.promisify(module.exports.sendNoOp)(webstrateId, 'documentRestore', source);

	const handle = documentStore.getHandle(webstrateId);
	try {
		const ops = diffMirrors(handle, handle.snapshotAt(oldVersion.v));
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
			headCache.delete(webstrateId);
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
	headCache.delete(webstrateId);

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
