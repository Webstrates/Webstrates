"use strict";

var crypto = require('crypto')
var fs = require('fs');
var jsondiff = require('json0-ot-diff');
var jsonmlParse = require('jsonml-parse');
var mime = require('mime-types');
var mongodb = require('mongodb');
var ot = require('sharedb/lib/ot');
var request = require('request');
var sharedb = require('sharedb');
var shortId = require('shortid');
var tmp = require('tmp');
var yauzl = require('yauzl');


/**
 * DocumentManager constructor.
 * @constructor
 * @param {ClientManager}   clientManager  ClientManager instance.
 * @param {AssetManager}    assetManager   AssetManager instance.
 * @param {ShareDBInstance} share          ShareDB instance.
 * @param {ShareDBAgent}    agent          ShareDB agent.
 * @param {MongoDb} db                     MongoDb instance for session log and webstrate tags.
 */
module.exports = function(clientManager, assetManager, share, agent, db) {
	var module = {};

	/**
	 * Creates a new document and returns the id. Note that if the document to be created is not to be
	 * prototyped off of another document, we don't actually create the document, we just return a new
	 * id. The document will instead be created when it is first visited.
	 * @param {string}   options.webstrateId WebstrateId (name of new document).
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
	module.createNewDocument = function({ webstrateId, prototypeId, version, tag, snapshot }, next) {
		if (!webstrateId) {
			webstrateId = shortId.generate();
		}

		// If we're not prototyping (or creating from a snapshot), we can just return a new id. We don't
		// have to build anything.
		if (!prototypeId && !snapshot) {
			return next && next(null, webstrateId);
		}

		// The snapshot is an optional parameter, so if it's not set, let's fetch it from the database
		// and call createNewdocument again with it.
		if (!snapshot) {
			return module.getDocument({ webstrateId: prototypeId, version, tag },
				function(err, snapshot) {
				if (err) return next && next(err);
				module.createNewDocument({ webstrateId, prototypeId, version, tag, snapshot }, next);
			});
		}

		// Let ShareDB handle the creation of the document.
		share.submit(agent, 'webstrates', webstrateId, {
			v: 0,
			create: snapshot
		}, null, function(err) {
			if (err) {
				err = new Error(err.message === "Document created remotely" ?
					"Webstrate already exists." : err.message);
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
	};


	/**
	 * Applies callback recursively to every string in a nested data structure.
	 * @param  {list}   xs         List to recurse.
	 * @param  {Function} callback Function to apply to each string.
	 * @return {list}              Resulting data structure.
	 * @private
	 */
	function recurse(xs, callback) {
		return xs.map(function(x) {
			if (typeof x === "string") return callback(x, xs);
			if (Array.isArray(x)) return recurse(x, callback);
			return x;
		});
	}

	/**
	 * Convert HTML string to JsonML structure.
	 * @param  {string}   html     HTML string.
	 * @param  {Function} callback Callback.
	 * @return {jsonml}            (Async) JsonML object.
	 * @private
	 */
	function htmlToJson(html, callback) {
		jsonmlParse(html.trim(), function(err, jsonml) {
			if (err) return callback(err);
			jsonml = recurse(jsonml, function(str, parent) {
				//if (["script", "style"].includes(parent[0].toLowerCase())) { return str; }
				return str.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
			});
			callback(null, jsonml);
		}, { preserveEntities: true });
	}

	/**
	 * Transform a readable stream into a string.
	 * @param  {ReadableStream} stream Stream to read from.
	 * @param  {Function} callback     Callback to call when stream has been read.
	 * @return {string}                (async) String read from stream.
	 * @private
	 */
	function streamToString(stream, callback) {
		let str = "";
		stream.on('data', chunk => str += chunk);
		stream.on('end', () => callback(str));
	}

	module.createDocumentFromURL = function(url, { webstrateId, source, documentExists }, next) {
		request({url: url, encoding: 'binary' }, (err, response, body) => {
			if (!err && response.statusCode !== 200) {
				err = new Error("Invalid request. Received: " +
					response.statusCode + " " + response.statusMessage);
			}
			if (err) return next(err);

			if (response.headers['content-type'] === 'application/zip') {
				return tmp.file((err, filePath, fd, cleanupFileCallback) => {
					return fs.writeFile(filePath, body, 'binary', err => {
						if (err) {
							cleanupFileCallback();
							return next(err);
						}
						yauzl.open(filePath, { lazyEntries: true } , (err, zipFile) => {
							if (err) {
								cleanupFileCallback();
								return next(err);
							}

							let createdWebstrateId, htmlDocumentFound = false;
							const assets = [];
							zipFile.on("entry", entry => {
								if (/\/$/.test(entry.fileName)) {
									// Directory file names end with '/'.
									// Note that entires for directories themselves are optional.
									// An entry's fileName implicitly requires its parent directories to exist.
									zipFile.readEntry();
								} else {
									// file entry
									zipFile.openReadStream(entry, (err, readStream) => {
										if (err) return console.error(err);
										readStream.on("end", function() {
											zipFile.readEntry();
										});

										if (!htmlDocumentFound && entry.fileName.match(/index\.html?$/i)) {
											htmlDocumentFound = true;
											streamToString(readStream, htmlDoc => {
												htmlToJson(htmlDoc, function(err, jsonml) {
													if (err) return next(err);
													if (documentExists) {
														transformDocumentToSnapshotData(webstrateId, jsonml,
															"documentImport", source, (err, newVersion) => {
															if (err) return next(err);
															createdWebstrateId = webstrateId;
														});
													}
													else {
														module.createNewDocument({
															webstrateId: webstrateId,
															snapshot: {
																type: 'http://sharejs.org/types/JSONv0',
																data: jsonml
															}
														}, function(err, webstrateId) {
															if (err) return next(err);
															createdWebstrateId = webstrateId;
														});
													}
												});
											});
										}
										else {
											crypto.pseudoRandomBytes(16, (err, raw) => {
												const fileName =  raw.toString('hex');
												const filePath = assetManager.UPLOAD_DEST + fileName;
												const writeStream = fs.createWriteStream(filePath);
												readStream.pipe(writeStream);
												assets.push({
													filename: fileName,
													originalname: entry.fileName.match(/([^\/]+)$/)[0],
													size: entry.uncompressedSize,
													mimetype: mime.lookup(entry.fileName)
												});
											});
										}
									});
								}
							});

							function addAssetsToWebstrateOrDeleteTheAssets() {
								if (!createdWebstrateId && !documentExists) {
									assets.forEach(asset => {
										fs.unlink(assetManager.UPLOAD_DEST + asset.filename, () => {});
									});
									next(new Error(htmlDocumentFound
										? "Unable to create webstrate from index.html file."
										: "No index.html found."));
								}

								assetManager.addAssets(createdWebstrateId, assets, source, (err, assetRecords) =>
									next(err, createdWebstrateId));
							}

							zipFile.once("end", function() {
								zipFile.close();
								cleanupFileCallback();

								if (createdWebstrateId) {
									return addAssetsToWebstrateOrDeleteTheAssets();
								}

								// If no webstrateId exists, we're waiting for MongoDB, so we'll wait 500ms.
								setTimeout(addAssetsToWebstrateOrDeleteTheAssets, 500);
							});

							zipFile.readEntry();
						});
					});
				});
			}

			// `startsWith` and not a direct match, because the content-type often (always?) is followed
			// by a charset declaration, which we don't care about.
			if (response.headers['content-type'].startsWith('text/html')) {
				return htmlToJson(body, function(err, jsonml) {
					if (err) return next(err);

					if (documentExists) {
						transformDocumentToSnapshotData(webstrateId, jsonml, "documentImport", source,
							(err, newVersion) => {
							next(err, webstrateId);
						});
					}
					else {
						// webstrateId may be undefined below, in which case a random webstrateId is generated in
						// createNewDocument.
						module.createNewDocument({
							webstrateId: webstrateId,
							snapshot: {
								type: 'http://sharejs.org/types/JSONv0',
								data: jsonml
							}
						}, next);
					}
				});
			}

			next(new Error('Can only prototype from text/html or application/zip sources. ' +
				'Received file with content-type: ' + response.headers['content-type']));
		});
	};

	/**
	 * Retrieve a document snapshot from the database.
	 * @param  {string}   options.webstrateId WebstrateId.
	 * @param  {string}   options.version     Desired document version (tag or version is required).
	 * @param  {string}   options.tag         Desired document tag. (tag or version is required)
	 * @param  {Function} next                Callback.
	 * @return {Snapshot}                     (async) Document snapshot.
	 * @public
	 */
	module.getDocument = function({ webstrateId, version, tag }, next) {
		if (tag) {
			return getDocumentFromTag(webstrateId, tag, next);
		}
		if (version === undefined || version === "" || version === "head") {
			return share.fetch(agent, 'webstrates', webstrateId, next);
		}
		if (Number.isNaN(version)) {
			return next(new Error("Version must be a number or 'head'"));
		}
		getTagBeforeVersion(webstrateId, version, function(err, snapshot) {
			if (err) return next(err);
			transformDocumentToVersion({ webstrateId, snapshot, version }, next);
		});
	};

	/**
	 * Checks whether a document exists. This is faster than retriving the full document.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback.
	 * @return {bool}                 Whether docuemnt exists.
	 * @public
	 */
	module.documentExists = function(webstrateId, next) {
		db.webstrates.findOne({ _id: webstrateId }, { _id: 1 }, function(err, doc) {
			if (err) return next(err);
			return next(null, !!doc);
		});
	};

	/**
	 * Submit raw op to a document.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Op}       op          Op to be sent.
	 * @param  {Function} next        Callback (optional).
	 * @private
	 */
	function submitRawOp(webstrateId, op, next) {
		var request = new sharedb.SubmitRequest(share, agent, 'webstrates', webstrateId, op);
		request.submit(function(err) {
			if (err) return next && next(new Error(err.message));
			next && next();
		});
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
	module.sendNoOp = function(webstrateId, reason, source, next) {
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
	module.submitOp = function(webstrateId, op, source, next) {
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
			if (err) return next && next(err);
			var tag = oldVersion.label;

			transformDocumentToSnapshotData(webstrateId, oldVersion.data, "documentRestore",
				source, (err, newVersion) => {
				module.tagDocument(webstrateId, newVersion, tag + " (restored)", next);
			});
		});
	};

	/**
	 * Delete a document.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback (optional).
	 * @public
	 */
	module.deleteDocument = function(webstrateId, source, next) {
		db.webstrates.remove({ _id: webstrateId }, function(err, res) {
			if (err) return next && next(err);

			clientManager.sendToClients(webstrateId, {
				wa: "delete",
				d: webstrateId
			});

			db.tags.remove({ webstrateId });
			db.ops.remove({ d: webstrateId });
			next && next();
		});
	};

	/**
	 * Retrieves the current version of the document.
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback.
	 * @return {int}                  (async) Document version.
	 */
	module.getDocumentVersion = function(webstrateId, next) {
		db.webstrates.findOne({ _id: webstrateId }, { _v: 1}, function(err, doc) {
			if (err) return next && next(err);
			return next && next(null, Number(doc._v));
		});
	}

	module.getVersionFromTag = function(webstrateId, tag, next) {
		db.tags.findOne({ webstrateId, label: tag }, { _id: 0, v: 1 }, function(err, doc) {
			if (err) return next && next(err);
			return next && next(null, Number(doc.v));
		})
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
			if (!db.sessionLog) return next && next(null, ops);

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
		db.tags.find({ webstrateId }, { webstrateId: 0, data: 0, type: 0 })
			.sort({ v: 1 }).toArray((err, tags) => {
				if (!err) tags.forEach(tag => {
					tag.timestamp = tag._id.getTimestamp();
					delete tag._id;
				});
				next(err, tags);
			});
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
			err = version === snapshot.v ? null :
				new Error(`Version ${version} requested, but newest version is ${snapshot.v}.`);
			next && next(err, snapshot);
		});
	}


	/**
	 * Transform a webstrate (by webstrateId) into snapshot data (i.e. a jsonml representation).
	 * @param  {string}   webstrateId      WebstrateId.
	 * @param  {JsonML}   snapshotData     Desired JsonML document.
	 * @param  {string}   transformMessage No-op text message to insert into history.
	 * @param  {string}   source           Source of the operations.
	 * @param  {Function} next             Callback.
	 * @return {number}                    New version of document after transformation.
	 * @private
	 */
	 function transformDocumentToSnapshotData(webstrateId, snapshotData, transformMessage,
		source, next) {
		// Send a no-op so we can see when the document was transformed, but also to make sure the
		// transform command bumps the document version by at least one to avoid asset name conflicts.
		return module.sendNoOp(webstrateId, transformMessage, source, function(err) {
			module.getDocument({ webstrateId, version: "head" }, function(err, currentVersion) {
				if (err) return next && next(err);
				var ops = jsondiff(currentVersion.data, snapshotData);
				if (ops.length === 0) return next && next(null, currentVersion.v);
				module.submitOps(webstrateId, ops, source, function(err) {
					if (err) return next && next(err);
					var newVersion = currentVersion.v + ops.length + 1;
					return next && next(null, newVersion);
				});
			});
		});
	};


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
			if (!snapshot) return next && next(new Error(`Requested tag ${label} does not exist.`));
			snapshot.tag = label;
			next && next(null, snapshot);
		});
	}

	return module;
};