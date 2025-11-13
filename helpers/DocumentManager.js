'use strict';

const util = require('util');
const jsondiff = require('json0-ot-diff');
const ot = require('sharedb/lib/ot');
const db = require(APP_PATH + '/helpers/database.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const ShareDbWrapper = require(APP_PATH + '/helpers/ShareDBWrapper.js');

/**
 * Creates a new document and returns the id. Note that if the document to be created is not to be
 * prototyped off of another document, we don't actually create the document, we just return a new
 * id. The document will instead be created when it is first visited.
 * @param {string}   webstrateId         WebstrateId (name of new document).
 * @param {string}   options.prototypeId Name of the webstrate document to base the prototype on.
 * @param {string}   options.version     Version of the prototype to base the new document on.
 * @param {string}   options.tag         Tag of the prototype to base the new document on. Either
 *                                       a tag or version may be set, but not both.
 * @param {Snapshot} options.snapshot    Snapshot to base the prototype off. Optional, but will be
 *                                       retrieved from prototypeId and version/tag if not
 *                                       provided.
 * @param {Function} next                Callback (optional).
 * @return {string}                      (async) Name of new webstrate.
 * @public
 */
module.exports.createNewDocument = async function({ webstrateId, prototypeId, version, tag,
	snapshot }) {
	// If we're not prototyping (or creating from a snapshot), we can just return a new id. We don't
	// have to build anything.
	if (!prototypeId && !snapshot) return webstrateId;

	// The snapshot is an optional parameter, so if it's not set, let's fetch it from the database
	// and call createNewdocument again with it.
	if (!snapshot) {
		snapshot = await module.exports.getDocument({ webstrateId: prototypeId, version, tag });
		return await module.exports.createNewDocument({ webstrateId, prototypeId, version, tag, snapshot });
	}

	// If the document already exists and is empty, we just delete it, so unused documents won't take
	// up webstrate names. This would especially be annoying if somebody navigated to /<nice-name>,
	// then tried to use `webstrate.newPrototypeFromFile` in the same document.
	const existingSnapshot = await module.exports.getDocument({ webstrateId });
	if (isSnapshotEmpty(existingSnapshot.data) && existingSnapshot.v > 0) {
		await module.exports.deleteDocument(webstrateId, 'empty-document');
	}

	// Let ShareDB handle the creation of the document.
	try {
		await ShareDbWrapper.submit(webstrateId, { v: 0, create: { type: snapshot.type, data: snapshot.data } });
	} catch (err){
		if (err.message == 'Document was created remotely') throw new Error('Webstrate already exists.');
		if (err.message === 'Missing create type') throw new Error('Prototype webstrate doesn\'t exist.');
		throw err;
	}

	// Add current tag if it exists. All other tags are left behind, because the new document
	// starts from version 1.
	if (snapshot.label) await util.promisify(module.exports.tagDocument)(webstrateId, 1, snapshot.label);

	return webstrateId;
};

/**
 * Checks whether a snapshot is "empty", i.e. just a shell with an (almost) empty head and body.
 * @param  {Snapshot}  snapshot ShareDB snapshot.
 * @return {Boolean}            Whether snapshot is empty or not.
 * @private
 */
function isSnapshotEmpty(snapshot) {
	if (!snapshot)
		return true;

	// Remove empty elements like '\n' from the root of the document.
	snapshot = snapshot.filter(o => !(typeof o === 'string' && o.trim() === ''));

	if (snapshot[2] && snapshot[2][0].toLowerCase() !== 'head' // head tag exists
		&& (Object.keys(snapshot[2][1]).length > 1))  // has no attributes (other than wid)
		return false;

	// Remove empty elements like '\n' from the head.
	snapshot[2] = snapshot[2].filter(o => !(typeof o === 'string' && o.trim() === ''));
	return (!snapshot[2][2] // has an empty head
				|| (Array.isArray(snapshot[2][2]) // or has a head
					&& snapshot[2][2][0].toLowerCase() === 'title')) // that element being a title tag
		&& snapshot[3] && snapshot[3][0].toLowerCase() === 'body' // body tag exists
		&& (Object.keys(snapshot[3][1]).length <= 1) // has no attributes (other than wid)
		&& snapshot[3].slice(2).join('').trim() === ''; // and an empty body
}
/**
 * Retrieve a document snapshot from the database.
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {string}   options.version     Desired document version (tag or version is required).
 * @param  {string}   options.tag         Desired document tag. (tag or version is required)
 * @return {Snapshot}                     (async) Document snapshot.
 * @public
 */
module.exports.getDocument = async function({ webstrateId, version, tag }) {
	if (tag) return await util.promisify(getDocumentFromTag)(webstrateId, tag);

	if (version === undefined || version === '' || version === 'head') {
		let res = await util.promisify(ShareDbWrapper.fetch)(webstrateId);
		return res;
	}
	if (Number.isNaN(version)) throw new Error('Version must be a number or \'head\'');
	let snapshot = await util.promisify(getTagBeforeVersion)(webstrateId, version);
	return await transformDocumentToVersion({ webstrateId, snapshot, version });
};

/**
 * Checks whether a document exists. This is faster than retriving the full document.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Function} next        Callback.
 * @return {bool}                 Whether docuemnt exists.
 * @public
 */
module.exports.documentExists = async function(webstrateId) {
	return await db.webstrates.findOne({ _id: webstrateId }, { _id: 1 });
};

/**
 * Submit raw op to a document.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Op}       op          Op to be sent.
 * @param  {Function} next        Callback (optional).
 * @private
 */
function submitRawOp (webstrateId, op, next) {
	ShareDbWrapper.submitOp(webstrateId, op,
		err => next && next(err ? new Error(err.message) : undefined));
}

/**
 * Submit no-op to a document. Useful when we want to bump the version of a document, which
 * happens when we add an asset to avoid file name conflicts.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   reason      Reason for the no-op (something like "assetAdded").
 * @param  {string}   source      Source of the operation (clientId usually).
 * @param  {Function} next        Callback (optional).
 * @public
 */
module.exports.sendNoOp = function(webstrateId, reason, source, next) {
	submitRawOp(webstrateId, {
		noop: reason,
		src: source
	}, next);
};

/**
 * Submit op to a document.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Op}       op          Op to be applied.
 * @param  {string}   source      Source of the operation (clientId usually).
 * @param  {Function} next        Callback (optional).
 * @public
 */
module.exports.submitOp = function(webstrateId, op, source, next) {
	submitRawOp(webstrateId, {
		op: [op],
		src: source
	}, next);
};

/**
 * Recursively submits ops to a document.
 * @param  {string} webstrateId WebstrateId.
 * @param  {Ops}     ops        Ops to be applied.
 * @param  {Function} next      Callback (optional).
 */
module.exports.submitOps = function(webstrateId, ops, source, next) {
	var op = ops.shift();

	if (!op) {
		return next && next();
	}

	module.exports.submitOp(webstrateId, op, source, function() {
		module.exports.submitOps(webstrateId, ops, source, next);
	});
};

/**
 * Restores a document to a specific version, either by providing a version directly or by
 * providing a tag label associated with the version.
 * @param  {string} options.webstrateId WebstrateId.
 * @param  {string} options.version     Desired document version (tag or version is required).
 * @param  {string} options.tag         Desired document tag. (tag or version is required)
 * @public
 */
module.exports.restoreDocument = async function({ webstrateId, version, tag }, source) {
	let oldVersion = await module.exports.getDocument({ webstrateId, version, tag });
	var tag = oldVersion.label;

	// Send a no-op so we can see when the document was restored, but also to make sure the
	// restore command bumps the document version by at least one to avoid asset name conflicts.
	await util.promisify(module.exports.sendNoOp)(webstrateId, 'documentRestore', source);
	
	let currentVersion = await module.exports.getDocument({ webstrateId, version: 'head' })
	var ops = jsondiff(currentVersion.data, oldVersion.data);
	if (ops.length === 0) {
		return await module.exports.tagDocument(webstrateId, currentVersion.v, tag + ' (restored at '+new Date()+')');
	} else {
		await util.promisify(module.exports.submitOps)(webstrateId, ops, source);
		var newVersion = currentVersion.v + ops.length + 1;
		return await module.exports.tagDocument(webstrateId, newVersion, tag + ' (restored at '+new Date()+')');
	}
};

/**
 * Delete a document.
 * @param  {string}   webstrateId WebstrateId.
 * @public
 */
module.exports.deleteDocument = async function(webstrateId) {
	// When creating a webstrate and then quickly deleting it aftewards, the document may not
	// have made its way into the database when we try to delete it. If this happens, we wait
	// a little and then try again a couple of times.
	let attempts = 0;
	let res;
	do {
		attempts++;
		if (attempts > 1) await new Promise((accept,reject)=>{setTimeout(()=>{accept()},100)});
		if (attempts > 5) throw new Error('No webstrate to delete');
		res = await db.webstrates.deleteOne({ _id: webstrateId })
	} while (res.deletedCount === 0)

	clientManager.sendToClients(webstrateId, {
		wa: 'delete',
		d: webstrateId
	});

	await db.tags.deleteMany({ webstrateId });
	await db.ops.deleteMany({ d: webstrateId });
};

/**
 * Retrieves the current version of the document.
 * @param  {string}   webstrateId WebstrateId.
 * @return {int}                  (async) Document version.
 */
module.exports.getDocumentVersion = async function(webstrateId) {
	let doc = await db.webstrates.findOne({ _id: webstrateId }, { _v: 1});
	try {
		return Number(doc._v);
	} catch (err){
		console.log("Error in getDocumentVersion:", e, doc, err);
		throw err;
	}
};

/**
 * Retrieves the current version of the document.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   tag tag.
 * @return {int}                  (async) Document version.
 */
module.exports.getVersionFromTag = async function(webstrateId, tag, next) {
	let doc = await db.tags.findOne({ webstrateId, label: tag }, { _id: 0, v: 1 });
	return Number(doc.v);
};

/**
 * Get operations for a document.
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {string}   options.version     Document version.
 * @return {Ops}                          (async) Operations.
 * @public
 */
module.exports.getOps = async function({ webstrateId, initialVersion, version }) {
	// If no version is defined, all operations will be retrieved.
	let ops = await util.promisify(ShareDbWrapper.getOps)(webstrateId, initialVersion, version);	

	// If we have access to a session log, and it is not disabled, we attach session 
	// entries to operations before returning them.
	if (db.sessionLog && !config.disableSessionLog){
		var sessionsInOps = new Set();
		ops.forEach(function(op) {
			sessionsInOps.add(op.src);
		});
	
		let sessions = await db.sessionLog.find({'sessionId': { $in: Array.from(sessionsInOps) }}).toArray();
		ops.forEach(op =>{
			op.session = sessions.find(session => op.src === session.sessionId);
		});
	}

	return ops;
};

/**
 * Get tag label for a specific version of a webstrate.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   version     Version.
 * @param  {Function} next        Callback (optional).
 * @public
 */
module.exports.getTag = function(webstrateId, version, next) {
	if (version === undefined || version === 'head') {
		db.tags.find({ webstrateId }, { data: 0, type: 0 }).sort({ v: -1 }).limit(1).toArray().then(tags=>{
			return next && next(null, tags[0]);
		}).catch(err=>{
			return next && next(err);
		});
	}
	db.tags.findOne({ webstrateId, v: version }, { data: 0, type: 0 }).then((tag)=>next(null,tag)).catch(err=>{
		return next && next(err);
	});
};

/**
 * Get all tags for a webstrate.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Function} next        Callback (optional).
 * @public
 */
module.exports.getTags = function(webstrateId, next) {
	db.tags.find({ webstrateId }, { webstrateId: 0, data: 0, type: 0 })
		.sort({ v: 1 }).toArray().then(tags => {
			tags.forEach(tag => {
				tag.timestamp = tag._id.getTimestamp();
				delete tag._id;
			});
			next(null, tags);
		}).catch(err=>{
		    next && next(err);
		});
};

/**
 * Add tag to a document.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   version     Version to apply tag to.
 * @param  {string}   label       Tag label.
 * @public
 */
module.exports.tagDocument = async function(webstrateId, version, label) {
	if (!label || label.includes('.')) throw new Error('Tag names should not contain periods.');
	let snapshot = await module.exports.getDocument({ webstrateId, version });

	// We let clients know that the document has been tagged before it has happened, because this
	// shouldn't fail.
	clientManager.sendToClients(webstrateId, {
		wa: 'tag',
		d: webstrateId,
		v: version,
		l: label
	});

	var data = snapshot.data;
	var type = snapshot.type;
	
	try {
		// All labels and versions have to be unique, so this is how we enforce that. First, try to
		// set the label for a specific version. Due to our collection's uniqueness constraint, this
		// will fail if the label already exists.
		await db.tags.updateOne({ webstrateId, v: version }, { $set: { label, data, type } }, { upsert: true });
	} catch (err) {
		// Now we can't just update the label, because a label for the version may also exist.
		// Therefore, we delete anything with the label or version, and then insert it again.
		await db.tags.deleteMany({ webstrateId, $or: [ { label }, { v: version } ]});
		
		// And now reinsert.
		await db.tags.insertOne({ webstrateId, v: version, label, data, type });
	}

	return version;
};

/**
 * Remove tag from a document either by version or tag label.
 * @param  {string}   webstrateId     WebstrateId.
 * @param  {string}   options.version Version.
 * @param  {string}   options.tag     Tag label.
 * @param  {Function} next            Callback (optional).
 * @public
 */
module.exports.untagDocument = function(webstrateId, { version, tag }, next) {
	var query = { webstrateId };
	if (version) {
		query.v = version;
	}
	else {
		query.label = tag;
	}
	db.tags.deleteOne(query).then(res=>{
		// Only inform clients of a tag deletion if the tag existed.
		if (res.deletedCount === 1) {
			clientManager.sendToClients(webstrateId, {
				wa: 'untag',
				d: webstrateId,
				v: version,
				l: tag
			});
		}
		next && next();
	}).catch(err=>{
	    next && next(err);
	});
};

/**
 * Find potential tag for a snapshot and add it.
 * @param {Snapshot} snapshot    Document snapshot.
 * @param {string}   webstrateId WebstrateId.
 * @param {string}   version     Version.
 * @param {Function} next        Callback (optional).
 * @public
 */
module.exports.addTagToSnapshot = function(snapshot, next) {
	module.exports.getTag(snapshot.id, snapshot.v, function(err, tag) {
		if (err) return next && next(err);
		if (tag) {
			snapshot.tag = tag.label;
		}
		next && next(err, snapshot);
	});
};

/**
 * Transforms a document to a specific version.
 * @param  {string}   options.webstrateId WebstrateId.
 * @param  {string}   options.snapshot    Snapshot to be transformed from (optional).
 *                                        If not specified, we transform from version 0.
 * @param  {string}   options.version     Document version.
 * @return {Snapshot}                     (async) Document snapshot.
 * @private
 */
async function transformDocumentToVersion({ webstrateId, snapshot, version }) {
	if (!snapshot) {
		snapshot = { v: 0, id: webstrateId };
	}

	// Apply each operation to rebuild the document.
	let ops = await module.exports.getOps({ webstrateId, initialVersion: snapshot.v, version });
	ops.forEach(function(op) {
		ot.apply(snapshot, op);
	});

	// If after we've applied all updates, we haven't reached the desired version, the user must
	// be requesting a version that doesn't exist yet.
	if (version !== snapshot.v) throw new Error(`Version ${version} requested, but newest version is ${snapshot.v}.`);

	return snapshot;
}

/**
 * Get the most recent tag (including snapshot) before (or equal to) a version.
 * E.g. if the collection contains tags for versions [1, 3, 7], and version 6 is requested, the
 * tag for version 3 is returned. This way, we only have to transform from version 3 to 6, instead
 * of 0 to 6.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   version     Version.
 * @param  {Function} next        Callback (optional).
 * @return {Tag}                  (async) Tag including snapshot.
 * @private
 */
function getTagBeforeVersion(webstrateId, version, next) {
	db.tags.find({ webstrateId, v: { $lte: version } }).sort({ v : -1 }).limit(1).toArray().then(tags=>{
	    return next && next(null, tags[0]);
	}).catch(err=>{
	    return next && next(err);
	});
}

/**
 * Get document snapshot from a tag label.
 * @param  {string}   webstrateId WebstrateId.
 * @param  {string}   label       Tag label.
 * @param  {Function} next        Callback (optional).
 * @return {Snapshot}             (async) Tagged snapshot.
 * @private
 */
function getDocumentFromTag(webstrateId, label, next) {
	db.tags.findOne({ webstrateId, label }).then(snapshot=>{
		if (!snapshot) return next && next(new Error(`Requested tag ${label} does not exist.`));
		snapshot.tag = label;
		next && next(null, snapshot);
	}).catch(err=>{
		return next && next(err);
	});;
}