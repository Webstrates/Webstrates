"use strict";

var jsondiff = require("json0-ot-diff");
var ot = require('sharedb/lib/ot');
var sharedb = require('sharedb');
var mongodb = require('mongodb');
var shortId = require('shortid');

/**
 * DocumentManager constructor.
 * @constructor
 * @param {ClientManager} clientmanager ClientManager instace.
 * @param {ShareDBInstance} share       ShareDB instance.
 * @param {ShareDBAgent}    agent       ShareDB agent.
 * @param {MongoDb} db                  MongoDb instance for session log and webstrate tags.
 */
module.exports = function(clientManager, share, agent, db) {
	var module = {};

	/**
	 * Creates a new document and returns the id. Note that if the document to be created is not to be
	 * prototyped off of another document, we don't actually create the document, we just return a new
	 * id. The document will instead be created when it is first visited.
	 * @param {string}   options.webstrateId WebstrateId (name of new document).
	 * @param {string}   options.prototypeId Name of the webstrate document to base the prototype on.
	 * @param {string}   options.version     Version of the prototype to base the new document on.
	 * @param {Function} next                Callback (optional).
	 * @return {string}                       (async) Name of new webstrate.
	 * @public
	 */
	module.createNewDocument = function({ webstrateId, prototypeId, version }, next) {
		if (!webstrateId) {
			webstrateId = shortId.generate();
		}

		// If we're not prototyping, we can just return a new id. We don't have to build anything.
		if (!prototypeId) {
			return next && next(null, webstrateId);
		}

		module.getDocument({ webstrateId: prototypeId, version }, function(err, snapshot) {
			if (err) return next && next(err);

			share.submit(agent, 'webstrates', webstrateId, {
				v: 0,
				create: snapshot
			}, null, function(err) {
				if (err) {
					err = new Error(err.message === "Document created remotely" ?
						"Webstrate already exists" : err.message);
				}

				// Add current tag if it exists. All other tags are left behind, because the new document
				// starts from version 1.
				if (snapshot.label) {
					return module.tagDocument(webstrateId, 1, snapshot.label, function(err, res) {
						return next && next(err, webstrateId);
					});
				}

				return next && next(err, webstrateId);
			});
		});
	};

	/**
	 * Retrieve a document snapshot from the database.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Desired document version (tag or version is required).
	 * @param  {string}   options.tag         Desired document tag. (tag or version is required)
	 * @param  {Function} next                Callback (optional).
	 * @return {Snapshot}                     (async) Document snapshot.
	 * @public
	 */
	module.getDocument = function({ webstrateId, version, tag }, next) {
		if (tag) {
			return getDocumentFromTag(webstrateId, tag, next);
		}

		if (version === undefined || version === "" || version === "head") {
			return share.fetch(agent, 'webstrates', webstrateId, next);
		}

		if (Number.isNaN(version)) {
			return next && next(new Error("Version must be a number or 'head'"));
		}

		getTagBeforeVersion(webstrateId, version, function(err, snapshot) {
			if (err) return next && next(err);
			transformDocumentToVersion({ webstrateId, snapshot, version }, next);
		});
	};

	/**
	 * Submit op to a document.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {Op}     op          Op to be applied.
	 * @param  {Function} next      Callback (optional).
	 * @public
	 */
	module.submitOp = function(webstrateId, op, source, next) {
		var request = new sharedb.SubmitRequest(share, agent, 'webstrates', webstrateId, {
			op: [op],
			src: source
		});
		request.submit(function(err) {
			if (err) return next && next(new Error(err.message));
			next && next();
		});
	};

	/**
	 * Recursively submits ops to a document.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {Ops}     ops        Ops to be applied.
	 * @param  {Function} next      Callback (optional).
	 */
	module.submitOps = function(webstrateId, ops, source, next) {
		var op = ops.shift();

		if (!op) {
			return next && next();
		}

		module.submitOp(webstrateId, op, source, function() {
			module.submitOps(webstrateId, ops, source, next);
		});
	};

	/**
	 * Restores a document to a specific version, either by providing a version directly or by
	 * providing a tag label associated with the version.
	 * @param  {string} options.webstrateId WebstrateId.
	 * @param  {string} options.version     Desired document version (tag or version is required).
	 * @param  {string} options.tag         Desired document tag. (tag or version is required)
	 * @param  {Function} next)             Callback (optional).
	 * @public
	 */
	module.restoreDocument = function({ webstrateId, version, tag }, source, next) {
		module.getDocument({ webstrateId, version, tag }, function(err, oldVersion) {
			var tag = oldVersion.label;
			if (err) return next && next(err);
			module.getDocument({ webstrateId, version: "head" }, function(err, currentVersion) {
				if (err) return next && next(err);
				var ops = jsondiff(currentVersion.data, oldVersion.data);
				if (ops.length === 0) {
					return module.tagDocument(webstrateId, currentVersion.v, tag + " (restored)", next);
				}
				module.submitOps(webstrateId, ops, source, function(err) {
					if (err) return next && next(err);
					var newVersion = currentVersion.v + ops.length + 1;
					module.tagDocument(webstrateId, newVersion, tag + " (restored)", next);
				});
			});
		});
	};

	/**
	 * Delete a diocument.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback (optional).
	 * @public
	 */
	module.deleteDocument = function(webstrateId, source, next) {
		var request = new sharedb.SubmitRequest(share, agent, 'webstrates', webstrateId, {
			del: true,
			src: source
		});
		request.submit(function(err) {
			if (err) return next && next(new Error(err.message));
			next && next();
		});
	};

	/**
	 * Get operations for a document.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Document version.
	 * @param  {Function} next                Callback (optional).
	 * @return {Ops}                          (async) Operations.
	 * @public
	 */
	module.getOps = function({ webstrateId, initialVersion, version }, next) {
		// If no version is defined, all operations will be retrieved.
		share.getOps(agent, 'webstrates', webstrateId, initialVersion, version, function(err, ops) {
			if (err) return next && next(err);

			if (!db.sessionLog) {
				return next && next(null, ops);
			}

			// If we have access to a session log, we attach session entries to operations before
			// returning them.
			var sessionsInOps = new Set();
			ops.forEach(function(op) {
				sessionsInOps.add(op.src);
			});

			db.sessionLog.find({
				"sessionId": { $in: Array.from(sessionsInOps) }
			}).toArray(function(err, sessions) {
				if (err) return next && next(err);

				ops.forEach(function(op) {
					op.session = sessions.find(function(session) {
						return op.src === session.sessionId;
					});
				});

				next && next(null, ops);
			});
		});
	};

	/**
	 * Get tag label for a specific version of a webstrate.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {string}   version     Version.
	 * @param  {Function} next        Callback (optional).
	 * @public
	 */
	module.getTag = function(webstrateId, version, next) {
		if (version === undefined || version === "head") {
			return db.tags.find({ webstrateId }, { data: 0, type: 0 }).sort({ v: -1 }).limit(1).toArray(
			function(err, tags) {
				if (err) return next && next(err);
				return next && next(null, tags[0]);
			});
		}
		db.tags.findOne({ webstrateId, v: version }, { data: 0, type: 0 }, next);
	};

	/**
	 * Get all tags for a webstrate.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback (optional).
	 * @public
	 */
	module.getTags = function(webstrateId, next) {
		db.tags.find({ webstrateId }, { webstrateId: 0, _id: 0, data: 0, type: 0 })
			.sort({ v: 1 }).toArray(next);
	};

	/**
	 * Add tag to a document.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {string}   version     Version to apply tag to.
	 * @param  {string}   label       Tag label.
	 * @param  {Function} next        Callback (optional).
	 * @public
	 */
	module.tagDocument = function(webstrateId, version, label, next) {
		module.getDocument({ webstrateId, version }, function(err, snapshot) {
			if (err) return next && next(err);
			// We let clients know that the document has been tagged before it has happened, because this
			// shouldn't fail.
			clientManager.sendToClients(webstrateId, {
				wa: "tag",
				d: webstrateId,
				v: version,
				l: label
			});

			var data = snapshot.data;
			var type = snapshot.type;
			// All labels and versions have to be unique, so this is how we enforce that. First, try to
			// set the label for a specific version. Due to our collection's uniqueness constraint, this
			// will fail if the label already exists.
			db.tags.update({ webstrateId, v: version }, { $set: { label, data, type } }, { upsert: true },
				function(err) {
				if (!err) {
					return next && next(null, version, label);
				}
				// Now we can't just update the label, because a label for the version may also exist.
				// Therefore, we delete anything with the label or version, and then insert it again.
				db.tags.deleteMany({ webstrateId, $or: [ { label }, { v: version } ]}, function(err) {
					if (err) return next && next(err);
					// And now reinsert.
					db.tags.insert({ webstrateId, v: version, label, data, type }, function(err) {
						if (err) return next && next(err);
						return next && next(null, version, label);
					});
				});
			});
		});
	};

	/**
	 * Remove tag from a document either by version or tag label.
	 * @param  {string}   webstrateId     WebstrateId.
	 * @param  {string}   options.version Version.
	 * @param  {string}   options.tag     Tag label.
	 * @param  {Function} next            Callback (optional).
	 * @public
	 */
	module.untagDocument = function(webstrateId, { version, tag }, next) {
		var query = { webstrateId };
		if (version) {
			query.v = version;
		}
		else {
			query.label = tag;
		}
		db.tags.remove(query, function(err, res) {
			// Only inform clients of a tag deletion if the tag existed.
			if (res.result.n === 1) {
				clientManager.sendToClients(webstrateId, {
					wa: "untag",
					d: webstrateId,
					v: version,
					l: tag
				});
			}
			next && next();
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
	module.addTagToSnapshot = function(snapshot, next) {
		module.getTag(snapshot.id, snapshot.v, function(err, tag) {
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
	 * @param  {Function} next                Callback (optional).
	 * @return {Snapshot}                     (async) Document snapshot.
	 * @private
	 */
	function transformDocumentToVersion({ webstrateId, snapshot, version }, next) {
		if (!snapshot) {
			snapshot = { v: 0 };
		}

		module.getOps({ webstrateId, initialVersion: snapshot.v, version }, function(err, ops) {
			if (err) return next && next(err);

			// Apply each operation to rebuild the document.
			ops.forEach(function(op) {
				ot.apply(snapshot, op);
			});

			// If after we've applied all updates, we haven't reached the desired version, the user must
			// be requesting a version that doesn't exist yet.
			err = version == snapshot.v ? null :
				new Error(`Version ${version} requested, but newest version is ${snapshot.v}.`);
			next && next(err, snapshot);
		});
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
		db.tags.find({ webstrateId, v: { $lte: version } }).sort({ v : -1 }).limit(1).toArray(
			function(err, tags) {
			if (err) return next && next(err);
			return next && next(null, tags[0]);
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
		db.tags.findOne({ webstrateId, label }, function(err, snapshot) {
			if (err) return next && next(err);
			snapshot.tag = label;
			next && next(null, snapshot);
		});
	}

	return module;
};