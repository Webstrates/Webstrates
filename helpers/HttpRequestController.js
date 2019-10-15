'use strict';

const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('graceful-fs');
const jsonmlTools = require('jsonml-tools');
const htmlToJsonML = require('html-to-jsonml');
const mime = require('mime-types');
const multer = require('multer');
const os = require('os');
const request = require('request');
const shortId = require('shortid');
const tmp = require('tmp');
const url = require('url');
const yauzl = require('yauzl');
const SELFCLOSING_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen',
	'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'];

const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const niceWebstrateIds = require(APP_PATH + '/helpers/niceWebstrateIds.js');

async function generateWebstrateId(req) {
	if (config.niceWebstrateIds) {
		const startingLetter = req.user.userId !== 'anonymous:' && req.user.username.charAt(0);
		return await niceWebstrateIds.generate(startingLetter);
	} else {
		return shortId.generate();
	}
}

/**
 * Handles requests to "/" and redirects them to "/frontpage".
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @public
 */
module.exports.rootRequestHandler = function(req, res) {
	return res.redirect('/frontpage');
};

/**
 * Handles request without trailing slashes and appends the trailing slash.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @public
 */
module.exports.trailingSlashAppendHandler = function(req, res) {
	var queryIndex = req.url.indexOf('?');
	var query = queryIndex !== -1? req.url.substring(queryIndex) : '';
	res.redirect(req.path + '/' + query);
};

/**
 * Middleware for extracting parameters from the query string and appending them to the request
 * object.
 * @param {obj}       req  Express request object.
 * @param {obj}       res  Express response object.
 * @param  {Function} next Callback
 * @public
 */
module.exports.extractQuery = function(req, res, next) {
	const [webstrateId, versionOrTag, assetName, assetPath]
		= Object.keys(req.params).map(i => req.params[i]);
	const { version, tag } = extractVersionOrTag(versionOrTag);
	Object.assign(req, { webstrateId, versionOrTag, assetName, assetPath, version, tag });
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
	if (versionOrTag === '') {
		version = '';
	} else if (/^\d/.test(versionOrTag)) {
		version = Number(versionOrTag) || undefined;
	} else {
		tag = versionOrTag;
	}
	return { version, tag };
}

/**
 * Extract host from a URL string, e.g. get `domain:8000` from `http://user:pass@domain:8000/path/`.
 * @param  {string} urlString URL string.
 * @return {string}           Host string.
 * @private
 */
function getHostFromUrl(urlString) {
	try {
		return (new url.URL(urlString)).host;
	}
	catch (e) {
		return false;
	}
}

/**
 * Set CORS header on a response, assuming the requesting host is allowed it.
 * @param {obj} req         Request object.
 * @param {obj} res         Response object.
 * @param {JsonML} snapshot ShareDB document snapshot.
 * @private
 */
