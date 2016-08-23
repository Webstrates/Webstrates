"use strict";

var shortId = require('shortid');
var ot = require('sharedb/lib/ot');
var sharedb = require('sharedb');
var jsondiff = require("json0-ot-diff");

/**
 * DocumentManager constructor.
 * @constructor
 * @param  {ShareDBInstance} share      ShareDB instance.
 * @param  {ShareDBAgent}    agent      ShareDB agent.
 * @param  {MongoCollection} sessionLog Mongo collection of session log.
 */
module.exports = function(share, agent, sessionLog) {
	var module = {};

	/**
	 * Creates a new document and returns the id. Note that if the document to be created is not to be
	 * prototyped off of another document, we don't actually create the document, we just return a new
	 * id. The document will instead be created when it is first visited.
	 * @param {string}   options.webstrateId WebstrateId.
	 * @param {string}   options.prototypeId Name of the webstrate document to base the prototype on.
	 * @param {string}   options.version     Version of the prototype to base the new document on.
	 * @param {Function} next                Callback.
	 * @return {string}                       (async) Name of new webstrate.
	 * @public
	 */
	module.createNewDocument = function({ webstrateId, prototypeId, version }, next) {
		if (!webstrateId) {
			webstrateId = shortId.generate();
		}

		// If we're not prototyping, we can just return a new id. We don't have to build anything.
		if (!prototypeId) {
			return next(null, webstrateId);
		}

		module.getDocument({ webstrateId: prototypeId, version }, function(err, snapshot) {
			if (err) {
				return next(err);
			}
			share.submit(agent, 'webstrates', webstrateId, {
				v: 0,
				create: snapshot
			}, function(err) {
				if (err) {
					err = new Error(err.message === "Document created remotely" ?
						"Webstrate already exists" : err);
				}
				return next(err, webstrateId);
			});
		});
	};

	/**
	 * Retrieve a document snapshot from the database.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Document version.
	 * @param  {Function} next                Callback.
	 * @return {Snapshot}                     (async) Document snapshot.
	 * @public
	 */
	module.getDocument = function({ webstrateId, version }, next) {
		if (!version) {
			version = "head";
		}

		if (version !== "head" && Number.isNaN(version)) {
			return next(new Error("Version must be a number or 'head'"));
		}

		if (version === "head") {
			return share.fetch(agent, 'webstrates', webstrateId, next);
		}

		transformDocumentToVersion({ webstrateId, version }, next);
	};

	/**
	 * Submit op to a document.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {Op}     op          Op to be applied.
	 * @param  {Function} next      Callback.
	 * @public
	 */
	module.submitOp = function(webstrateId, op, source, next) {
		var request = new sharedb.SubmitRequest(share, agent, 'webstrates', webstrateId, {
			op: [op],
			src: source
		});
		request.submit(function(err) {
			if (err) {
				return next(new Error(err.message));
				next();
			}
		});
	};

	/**
	 * Recursively submits ops to a document.
	 * @param  {string} webstrateId WebstrateId.
	 * @param  {Ops}     ops        Ops to be applied.
	 * @param  {Function} next      Callback.
	 */
	module.submitOps = function(webstrateId, ops, source, next) {
		var op = ops.shift();

		if (!op) {
			return next();
		}

		module.submitOp(webstrateId, op, source, function() {
			module.submitOps(webstrateId, ops, source, next);
		});
	}

	/**
	 * Reverts a document to a specific version.
	 * @param  {string} options.webstrateId WebstrateId.
	 * @param  {string} options.version     Document version.
	 * @param  {Function} next)             Callback.
	 * @public
	 */
	module.revertDocument = function({webstrateId, version}, source, next) {
		module.getDocument({ webstrateId, version }, function(err, oldVersion) {
			if (err) return next(err);
			module.getDocument({ webstrateId, version: "head" }, function(err, currentVersion) {
				if (err) return next(err);
				var ops = jsondiff(currentVersion.data, oldVersion.data);
				module.submitOps(webstrateId, ops, source, next);
			});
		});
	};

	/**
	 * Delete a diocument.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback.
	 * @public
	 */
	module.deleteDocument = function(webstrateId, source, next) {
		var request = new sharedb.SubmitRequest(share, agent, 'webstrates', webstrateId, {
			del: true,
			src: source
		});
		request.submit(function(err) {
			if (err) {
				return next(new Error(err.message));
			}
			next();
		});
	};

	/**
	 * Get operations for a document.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Document version.
	 * @param  {Function} next                Callback.
	 * @return {Ops}                          (async) Operations.
	 * @public
	 */
	module.getOps = function({ webstrateId, version }, next) {
		// If no version is defined, all operations will be retrieved.
		share.getOps(agent, 'webstrates', webstrateId, 0, version, function(err, ops) {
			if (err) return next(err);

			// TODO: Remove. This is probably not necessary.
			// Sort operations to make sure we apply them in the right order.
			ops.sort(function(a, b) {
				return a.v - b.v;
			});

			if (!sessionLog.coll) {
				return next(null, ops);
			}

			// If we have access to a session log, we attach session entries to operations before
			// returning them.
			var sessionsInOps = new Set();
			ops.forEach(function(op) {
				sessionsInOps.add(op.src);
			});

			sessionLog.coll.find({
				"sessionId": { $in: Array.from(sessionsInOps) }
			}).toArray(function(err, sessions) {
				if (err) {
					throw err;
				}

				ops.forEach(function(op) {
					op.session = sessions.find(function(session) {
						return op.src === session.sessionId;
					});
				});

				next(null, ops);
			});
		});
	};

	/**
	 * Transforms a document to a specific version.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Document version.
	 * @param  {Function} next                Callback.
	 * @return {Snapshot}                     (async) Document snapshot.
	 * @private
	 */
	function transformDocumentToVersion({ webstrateId, version }, next) {
		module.getOps({ webstrateId, version }, function(err, ops) {
			if (err) {
				return next(err);
			}

			var snapshot = { v: 0 };

			// Apply each operation to rebuild the document.
			ops.forEach(function(op) {
				ot.apply(snapshot, op);
			});

			// If after we've applied all updates, we haven't reached the desired version, the user must
			// be requesting a version that doesn't exist yet.
			err = version == snapshot.v ? null :
				new Error(`Version ${version} requested, but newest version is ${snapshot.v}.`);
			next(err, snapshot);
		});
	}

	return module;
};