"use strict";

module.exports = function(documentManager, permissionManager) {
	var module = {};

	/**
	 * Handles requests to "/".
	 * @param {obj} req Request object.
	 * @param {obj} res Response Object.
	 */
	module.rootRequestHandler = function(req, res) {
		return res.redirect('/frontpage');
	};

	/**
	 * Handles requests to "/:id".
	 * @param {obj} req Request object.
	 * @param {obj} res Response Object.
	 */
	module.idRequestHandler = function(req, res) {
		var webstrateId = req.params.id;
		var version = req.query.v === "" ? "" : (Number(req.query.v) || undefined);
		if (!webstrateId) {
			return res.redirect('/frontpage');
		}

		documentManager.getDocument({ webstrateId, version }, function(err, snapshot) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			var permissions = permissionManager.getPermissionsFromSnapshot(req.user.username,
				req.user.provider, snapshot);

			// If the webstrate doesn't exist, write permissions are required to create it.
			if (!snapshot.type && !permissions.includes("w")) {
				return res.send("Permission denied");
			}

			// If the webstrate does exist, read permissions are required to access it.
			if (!permissions.includes("r")) {
				return res.send("Permission denied");
			}

			// If the user is requesting a specific version by calling /<id>?v=<version>, or they are
			// requesting the current version number by calling /<id>?v.
			if (typeof version !== "undefined") {
				// The user is requesting the current version number.
				if (version == "") {
					return res.send(String(snapshot.v));
				}

				// If a specific version is requested, we create a new webstrate from the requested
				// version with a name of the format /<id>-<version>-<random string> and redirect the
				// user to it.
				var newWebstrateId = webstrateId + "-" + version + "-" + shortId.generate();
				return documentManager.createNewDocument({
					webstrateId: newWebstrateId,
					prototypeId: webstrateId,
					version
				}, function(err, newWebstrateId) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					res.redirect("/" + newWebstrateId);
				});
			}

			// If the user is requesting a list of operations by calling: /<id>?ops.
			if (typeof req.query.ops !== "undefined") {
				return documentManager.getOps({
					webstrateId,
					version
				}, function(err, ops) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					res.send(ops);
				});
			}

			// If the user is requesting a list of tags by calling /<id>?tags.
			if (typeof req.query.tags !== "undefined") {
				return documentManager.getTags(webstrateId, function(err, tags) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					res.send(tags);
				});
			}

			// If the user is requesting to restore the document to an old version by calling
			// /<id>?restore=<version>.
			if (typeof req.query.restore !== "undefined") {
				// Restoring requires write permissions.
				if (!permissions.includes("w")) {
					return res.send("Permission denied");
				}

				var tagOrVersion = req.query.restore;
				var version;
				var tag;

				if (/^\d/.test(tagOrVersion)) {
					version = tagOrVersion;
				} else {
					tag = tagOrVersion;
				}

				if (version && version >= snapshot.v) {
					return res.status(409).send(String(new Error(
						"Version to restore from must be older than document's current version.")));
				}

				// Ops always have a source (src) set by the client when the op comes in. This source is
				// usually the websocket clientId, but this is a regular HTTP request, so there is no
				// clientId. We'll just use the userId instead.
				var source = req.user.userId;
				return documentManager.restoreDocument({
					webstrateId,
					version,
					tag
				}, source,
					function(err) {
						if (err) {
							console.error(err);
							return res.status(409).send(String(err));
						}
						return res.redirect("/" + webstrateId);
					});
			}

			if (typeof req.query.delete !== "undefined") {
				// Deleting requires write permissions.
				if (!permissions.includes("w")) {
					return res.send("Permission denied");
				}

				var source = req.user.userId;
				return documentManager.deleteDocument(webstrateId, source, function(err) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					res.redirect("/");
				});
			}

			res.setHeader("Location", "/" + webstrateId);
			return res.sendFile(APP_PATH + "/static/client.html");
		});
	};

	/**
	 * Handles requests to "/new".
	 * @param {obj} req Request object.
	 * @param {obj} res Response Object.
	 */
	module.newWebstrateRequestHandler = function(req, res) {
		var webstrateId = req.query.id;
		var prototypeId = req.query.prototype;
		var version = req.query.v === "" ? "" : (Number(req.query.v) || undefined);

		var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
			req.user.provider);

		// If the user has no default write permissions, they're not allowed to create documents.
		if (!defaultPermissions.includes("w")) {
			return res.send("Permission denied");
		}

		// If the user is trying to create a new document from a prototype, we need to make sure that
		// the user has read access to the document in the first place.
		if (prototypeId) {
			return permissionManager.getPermissions(req.user.username, req.user.provider, prototypeId,
				function(err, webstratePermissions) {
				if (!webstratePermissions.includes("r")) {
					return res.send("Permission denied");
				}

				documentManager.createNewDocument({ webstrateId, prototypeId, version },
					function(err, webstrateId) {
					if (err) {
						console.error(err);
						return res.status(409).send(err);
					}

					var source = req.user.userId;
					permissionManager.addPermissions(req.user.username, req.user.provider, defaultPermissions,
						webstrateId, source, function(err, ops) {
						if (err) {
							console.error(err);
							return res.status(409).send(String(err));
						}
						return res.redirect("/" + webstrateId);
					});
				});
			});
		}

		// If there's no prototypeId defined, the user is just trying to create a clean new webstrate.
		documentManager.createNewDocument({ webstrateId, version }, function(err, webstrateId) {
			if (err) {
				console.error(err);
				return res.status(409).send(err);
			}
			return res.redirect("/" + webstrateId);
		});
	};

	/**
	 * Handles requests to "/favicon.ico".
	 * @param {obj} req Request object.
	 * @param {obj} res Response Object.
	 */
	module.faviconRequestHandler = function(req, res) {
		return res.status(404).send("");
	};

	return module;
};