function setCorsHeaders(req, res, snapshot) {
	const originHost = getHostFromUrl(req.headers.origin);

	if (!originHost || !snapshot || !snapshot.data || !snapshot.data[0] ||
		!snapshot.data[0] === 'html' || !snapshot.data[1] || !snapshot.data[1]['data-cors']) {
		return false;
	}

	let allowedDomains;
	try {
		allowedDomains = JSON.parse(snapshot.data[1]['data-cors'].replace(/'/g, '"')
			.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
	} catch (err) {
		console.warn('Couldn\'t parse cors settings for', snapshot.id);
		return false;
	}

	// Find a domain with matching host. This is more laxed than doing a strict string comparison
	// where something like 'http://domain.tld' won't match with 'http://domain.tld/'. We can't
	// give an error back to the user, so this would be a pain to debug.
	const allowCors = allowedDomains.some(domain => getHostFromUrl(domain) === originHost);
	if (!allowCors) {
		return false;
	}

	res.header('Access-Control-Allow-Origin', req.headers.origin);
	res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
	res.header('Access-Control-Allow-Credentials', 'true');
	return true;
}

/**
 * Get Object structure of all files and directories in a ZIP asset.
 * @param  {string} req    Name of ZIP file.
 * @return {obj}           Object with structure representing the ZIP file.
 * @private
 */
const getZipStructure = async (fileName) => new Promise((accept, reject) => {
	yauzl.open(APP_PATH + '/uploads/' + fileName, { lazyEntries: true }, (err, zipFile) => {
		const fileList = [];
		zipFile.on('entry', entry => {
			fileList.push(entry.fileName);
			zipFile.readEntry();
		});
		zipFile.once('end', () => {
			accept(fileList);
		});
		zipFile.readEntry();
	});
});

/**
 * Primary request handler.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @public
 */
module.exports.requestHandler = async function(req, res) {
	// Support for legacy syntax: /<webstrateId>?v=<versionOrTag>, which is equivalent to
	// /<webstrateId>/<versionOrTag>/?copy.
	if (req.query.v && !req.versionOrTag) {
		const version = req.query.v;
		delete req.query.v;
		return res.redirect(url.format({
			pathname: `/${req.webstrateId}/${version}/`,
			query: req.query
		}));
	}

	return documentManager.getDocument({
		webstrateId: req.webstrateId,
		version: req.version,
		tag: req.tag
	}, async function(err, snapshot) {
		if (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}

		req.user.permissions = await permissionManager.getUserPermissionsFromSnapshot(req.user.username,
			req.user.provider, snapshot);

		// If the webstrate doesn't exist, write permissions are required to create it.
		if (!snapshot.type && !req.user.permissions.includes('w')) {
			return res.status(403).send('Insufficient permissions. Write is required to create a new webstrate.');
		}

		// If the webstrate does exist, read permissions are required to access it (or any of its
		// assets).
		if (!req.user.permissions.includes('r')) {
			return res.status(403).send('Insufficient permissions. Read is required to access this webstrate.');
		}

		// Set CORS header on a response, assuming the requesting host is allowed it.
		setCorsHeaders(req, res, snapshot);

		// Requesting an asset.
		if (req.assetName) {
			try {
				const asset = await assetManager.getAsset({
					webstrateId: req.webstrateId,
					assetName: req.assetName,
					version: snapshot.v
				});

				if (!asset) {
					return res.status(404).send(`Asset "${req.assetName}" not found.`);
				}

				if ('dir' in req.query) {
					const zipStructure = await getZipStructure(asset.fileName);
					res.json(zipStructure);
					return;
				}

				if (req.assetPath) {
					return yauzl.open(APP_PATH + '/uploads/' + asset.fileName, { lazyEntries: true },
						(err, zipFile) => {
							if (err) {
								return res.status(400).send(`"${req.assetName}" is not a valid ZIP file.`);
							}
							zipFile.on('entry', async entry => {
								if (req.assetPath !== entry.fileName) {
									return zipFile.readEntry();
								}

								// If requested file is a directory, list directory files.
								if (entry.fileName.endsWith('/')) {
									const zipStructure = await getZipStructure(asset.fileName);
									const filteredZipStructure = zipStructure.filter(path =>
										path.startsWith(entry.fileName));
									return res.json(filteredZipStructure);
								}

								zipFile.openReadStream(entry, (err, readStream) => {
									res.type(mime.lookup(entry.fileName) || 'text/plain');
									// Getting this from a ZIP might be a little heavy, so we cache it for a year,
									// even though the ZIP asset could in fact get overwritten.
									res.setHeader('Cache-Control', 'public, max-age=31557600');
									readStream.pipe(res);
								});
							});
							zipFile.readEntry();

							zipFile.once('end', async () => {
								res.status(404).send(`File "${req.assetPath}" not found in asset ` +
									`"${req.assetName}".\n`);
							});
						});
				}

				// `/<webstrateId>/<asset>` may not always refer to the same asset, but to optimize rapid
				// requests, we set a maxAge anyway. If the requested asset includes a specific version,
				// it'll always refer to the same thing, allowing us to set a longer maxAge.
				var maxAge = req.version ? '1y' : (config.maxAge || '1m');
				res.type(asset.mimeType);
				return res.sendFile(APP_PATH + '/uploads/' + asset.fileName, { maxAge });
			} catch (error) {
				console.error(error);
				return res.status(409).send(String(err));
			}
		}

		// Requesting current document version number by calling `/<id>?v` or `/<id>?version`.
		if ('v' in req.query || 'version' in req.query) {
			return serveVersion(req, res, snapshot);
		}

		// Requesting a list of operations by calling `/<id>?ops`.
		if ('ops' in req.query) {
			return serveOps(req, res);
		}

		// Requesting a list of tags by calling `/<id>?tags`.
		if ('tags' in req.query) {
			return serveTags(req, res);
		}

		// Requesting a list of assets by calling `/<id>?assets`.
		if ('assets' in req.query) {
			return serveAssets(req, res);
		}

		// Requesting a JsonML version of the webstrate by calling `/<id>?json`.
		if ('json' in req.query) {
			if (!snapshot.type) {
				return res.status(404).send('Document doesn\'t exist.');
			}

			return serveJsonMLWebstrate(req, res, snapshot);
		}

		// Requesting a raw version of the webstrate (i.e. a server-generated HTML file) by calling
		// `/<id>?raw`.
		if ('raw' in req.query) {
			if (!snapshot.type) {
				return res.status(404).send('Document doesn\'t exist.');
			}

			return serveRawWebstrate(req, res, snapshot);
		}

		if ('dl' in req.query) {
			if (!snapshot.type) {
				return res.status(404).send('Document doesn\'t exist.');
			}

			return serveCompressedWebstrate(req, res, snapshot);
		}

		if ('tokens' in req.query) {
			return serveTokenList(req, res);
		}

		// Requesting a copy of the webstrate.
		if ('copy' in req.query) {
			var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
				req.user.provider);

			// If a user is required to be logged in (through loggedInToCreateWebstrates) to create a
			// webstrate, we also require them to be logged in to copy a webstrate.
			if (!permissionManager.userIsAllowedToCreateWebstrate(req.user)) {
				let err = 'Must be logged in to copy a webstrate.';
				if (Array.isArray(config.loggedInToCreateWebstrates)) {
					const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
					err =  `Must be logged in with ${allowedProviders} to copy a webstrate.`;
				}
				return res.status(403).send(err);
			}

			// If the user has no default write permissions, they're not allowed to create documents.
			if (!defaultPermissions.includes('w')) {
				return res.status(403).send('Write permissions are required to create a new document.');
			}

			return copyWebstrate(req, res, snapshot);
		}

		// Requesting to restore document to a previous version or tag by calling:
		// `/<id>/?restore=<version|tag>`.
		if ('restore' in req.query) {
			if (!req.user.permissions.includes('w')) {
				return res.status(403).send('Write permissions are required to restore a document.');
			}

			// If the document contains a user with admin permissions, only admins can restore the
			// document.
			if (!req.user.permissions.includes('a') &&
				await permissionManager.webstrateHasAdmin(req.webstrateId)) {
				return res.status(403).send('Admin permissions are required to restore this document.');
			}

			return restoreWebstrate(req, res, snapshot);
		}

		if ('delete' in req.query) {
			// If a user is required to be logged in (through loggedInToCreateWebstrates) to create a
			// webstrate, we also require them to be logged in to delete a webstrate.
			if (!permissionManager.userIsAllowedToCreateWebstrate(req.user)) {
				let err = 'Must be logged in to delete a webstrate.';
				if (Array.isArray(config.loggedInToCreateWebstrates)) {
					const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
					err =  `Must be logged in with ${allowedProviders} to delete a webstrate.`;
				}
				return res.status(403).send(err);
			}

			if (!req.user.permissions.includes('w')) {
				return res.status(403).send('Write permissions are required to delete a document.');
			}

			// If the document contains a user with admin permissions, only admins can delete the
			// document.
			if (!req.user.permissions.includes('a') &&
				await permissionManager.webstrateHasAdmin(req.webstrateId)) {
				return res.status(403).send('Admin permissions are required to delete this document.');
			}

			return deleteWebstrate(req, res);
		}

		// We don't need to check for "static" in req.query, because this happens on the client side.

		return serveWebstrate(req, res);
	});

};

/**
 * Requesting current document version number by calling `/<id>?v`.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
function serveVersion(req, res, snapshot) {
	res.json({ version: snapshot.v });
}

/**
 * Requesting a list of operations by calling: `/<id>?ops`.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
function serveOps(req, res) {
	documentManager.getOps({
		webstrateId: req.webstrateId,
		version: Number(req.version || req.query.to) || undefined,
		initialVersion: Number(req.query.from) || undefined
	}, function(err, ops) {
		if (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}
		res.json(ops);
	});
}

/**
 * Requesting a list of tags by calling `/<id>?tags`.
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
 * Requesting a list of assets by calling `/<id>?assets`.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
function serveAssets(req, res) {
	let latestOnly = 'latest' in req.query;
	assetManager.getAssets(req.webstrateId, function(err, assets) {
		if (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}
		res.json(assets);
	}, latestOnly);
}

function serveJsonMLWebstrate(req, res, snapshot) {
	res.send(snapshot.data);
}

/**
 * Requesting a raw webstrate by calling `/<id>?raw`.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
function serveRawWebstrate(req, res, snapshot) {
	// A specific version of webstrate is immutable, so we can cache a request to a specific version
	// indefinitely. Tags can be moved, so we can't do the same there.
	if (req.version) {
		// In reality, we just cache for a year.
		res.setHeader('Cache-Control', 'public, max-age=31557600');
	}
	// MongoDB doesn't support periods in keys, so we substitute them with the string `&dot;` to
	// store them. This function reverts that. We only do this when sending raw documents, as the
	// client side Webstrate code already handles this otherwise.
	res.send('<!doctype html>\n' + jsonmlTools.toXML(replaceInKeys(snapshot.data, '&dot;', '.'),
		SELFCLOSING_TAGS));
}

/**
 * Requesting to download a webstraet by calling `/<id>?dl`.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
function serveCompressedWebstrate(req, res, snapshot) {
	assetManager.getCurrentAssets(req.webstrateId, function(err, assets) {
		if (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}

		const format = req.query.dl === 'tar' ? 'tar' : 'zip';
		const archive = archiver(format, { store: true });
		archive.append('<!doctype html>\n' + jsonmlTools.toXML(snapshot.data, SELFCLOSING_TAGS),
			{ name: `${req.webstrateId}/index.html` });

		assets.forEach(function(asset) {
			const filePath = `${assetManager.UPLOAD_DEST}${asset.fileName}`;
			if (fs.existsSync(filePath)) {
				archive.file(filePath,
					{ name: `${req.webstrateId}/${asset.originalFileName}` });

				// If the file is searchable, we create a dummy file with the contents 'searchable', so we
				// know to make the file searchable if the archive is uploaded again (or to another server).
				if (asset.searchable) {
					archive.append('searchable',
						{ name: `${req.webstrateId}/${asset.originalFileName}.searchable` });
				}
			} else {
				console.warn(`Asset ${filePath} (${asset.originalFileName}) for Webstrate ` +
					`${req.webstrateId} doesn't exist. Deleting it from database.`);
				// The deletion happens async, but there's no reason to make the user wait for it.
				assetManager.deleteAssetFromDatabase(asset.fileName);
			}
		});
		archive.finalize();
		const potentialTag = req.tag ? ('-' + req.tag) : '';
		const filename = req.query.filename || `${req.webstrateId}-${snapshot.v}${potentialTag}.${format}`;
		res.attachment(filename);
		archive.pipe(res);
	});
}

function serveTokenList(req, res) {
	res.json(permissionManager.getAccessTokens(req.webstrateId));
}

/**
 * Copy a webstrate by calling `/<id>?copy[=newWebstrateId]`.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
async function copyWebstrate(req, res, snapshot) {
	let webstrateId = req.query.copy || await generateWebstrateId(req);

	// If user doesn't have write permissions to the docuemnt, add them if the user is logged in,
	// otherwise just delete all permissions on the new document.
	if (!req.user.permissions.includes('w')) {
		if (req.user.username === 'anonymous' && req.user.provider === '') {
			snapshot = permissionManager.clearPermissionsFromSnapshot(snapshot);
		} else {
			snapshot = await permissionManager.addPermissionsToSnapshot(req.user.username,
				req.user.provider, 'rw', snapshot);
		}
	}

	// Remove all admin permissions from the snapshot.
	snapshot = await permissionManager.removeAdminPermissionsFromSnapshot(snapshot);

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
			delete req.query.copy;
			return res.redirect(url.format({
				pathname:`/${webstrateId}/`,
				query: req.query
			}));
		});
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
		return res.status(409).send('Can not restore a document at a previous tag or version.' +
			` Did you mean <code><a href="/${req.webstrateId}/?restore=${req.versionOrTag}">` +
			`/${req.webstrateId}/?restore=${req.versionOrTag}</a></code>?`);
	}

	// A version or tag in the query string, however, should be defined.
	var { version, tag } = extractVersionOrTag(req.query.restore);
	if (!version && !tag) {
		return res.status(409).send('No tag or version defined.');
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
					delete req.query.restore;
					return res.redirect(url.format({
						pathname:`/${req.webstrateId}/`,
						query: req.query
					}));
				});
		});
}

/**
 * Delete the assets of a webstrate, then the delete the webstrate itself, and redirect the user
 * to the root (`/`).
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
function deleteWebstrate(req, res) {
	var source = req.user.userId;
	return assetManager.deleteAssets(req.webstrateId, function(err) {
		if (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}

		documentManager.deleteDocument(req.webstrateId, source, function(err, result) {
			if (err) {
				console.error(err);
				return res.status(409).send(String(err));
			}
			res.redirect('/');
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
	var maxAge = config.maxAge || '1d';
	return res.sendFile(APP_PATH + '/static/client.html', { maxAge });
}

/**
 * Replaces a string with another string in the attribute names of a JsonML structure.
 * Webstrate code usually handles this.
 * @param  {JsonML} snapshot    JsonML structure.
 * @param  {string} search      String to search for. Regex also works.
 * @param  {string} replacement String to replace search with.
 * @return {JsonML}             JsonML with replacements.
 * @private
 */
function replaceInKeys(jsonml, search, replacement) {
	if (Array.isArray(jsonml)) {
		return jsonml.map(e => replaceInKeys(e, search, replacement));
	}
	if (typeof jsonml === 'object') {
		for (const key in jsonml) {
			const cleanKey = key.replace(search, replacement);
			jsonml[cleanKey] = replaceInKeys(jsonml[key], search, replacement);
			if (cleanKey !== key) {
				delete jsonml[key];
			}
		}
	}
	return jsonml;
}

/**
 * Transform a readable straem into a string
 * @param  {ReadableStream} stream Stream to read from.
 * @param  {Function} callback     Callback to call when stream has been read.
 * @return {string}                (async) String read from stream.
 * @private
 */
function streamToString(stream, callback) {
	let str = '';
	stream.on('data', chunk => str += chunk);
	stream.on('end', () => callback(str));
}

/**
 * Handles GET requests to "/new".
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @public
 */
module.exports.newWebstrateGetRequestHandler = async function(req, res) {
	// Support for legacy syntax: /new?prototype=<webstrateId>&v=<versionOrTag>&id=<newWebstrateId>,
	// which is equivalent to /<webstrateId>/<versionOrTag>/?copy=<newWebstrateId>.

	if (!permissionManager.userIsAllowedToCreateWebstrate(req.user)) {
		let err = 'Must be logged in to create a webstrate.';
		if (Array.isArray(config.loggedInToCreateWebstrates)) {
			const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
			err =  `Must be logged in with ${allowedProviders} to create a webstrate.`;
		}

		return res.status(409).send(err);
	}

	if ('prototypeFile' in req.query) {
		const action = req.query.id ? `/new?id=${req.query.id}` : '/new';
		return res.send(`
			<form method="post" action="${action}" enctype="multipart/form-data">
				<input type="file" name="file" accept=".zip"><br>
				<input type="submit" value="Upload ZIP">
			</form>
		`);
	}

	if ('prototypeUrl' in req.query) {
		return request({url: req.query.prototypeUrl, encoding: 'binary' },
			function(err, response, body) {
				if (!err && response.statusCode !== 200) {
					err = new Error('Invalid request. Received: ' +
					response.statusCode + ' ' + response.statusMessage);
				}
				if (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}
				if (response.headers['content-type'] === 'application/zip'
					|| response.headers['content-type'] === 'application/x-zip-compressed'
					|| (response.headers['content-disposition']
						&& response.headers['content-disposition'].match(/(filename=\*?)(.*)\.zip$/i))) {
					return tmp.file((err, filePath, fd, cleanUpCallback) => {
						return fs.writeFile(filePath, body, 'binary', async err => {
							if (err) {
								console.error(err);
							}
							const webstrateId = req.query.id || await generateWebstrateId(req);
							try {
								await createWebstrateFromZipFile(filePath, webstrateId, req);
								res.redirect(`/${webstrateId}/`);
							} catch (err) {
								console.error(err);
								res.status(409).send(String(err));
							}
							// Tell the tmp package to delete the temporary file it created.
							cleanUpCallback();
						});
					});
				}

				// `startsWith` and not a direct match, because the content-type often (always?) is followed
				// by a charset declaration, which we don't care about.
				if ((response.headers['content-type']
					&& response.headers['content-type'].startsWith('text/html'))
					|| (response.headers['content-disposition']
						&& response.headers['content-disposition'].match(/(filename=\*?)(.*)\.html?$/i))) {
					const jsonml = htmlToJsonML(body);
					documentManager.createNewDocument({
						webstrateId: req.query.id,
						snapshot: {
							type: 'http://sharejs.org/types/JSONv0',
							data: jsonml
						}
					}, function(err, webstrateId) {
						if (err) {
							console.error(err);
							return res.status(409).send(String(err));
						}
						delete req.query.prototypeUrl;
						delete req.query.id;
						return res.redirect(url.format({
							pathname:`/${webstrateId}/`,
							query: req.query
						}));
					});
				}

				res.status(405).send('Can only prototype from text/html or application/zip sources. ' +
				'Received file with content-type: ' + response.headers['content-type']);
			});
	}

	if (req.query.prototype) {
		var path = `/${req.query.prototype}/`;
		delete req.query.prototype;
		if (req.query.v) {
			path += `${req.query.v}/`;
			delete req.query.v;
		}
		req.query.copy = req.query.id;
		delete req.query.id;
		return res.redirect(url.format({
			pathname: path,
			query: req.query
		}));
	}

	var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
		req.user.provider);

	// If the user has no default write permissions, they're not allowed to create documents.
	if (!defaultPermissions.includes('w')) {
		return res.status(403).send('Write permissions are required to create a new document');
	}

	const webstrateId = await generateWebstrateId(req);
	res.redirect(url.format({
		pathname: `/${webstrateId}/`,
		query: req.query
	}));
};

