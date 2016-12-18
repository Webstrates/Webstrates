"use strict";

var shortId = require('shortid');
var jsonml = require('jsonml-tools');
var SELFCLOSING_TAGS = ["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen",
	"link", "menuitem", "meta", "param", "source", "track", "wbr"];

module.exports = function(documentManager, permissionManager, assetManager) {
	var module = {};

	/**
	 * Handles requests to "/" and redirects them to "/frontpage".
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.rootRequestHandler = function(req, res) {
		return res.redirect('/frontpage');
	};

	/**
	 * Handles request without trailing slashes and appends the trailing slash.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.trailingSlashAppendHandler = function(req, res) {
		res.redirect(req.url + "/");
	};

	/**
	 * Middleware for extracting parameters from the query string and appending them to the request
	 * object.
	 * @param {obj}       req  Express request object.
	 * @param {obj}       res  Express response object.
	 * @param  {Function} next Callback
	 * @public
	 */
	module.extractQuery = function(req, res, next) {
		var [webstrateId, versionOrTag, assetName] = Object.keys(req.params).map(i => req.params[i]);
		var { version, tag } = extractVersionOrTag(versionOrTag);
		Object.assign(req, { webstrateId, versionOrTag, assetName, version, tag });
		next();
	};

	/**
	 * Extracts a version or tag from a string.
	 * @param  {string} versionOrTag Version or tag.
	 * @return {obj}                 Object with one property, either version or tag.
	 * @private
	 */
	function extractVersionOrTag(versionOrTag) {
		var version, tag;
		if (versionOrTag === "") {
			version = "";
		} else if (/^\d/.test(versionOrTag)) {
			version = Number(versionOrTag) || undefined;
		} else {
			tag = versionOrTag;
		}
		return { version, tag };
	}

	/**
	 * Primary request handler.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.requestHandler = function(req, res) {
		return documentManager.getDocument({
			webstrateId: req.webstrateId,
			version: req.version,
			tag: req.tag
		}, function(err, snapshot) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			var permissions = permissionManager.getPermissionsFromSnapshot(req.user.username,
				req.user.provider, snapshot);

			// If the webstrate doesn't exist, write permissions are required to create it.
			if (!snapshot.type && !permissions.includes("w")) {
				return res.status(403).send("Insufficient permissions.");
			}

			// If the webstrate does exist, read permissions are required to access it (or any of its
			// assets).
			if (!permissions.includes("r")) {
				return res.status(403).send("Insufficient permissions.");
			}

			// Requesting an asset.
			if (req.assetName) {
				return assetManager.getAsset({
					webstrateId: req.webstrateId,
					assetName: req.assetName,
					version: snapshot.v
				}, function(err, asset) {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}

					if (!asset) {
						return res.status(404).send(`Asset "${req.assetName}" not found.`);
					}

					res.type(asset.mimeType);
					res.sendFile(APP_PATH + "/uploads/" + asset.fileName);
				});
			}

			// Requesting a list of operations by calling `/<id>?ops`.
			if ("ops" in req.query) {
				return serveOps(req, res);
			}

			// Requesting a list of tags by calling `/<id>?tags`.
			if ("tags" in req.query) {
				return serveTags(req, res);
			}

			// Requesting a list of assets by calling `/<id>?assets`.
			if ("assets" in req.query) {
				return serveAssets(req, res);
			}

			// Requesting a raw version of the webstrate, i.e. a server-generated HTML file.
			if ("raw" in req.query) {
				return serveRawWebstrate(req, res, snapshot);
			}

			// Requesting a copy of the webstrate.
			if ("copy" in req.query) {
				return copyWebstrate(req, res, snapshot);
			}

			// Requesting to restore document to a previous version or tag by calling:
			// `/<id>/?restore=<version|tag>`.
			if ("restore" in req.query) {
				if (!permissions.includes("w")) {
					return res.status(403).send("Write permissions are required to restore a document");
				}

				return restoreWebstrate(req, res, snapshot);
			}

			if ("delete" in req.query) {
				if (!permissions.includes("w")) {
					return res.send("Permission denied");
				}

				return deleteWebstrate(req, res);
			}

			// We don't need to check for "static" in req.query, because this happens on the client side.

			return serveWebstrate(req, res);
		});

	};

	function createNewWebstrate(req, res) {
		// If a specific version is requested, we create a new webstrate from the requested
		// version with a name of the format /<id>-<version|tag>-<random string> and redirect the
		// user to it. Only one of `version` and `tag` will be defined.
		var newWebstrateId = req.webstrateId + "-" + (req.version || req.tag)
			+ "-" + shortId.generate();
		return documentManager.createNewDocument({
			webstrateId: newWebstrateId,
			prototypeId: req.webstrateId,
			version: req.version, tag: req.tag
		}, function(err, newWebstrateId) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.redirect("/" + newWebstrateId);
		});
	}

	/**
	 * Requesting a list of operations by calling: /<id>?ops.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveOps(req, res) {
		documentManager.getOps({
			webstrateId: req.webstrateId,
			version: req.version
		}, function(err, ops) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				res.json(ops);
			});
		}

	/**
	 * Requesting a list of tags by calling /<id>?tags.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveTags(req, res) {
		documentManager.getTags(req.webstrateId, function(err, tags) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.json(tags);
		});
	}

	/**
	 * Requesting a list of assets by calling /<id>?assets.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveAssets(req, res) {
		assetManager.getAssets(req.webstrateId, function(err, assets) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.json(assets);
		});
	}

	/**
	 * Requesting a webstrate by calling /<id>?raw.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function serveRawWebstrate(req, res, snapshot) {
		return res.send(jsonml.toXML(snapshot.data, SELFCLOSING_TAGS));
	}

	/**
	 * Copy a webstrate by calling /<id>?copy=[newWebstrate].
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function copyWebstrate(req, res, snapshot) {
		var webstrateId = req.query.copy;
		documentManager.createNewDocument({ webstrateId, snapshot }, function(err, webstrateId) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			// Also copy over all the assets. Note that we pass through snapshot.v, because we know this
			// will always be set, even if no version is specified, or the user is accessing the webstrate
			// through a tag.
			assetManager.copyAssets({
				fromWebstrateId: req.webstrateId,
				toWebstrateId: webstrateId,
				version: snapshot.v
			}, function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				return res.redirect(`/${webstrateId}/`);
			})
		});
	}

	/**
	 * Restore a webstrate to a previous version or tag and redirect the user to the document.
	 * @param {obj}      req      Express request object.
	 * @param {obj}      res      Express response object.
	 * @param {snapshot} snapshot Document snapshot.
	 * @private
	 */
	function restoreWebstrate(req, res, snapshot) {
		// There shouldn't be a version or tag in the first part of the URL, i.e.
		// `/<id>/<version|tag>/?restore` is not allowed.
		if (req.version || req.tag) {
			return res.status(409).send("Can not restore a document at a previous tag or version." +
				` Did you mean <code><a href="/${req.webstrateId}/?restore=${req.versionOrTag}">` +
				`/${req.webstrateId}/?restore=${req.versionOrTag}</a></code>?`);
		}

		// A version or tag in the query string, however, should be defined.
		var { version, tag } = extractVersionOrTag(req.query.restore);
		if (!version && !tag) {
			return res.status(409).send("No tag or version defined.")
		}

		// Ops always have a source (src) set by the client when the op comes in. This source is
		// usually the websocket clientId, but this is a regular HTTP request, so there is no
		// clientId. We'll just use the userId instead.
		var source = req.user.userId;
		return documentManager.restoreDocument({ webstrateId: req.webstrateId, version, tag },
			source, function(err, newVersion) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			// Also restore assets, so the restored version shows the old assets, not the new ones.
			assetManager.restoreAssets({ webstrateId: req.webstrateId, version, tag, newVersion },
			function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				return res.redirect(`/${req.webstrateId}/`);
			});
		});
	}

	/**
	 * Delete a webstrate and redirect the user to the root (`/`).
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function deleteWebstrate(req, res) {
		var source = req.user.userId;
		return documentManager.deleteDocument(req.webstrateId, source, function(err) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}

			assetManager.deleteAssets(req.webstrateId, function(err) {
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				res.redirect("/");
			});
		});
	}

	/**
	 * Requesting a webstrate by calling /<id>.
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @private
	 */
	function serveWebstrate(req, res) {
		return res.sendFile(APP_PATH + "/static/client.html");
	}

	/**
	 * Handles requests to "/new".
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 * @public
	 */
	module.newWebstrateRequestHandler = function(req, res) {
		// Support for the old /new syntax for prototyping/copying.
		if (req.query.prototype) {
			var path = `/${req.query.prototype}/`;
			if (req.query.v) {
				path += `${req.query.v}/`;
			}
			path += "?copy";
			if (req.query.id) {
				path += `=${req.query.id}`;
			}
			return res.redirect(path);
		}

		var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
			req.user.provider);

		// If the user has no default write permissions, they're not allowed to create documents.
		if (!defaultPermissions.includes("w")) {
			return res.status(403).send("Insufficient permissions");
		}

		var webstrateId = shortId.generate();
		res.redirect(`/${webstrateId}/`);
	}

	/**
	 * Handles requests to "/favicon.ico".
	 * @param {obj} req Express request object.
	 * @param {obj} res Express response object.
	 */
	module.faviconRequestHandler = function(req, res) {
		return res.status(404).send("");
	};

	return module;
};