const TMP_DIR = os.tmpdir();
const upload = multer({
	dest: TMP_DIR,
	limits: { fileSize: (config.maxAssetSize || 20) * 1024 * 1024 }, // 20 MB default.
}).single('file');

module.exports.newWebstratePostRequestHandler = async function(req, res) {
	if (!permissionManager.userIsAllowedToCreateWebstrate(req.user)) {
		let err = 'Must be logged in to create a webstrate.';
		if (Array.isArray(config.loggedInToCreateWebstrates)) {
			const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
			err =  `Must be logged in with ${allowedProviders} to create a webstrate.˛`;
		}

		return res.status(409).send(err);
	}

	upload(req, res, async function(err) {
		if (err) {
			console.error(err);
			return res.status(409).json(err.code === 'LIMIT_FILE_SIZE'  ?
				{ error: `Maximum file size exceeded (${(config.maxAssetSize || 20)} MB).` } : err);
		}

		if (!req.file) {
			return res.status(409).json({
				error: 'No file received.'
			});
		}

		if (req.file.mimetype !== 'application/zip' && req.file.mimetype !== 'application/x-zip-compressed'
			&& !req.file.originalname.match(/\.zip$/i)) {
			return res.status(409).json({
				error: 'Can only prototype from application/zip files. Received content-type: '
					+ req.file.mimetype
			});
		}

		const webstrateId = req.query.id || req.body.id || await generateWebstrateId(req);
		try {
			await createWebstrateFromZipFile(req.file.path, webstrateId, req);
			// If `apiCall` has been set, this call is being made programatically and should thus return
			// a machine parsable result, like a JSON reply, instead of a redirect.
			if (req.body.apiCall || req.query.apiCall) {
				res.json({ webstrateId });
			} else {
				res.redirect(`/${webstrateId}/`);
			}
		} catch (err) {
			res.status(409).json({
				error: err.message
			});
		}
	});
};

/**
 * Create a webstrate from a ZIP file on disk.
 * @param  {string} filePath    Path to ZIP file.
 * @param  {string} webstrateId Desired webstrateId.
 * @param  {object} req         Request object.
 * @return {Promise}            Rejection on failure.
 * @private
 */
async function createWebstrateFromZipFile(filePath, webstrateId, req) {
	return new Promise((accept, reject) => {
		yauzl.open(filePath, { lazyEntries: true } , (err, zipFile) => {
			if (err) {
				console.error(err);
				reject(err);
			}

			let htmlDocumentFound = false, createdWebstrate = false;
			let assets = [];
			zipFile.on('entry', entry => {
				if (/\/$/.test(entry.fileName)) {
				// Directory file names end with '/'.
				// Note that entries for directories themselves are optional.
				// An entry's fileName implicitly requires its parent directories to exist.
					zipFile.readEntry();
				} else {
				// file entry
					zipFile.openReadStream(entry, (err, readStream) => {
						if (err) {
							console.error(err);
							reject(err);
						}
						readStream.on('end', function() {
							zipFile.readEntry();
						});

						if (!htmlDocumentFound && entry.fileName.match(/index\.html?$/i)) {
							htmlDocumentFound = true;
							streamToString(readStream, async htmlDoc => {
								let jsonml = htmlToJsonML(htmlDoc);
								// MongoDB doesn't accept periods in keys, so we replace them with
								// `&dot;`s when storing them in the database.
								jsonml = replaceInKeys(jsonml, '.', '&dot;');
								let snapshot = {
									type: 'http://sharejs.org/types/JSONv0',
									data: jsonml
								};
								const userPermissions = await permissionManager
									.getUserPermissionsFromSnapshot(req.user.username, req.user.provider,
										snapshot);
								// If user doesn't have write permissions to the docuemnt, add them if
								// the user is logged in, otherwise just delete all permissions on the
								// new document.
								if (!userPermissions.includes('w')) {
									if (req.user.username === 'anonymous' && req.user.provider === '') {
										snapshot = permissionManager.clearPermissionsFromSnapshot(snapshot);
									} else {
										snapshot = await permissionManager
											.addPermissionsToSnapshot(req.user.username, req.user.provider,
												'rw', snapshot);
									}
								}
								documentManager.createNewDocument({
									webstrateId, snapshot
								}, function(err, _webstrateId) {
									if (err) {
										console.error(err);
										return reject(err);
									}
									createdWebstrate = true;
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
									originalname: entry.fileName.match(/([^/]+)$/)[0],
									size: entry.uncompressedSize,
									mimetype: mime.lookup(entry.fileName)
								});
							});
						}
					});
				}
			});

			function addAssetsToWebstrateOrDeleteTheAssets() {
				if (!createdWebstrate) {
					assets.forEach(asset => {
						fs.unlink(assetManager.UPLOAD_DEST + asset.filename, () => {});
					});
					if (htmlDocumentFound) {
						reject('index.html found, but unable to create webstrate from it. Aborting.');
					} else {
						reject('No index.html found.');
					}
				}

				var source = `${req.user.userId} (${req.remoteAddress})`;
				// Assets ending in .searchable aren't real assets, but just an indication that
				// the asset they're referring to should be searchable. E.g. if two assets
				// data.csv and data.csv.searchable are uploaded, the ladder just serves to let us
				// know that the former should be made searchable.
				let searchables = assets.filter(asset =>
					asset.originalname.endsWith('.searchable'));

				// Remove dummy files from assets list.
				assets = assets.filter(asset =>
					!asset.originalname.endsWith('.searchable'));

				// Delete the dummy files from the system.
				searchables.forEach(asset => {
					fs.unlink(assetManager.UPLOAD_DEST + asset.filename, () => {});
				});

				// Now create a simple list (no objects) of the asset names that should be
				// searchable. We remember to remove the 11-character long '.searchable' prefix.
				searchables = searchables.map(asset => asset.originalname.slice(0, -11));
				assetManager.addAssets(webstrateId, assets, searchables, source,
					(err, assetRecords) => {
						accept(webstrateId);
					});
			}

			zipFile.once('end', function() {
				zipFile.close();

				// If the webstrate has been created, we continue to add assets.
				if (createdWebstrate) {
					return addAssetsToWebstrateOrDeleteTheAssets();
				}

				// If no webstrateId exists, either the creation of the webstrate failed or we're waiting
				// on mongodb. Eiter way, we give mongodb 500ms to figure it out.
				setTimeout(addAssetsToWebstrateOrDeleteTheAssets, 500);
			});

			zipFile.readEntry();
		});
	});
}