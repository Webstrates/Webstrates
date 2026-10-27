'use strict';

const { ZipArchive, TarArchive } = require('archiver');
const ARCHIVE_FORMATS = { zip: ZipArchive, tar: TarArchive };
const crypto = require('crypto');
const fs = require('graceful-fs');
const http = require('http');
const https = require('https');
const jsonmlTools = require('jsonml-tools');
const htmlToJsonML = require('html-to-jsonml');
const mime = require('mime-types');
const multer = require('multer');
const os = require('os');
const shortId = require('shortid');
const util = require('util');
const tmp = require('tmp');
const url = require('url');
const yauzl = require('yauzl');
const zlib = require('zlib');
const SELFCLOSING_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen',
	'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'];

const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const niceWebstrateIds = require(APP_PATH + '/helpers/niceWebstrateIds.js');
const snapshotCacheManager = require(APP_PATH + '/helpers/SnapshotCacheManager.js');
const invites = require(APP_PATH + '/middleware/userInvites.js');

const PROTOTYPE_URL_FETCH_TIMEOUT_MS = 30000;
const MAX_PROTOTYPE_URL_RAW_SIZE = (config.maxPrototypeUrlRawSize || 100) * 1024 * 1024;
const MAX_PROTOTYPE_URL_DECODED_SIZE = (config.maxPrototypeUrlDecodedSize || 100) * 1024 * 1024;

let prototypeUrlWhitelistCache = null;

/**
 * The compiled prototypeUrl whitelist: the regexes of
 * config.prototypeUrlWhitelist (an array of regular expressions as strings).
 * The out-of-the-box default lives in config-sample.json — the sample is
 * merged under every configuration, so a key that is absent or explicitly
 * empty inherits its entry from there — while a non-array value yields no
 * patterns at all (nothing is whitelisted).
 * Patterns are substring tests against the normalized href of the requested
 * URL (and of every redirect hop), so anchors are what make them precise:
 * start them with ^, and terminate a hostname with its path delimiter (e.g.
 * ^https://host[.]com/) — a pattern that stops at the hostname also admits
 * lookalike hosts (host.evil.example) and ports the operator never named.
 * Invalid patterns are reported and skipped (an empty pattern would compile
 * but match every URL — never a whitelist entry); if no pattern remains
 * valid, nothing is whitelisted (to deny every remote prototype, configure
 * a pattern that can never match, e.g. "(?!)"). Patterns run synchronously
 * against request-controlled URLs, so avoid backtracking shapes like
 * (a|a)* — a catastrophic pattern freezes the whole server on one request.
 * @return {RegExp[]} Compiled whitelist patterns.
 * @private
 */
function getPrototypeUrlWhitelist() {
	if (prototypeUrlWhitelistCache) return prototypeUrlWhitelistCache;
	if (config.prototypeUrlWhitelist !== undefined && !Array.isArray(config.prototypeUrlWhitelist)) {
		console.warn('config.prototypeUrlWhitelist is not an array; no URL is whitelisted.');
	}
	const configured = Array.isArray(config.prototypeUrlWhitelist)
		? config.prototypeUrlWhitelist : [];
	const patterns = [];
	for (const pattern of configured) {
		if (typeof pattern !== 'string' || pattern.length === 0) {
			console.warn('Ignoring invalid prototypeUrlWhitelist pattern:', pattern);
			continue;
		}
		try {
			patterns.push(new RegExp(pattern));
		} catch (err) {
			console.warn('Ignoring invalid prototypeUrlWhitelist pattern:', pattern, err.message);
		}
	}
	prototypeUrlWhitelistCache = patterns;
	return prototypeUrlWhitelistCache;
}

/**
 * Validate a prototypeUrl request parameter: only http(s) URLs matching one
 * of the whitelist patterns (see getPrototypeUrlWhitelist) may be fetched.
 * The URL is parsed first, so the patterns match the normalized href the
 * fetch would actually request — the URL parser lowercases hostnames and
 * drops default ports, leaving no notation to smuggle a host past an
 * anchored pattern. Redirect hops validate through the same path: a
 * Location resolves against the current URL (relative Locations included),
 * so an unparseable or non-whitelisted destination surfaces the same
 * curated errors as the original request.
 * @param  {string} requestedUrl URL requested by the user, or a redirect
 *                               Location to resolve.
 * @param  {URL}    [baseUrl]    Current URL to resolve a redirect Location
 *                               against; omit for the original request.
 * @return {URL}                 Parsed, whitelisted URL.
 * @throws {Error}               If the URL is invalid, not http(s), or not
 *                               whitelisted.
 * @private
 */
function validatePrototypeUrl(requestedUrl, baseUrl) {
	let parsedUrl;
	try {
		parsedUrl = new URL(requestedUrl, baseUrl);
	} catch (err) {
		throw new Error('Invalid prototypeUrl.', { cause: err });
	}

	if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
		throw new Error('prototypeUrl must be an http(s) URL.');
	}

	if (!getPrototypeUrlWhitelist().some(pattern => pattern.test(parsedUrl.href))) {
		throw new Error('Refusing to fetch prototypeUrl outside the whitelist: ' + parsedUrl.href);
	}

	return parsedUrl;
}

/**
 * Decompress a prototypeUrl response body through an already-created zlib
 * decoder, counting the decoded bytes as the stream produces them (the
 * decompression-side counterpart of the ZIP import's byte counting): the
 * moment the output crosses MAX_PROTOTYPE_URL_DECODED_SIZE, the decoder is
 * destroyed mid-expansion and the fetch rejected — instead of letting a
 * tiny compressed body expand to any size in memory.
 * @param  {Buffer}          buffer  Raw (still compressed) body bytes.
 * @param  {zlib.Gunzip|zlib.Inflate|zlib.InflateRaw} decoder Decoder created
 *                                  by the caller, so the encoding choice
 *                                  stays visible at the dispatch site.
 * @return {Promise<Buffer>}         Decoded body.
 * @throws {Error}                   When the body cannot be decoded, or
 *                                  expands beyond the decoded-size limit
 *                                  (such errors carry
 *                                  err.decodedLimitExceeded = true).
 * @private
 */
function decompressPrototypeUrlBody(buffer, decoder) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let decodedSize = 0;
		let aborted = false;
		const abort = (err) => {
			if (aborted) return;
			aborted = true;
			decoder.destroy();
			reject(err);
		};
		decoder.on('data', (chunk) => {
			if (aborted) return;
			chunks.push(chunk);
			decodedSize += chunk.length;
			if (decodedSize > MAX_PROTOTYPE_URL_DECODED_SIZE) {
				const err = new Error('prototypeUrl body expands beyond the maximum decoded size of ' +
					`${MAX_PROTOTYPE_URL_DECODED_SIZE / 1024 / 1024} MB.`);
				err.decodedLimitExceeded = true;
				abort(err);
			}
		});
		decoder.once('error', abort);
		decoder.once('end', () => {
			if (!aborted) resolve(Buffer.concat(chunks));
		});
		decoder.end(buffer);
	});
}

/**
 * Decode a prototypeUrl response body the way fetch() does for the
 * encodings we request (gzip, deflate). Anything else passes through
 * undecoded exactly as before (mislabeled bodies are then inert and stay
 * bounded by the raw-size limit).
 * @param  {Buffer}          buffer  Raw body bytes.
 * @param  {string}          encoding Content-Encoding header value.
 * @return {Promise<Buffer>}         Decoded body.
 * @throws {Error}                   If the body cannot be decoded.
 * @private
 */
async function decodePrototypeUrlBody(buffer, encoding) {
	const enc = String(encoding || '').trim().toLowerCase();
	if (enc === 'gzip') {
		return decompressPrototypeUrlBody(buffer, zlib.createGunzip());
	}
	if (enc === 'deflate') {
		try {
			return await decompressPrototypeUrlBody(buffer, zlib.createInflate());
		} catch (err) {
			// Only decode errors fall back to raw deflate — a body that
			// crossed the decoded limit would only burn the same limit again.
			if (err && err.decodedLimitExceeded) throw err;
			return decompressPrototypeUrlBody(buffer, zlib.createInflateRaw());
		}
	}
	return buffer;
}

/**
 * fetch()-compatible response over an http(s) response: status/statusText/
 * ok, case-insensitive header lookup, arrayBuffer() and text().
 * @param  {http.IncomingMessage} response Node response object.
 * @param  {Buffer}                buffer   Decoded body bytes.
 * @private
 */
class PrototypeUrlResponse {
	constructor(response, buffer) {
		this.status = response.statusCode;
		this.statusText = response.statusMessage || http.STATUS_CODES[response.statusCode] || '';
		this.ok = this.status >= 200 && this.status < 300;
		const headers = response.headers;
		this.headers = {
			get: (name) => {
				if (!name) return null;
				const value = headers[name.toLowerCase()];
				return value === undefined ? null : (Array.isArray(value) ? value.join(', ') : value);
			}
		};
		this.body = buffer;
	}

	arrayBuffer() {
		return Promise.resolve(new Uint8Array(this.body).buffer);
	}

	text() {
		return Promise.resolve(this.body.toString('utf8'));
	}
}

/**
 * Fetch one whitelisted prototypeUrl hop over http(s).request, with
 * gzip/deflate decoding and a hard timeout. The fetch is capped as it runs
 * on both axes (MAX_PROTOTYPE_URL_RAW_SIZE on the wire,
 * MAX_PROTOTYPE_URL_DECODED_SIZE after decoding). Connections are not pooled
 * (agent: false), so no prototypeUrl socket is ever reused by anything else.
 * @param  {URL} url Whitelisted URL (from validatePrototypeUrl).
 * @return {Promise<PrototypeUrlResponse>}
 * @private
 */
function requestPrototypeUrl(url) {
	const transport = url.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request(url, {
			agent: false,
			headers: { 'accept-encoding': 'gzip, deflate' }
		}, (response) => {
			const chunks = [];
			let rawSize = 0;
			// The fetch-side counterpart of abortZipImport: settle once, then
			// clear the timer and tear the socket down so no further bytes are
			// received. Rejecting before the destroy makes the cap message
			// deterministically win the settle race against the generic
			// 'aborted'/'error' events that the destroy triggers.
			let aborted = false;
			const abortPrototypeUrlFetch = (err) => {
				if (aborted) return;
				aborted = true;
				reject(err);
				clearTimeout(timer);
				request.destroy();
			};
			response.on('data', (chunk) => {
				chunks.push(chunk);
				rawSize += chunk.length;
				if (rawSize > MAX_PROTOTYPE_URL_RAW_SIZE) {
					abortPrototypeUrlFetch(new Error(
						'prototypeUrl response exceeds the maximum raw size of ' +
						`${MAX_PROTOTYPE_URL_RAW_SIZE / 1024 / 1024} MB.`));
				}
			});
			response.on('error', reject);
			response.on('aborted', () => reject(new Error('prototypeUrl fetch aborted.')));
			response.on('end', async () => {
				clearTimeout(timer);
				try {
					// Redirect-hop bodies are never read (fetchPrototypeUrl
					// consumes only the Location header), so decoding them
					// would only let the sending side spend our CPU; they stay
					// raw — and raw-capped.
					const body = (response.statusCode >= 300 && response.statusCode < 400)
						? Buffer.concat(chunks)
						: await decodePrototypeUrlBody(Buffer.concat(chunks),
							response.headers['content-encoding']);
					// A settle that raced the decode (e.g. the raw cap tripping
					// on the last chunk) must not be overwritten — the re-check
					// keeps the promise on its first verdict.
					if (aborted) return;
					resolve(new PrototypeUrlResponse(response, body));
				} catch (err) {
					reject(err);
				}
			});
		});
		const timer = setTimeout(() => {
			request.destroy(new Error('prototypeUrl fetch timed out.'));
		}, PROTOTYPE_URL_FETCH_TIMEOUT_MS);
		request.on('error', reject);
		request.end();
	});
}

/**
 * Fetch a prototypeUrl after whitelist-checking every hop: redirects are
 * followed manually, and each redirect target is checked against the
 * whitelist the same way as the original URL, so a redirect cannot lead the
 * fetch outside the whitelisted servers.
 * @param  {string} requestedUrl URL requested by the user.
 * @return {PrototypeUrlResponse} Fetched response (a non-2xx response is an error).
 * @throws {Error}                On invalid destinations or failed fetches.
 * @private
 */
async function fetchPrototypeUrl(requestedUrl) {
	let current = validatePrototypeUrl(requestedUrl);

	for (let redirects = 0; redirects < 5; redirects++) {
		const response = await requestPrototypeUrl(current);
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			current = validatePrototypeUrl(location, current);
			continue;
		}
		if (!response.ok) {
			throw new Error('Invalid request. Received: ' + response.status + ' ' + response.statusText);
		}
		return response;
	}
	throw new Error('Too many redirects for prototypeUrl.');
}

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
	return res.redirect('/frontpage/');
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
 * Extracts a version or tag from a string.
 * @param  {string} versionOrTag Version or tag.
 * @return {obj}                 Object with one property, either version or tag.
 * @private
 */
function extractVersionOrTag(versionOrTag) {
	var version, tag;
	if (versionOrTag === '') {
		version = '';
	} else if (/^\d+$/.test(versionOrTag)) {
		// Version 0 is a valid version, so it mustn't be coerced to undefined by testing
		// the truthiness of the parsed number.
		version = Number(versionOrTag);
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
		snapshot.data[0] !== 'html' || !snapshot.data[1] || !snapshot.data[1]['data-cors']) {
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
	yauzl.open(assetManager.UPLOAD_DEST + fileName, { lazyEntries: true }, (err, zipFile) => {
		if (err || !zipFile) {
			return reject(new Error(`"${fileName}" is not a valid ZIP file.`));
		}
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
	// assetName (+ assetPath)
	if ('asset' in req.params) {
		req.params.assetName = req.params.asset;
		if (req.params.extension) req.params.assetName += '.' + req.params.extension;
		if (req.params.assetPath) req.params.assetPath = req.params.assetPath.join('/');
	}

	// version (number) or tag (string)
	if ('versionOrTag' in req.params) {
		if (/^-?\d+$/.test(req.params.versionOrTag)) {
			req.params.version = Number(req.params.versionOrTag);
		} else {
			req.params.tag = req.params.versionOrTag;
		}
	}

	if ('assetOrVersionOrTag' in req.params) {
		if (req.params.assetOrVersionOrTag.includes('.')) {
			// If assetOrVersionOrTag contains a dot it is an asset
			req.params.assetName = req.params.assetOrVersionOrTag;
		} else if (/^-?\d+$/.test(req.params.assetOrVersionOrTag)) {
			// If it is a number it is a version
			req.params.version = Number(req.params.assetOrVersionOrTag);
			req.params.versionOrTag = req.params.assetOrVersionOrTag;
		} else {
			// Otherwise we need to check in the request handler if there is a tag
			try {
				const version = await documentManager.getVersionFromTag(req.params.webstrateId,
					req.params.assetOrVersionOrTag);
				// Version 0 is a valid version for a tag to sit on, so presence must be
				// tested against undefined, not with truthiness.
				if (version !== undefined && version !== null && !Number.isNaN(version)) {
					req.params.versionOrTag = req.params.assetOrVersionOrTag;
					req.params.tag = req.params.assetOrVersionOrTag;
				}
			} catch (e) {
				// Tag doesn't exist, so assetOrVersionOrTag must be an asset name.
				req.params.assetName = req.params.assetOrVersionOrTag;
			}
		}
	}

	// Support for legacy syntax: /<webstrateId>?v=<versionOrTag>, which is equivalent to
	// /<webstrateId>/<versionOrTag>/?copy.
	if (req.query.v && !req.params.versionOrTag) {
		const version = req.query.v;
		delete req.query.v;
		return res.redirect(url.format({
			pathname: `/${req.params.webstrateId}/${version}/`,
			query: req.query
		}));
	}

	try {
		// First check any invite keys - before permissions are fetched
		if ('acceptInvite' in req.query){
			await invites.prepareAPIAccess(req.user);
			await invites.invitee.acceptInvite(req.params.webstrateId, req.query.acceptInvite, req.user);
		}

		const snapshot = await documentManager.getDocument({
			webstrateId: req.params.webstrateId,
			version: req.params.version,
			tag: req.params.tag
		});

		req.user.permissions = await permissionManager.getUserPermissionsFromSnapshot(req.user.username,
			req.user.provider, snapshot);

		// If the webstrate doesn't exist, write permissions are required to create it.
		if (!snapshot.type && !permissionManager.canWrite(req.user.permissions)) {
			return res.status(403).send(
				'Insufficient permissions. Write is required to create a new webstrate.');
		}

		// If the webstrate does exist, read permissions are required to access it (or any of its
		// assets).
		if (!permissionManager.canRead(req.user.permissions)) {
			return res.status(403).send(
				'Insufficient permissions. Read is required to access this webstrate.');
		}

		// Set CORS header on a response, assuming the requesting host is allowed it.
		setCorsHeaders(req, res, snapshot);

		// Requesting an asset.
		if (req.params.assetName) {
			try {
				const asset = await assetManager.getAsset({
					webstrateId: req.params.webstrateId,
					assetName: req.params.assetName,
					version: snapshot.v
				});

				if (!asset) {
					return res.status(404).send(`Asset "${req.params.assetName}" not found.`);
				}

				// An asset record can lose sync — the ?dl download path already heals
				// such records). Serving a
				// dead record through any of the paths below would 500 through sendFile's
				// error path or misreport the failure; report it as what it is — a missing
				// asset
				const assetFilePath = `${assetManager.UPLOAD_DEST}${asset.fileName}`;
				if (!fs.existsSync(assetFilePath)) {
					return res.status(404).send(`Asset "${req.params.assetName}" is currently ` +
						'unavailable (its file is missing).');
				}

				if ('dir' in req.query) {
					const zipStructure = await getZipStructure(asset.fileName);
					res.json(zipStructure);
					return;
				}

				if (req.params.assetPath) {
					return yauzl.open(assetManager.UPLOAD_DEST + asset.fileName, { lazyEntries: true },
						(err, zipFile) => {
							if (err) {
								return res.status(400).send(`"${req.params.assetName}" is not a valid ZIP file.`);
							}
							zipFile.on('entry', async entry => {
								if (req.params.assetPath !== entry.fileName) {
									return zipFile.readEntry();
								}

								// If requested file is a directory, list directory files.
								if (entry.fileName.endsWith('/')) {
									try {
										const zipStructure = await getZipStructure(asset.fileName);
										const filteredZipStructure = zipStructure.filter(path =>
											path.startsWith(entry.fileName));
										return res.json(filteredZipStructure);
									} catch (err) {
										return res.status(400).send(`"${req.params.assetName}" is not a ` +
											'valid ZIP file.');
									}
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
								res.status(404).send(`File "${req.params.assetPath}" not found in asset ` +
									`"${req.params.assetName}".\n`);
							});
						});
				}

				// `/<webstrateId>/<asset>` may not always refer to the same asset, but to optimize rapid
				// requests, we set a maxAge anyway. If the requested asset includes a specific version,
				// it'll always refer to the same thing, allowing us to set a longer maxAge.
				var maxAge = req.params.version ? '1y' : (config.maxAge || '1m');
				res.type(asset.mimeType);
				return res.sendFile(assetFilePath, { maxAge });
			} catch (error) {
				console.error(error);
				return res.status(409).send(String(error));
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
			if (!permissionManager.canWrite(defaultPermissions)) {
				return res.status(403).send('Write permissions are required to create a new document.');
			}
			return copyWebstrate(req, res, snapshot);
		}

		// Requesting to restore document to a previous version or tag by calling:
		// `/<id>/?restore=<version|tag>`.
		if ('restore' in req.query) {
			if (!permissionManager.canWrite(req.user.permissions)) {
				return res.status(403).send('Write permissions are required to restore a document.');
			}

			// If the document contains a user with admin permissions, only admins can restore the
			// document.
			if (!req.user.permissions.includes('a') &&
				await permissionManager.webstrateHasAdmin(req.params.webstrateId)) {
				return res.status(403).send('Admin permissions are required to restore this document.');
			}

			return await restoreWebstrate(req, res, snapshot);
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

			if (!permissionManager.canWrite(req.user.permissions)) {
				return res.status(403).send('Write permissions are required to delete a document.');
			}

			// If the document contains a user with admin permissions, only admins can delete the
			// document.
			if (!req.user.permissions.includes('a') &&
				await permissionManager.webstrateHasAdmin(req.params.webstrateId)) {
				return res.status(403).send('Admin permissions are required to delete this document.');
			}

			return deleteWebstrate(req, res);
		}

		// We don't need to check for "static" in req.query, because this happens on the client side.

		return serveWebstrate(req, res);
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
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
async function serveOps(req, res) {
	try {
		res.json(await documentManager.getOps({
			webstrateId: req.params.webstrateId,
			version: Number(req.params.version || req.query.to) || undefined,
			initialVersion: Number(req.query.from) || undefined
		}));
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

/**
 * Requesting a list of tags by calling `/<id>?tags`.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
function serveTags(req, res) {
	documentManager.getTags(req.params.webstrateId, function(err, tags) {
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
async function serveAssets(req, res) {
	try {
		let latestOnly = 'latest' in req.query;
		return res.json(await assetManager.getAssets(req.params.webstrateId, latestOnly));
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
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
	if (req.params.version) {
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
async function serveCompressedWebstrate(req, res, snapshot) {
	try {
		// We pass along the version being served, so downloading an old version or a tag archives the
		// assets that were alive back then, rather than the ones that exist right now.
		let assets = await assetManager.getCurrentAssets(req.params.webstrateId, snapshot.v);
		const format = req.query.dl === 'tar' ? 'tar' : 'zip';
		const archive = new ARCHIVE_FORMATS[format]({ store: true });
		archive.append('<!doctype html>\n' + jsonmlTools.toXML(snapshot.data, SELFCLOSING_TAGS),
			{ name: `${req.params.webstrateId}/index.html` });

		assets.forEach(function(asset) {
			const filePath = `${assetManager.UPLOAD_DEST}${asset.fileName}`;
			if (fs.existsSync(filePath)) {
				archive.file(filePath,
					{ name: `${req.params.webstrateId}/${asset.originalFileName}` });

				// If the file is searchable, we create a dummy file with the contents 'searchable', so we
				// know to make the file searchable if the archive is uploaded again (or to another server).
				if (asset.searchable) {
					archive.append('searchable',
						{ name: `${req.params.webstrateId}/${asset.originalFileName}.searchable` });
				}
			} else {
				console.warn(`Asset ${filePath} (${asset.originalFileName}) for Webstrate ` +
					`${req.params.webstrateId} is currently unavailable on disk.`);
			}
		});
		archive.finalize();
		const potentialTag = req.params.tag ? ('-' + req.params.tag) : '';
		const filename = req.query.filename ||
			`${req.params.webstrateId}-${snapshot.v}${potentialTag}.${format}`;
		res.attachment(filename);
		archive.pipe(res);
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

function serveTokenList(req, res) {
	// P-203 fix: access tokens grant the permissions of the user who generated
	// them - including admin - so a token listing must never disclose another
	// user's token. Users with admin permissions on the webstrate may list all
	// of its tokens; everyone else only gets the tokens they created themselves
	// (i.e. tokens with a matching username and provider). The generic read
	// check that got us here is not enough: it would let a read-only (or
	// anonymous) user harvest a privileged user's token and take over the
	// document.
	const tokens = permissionManager.getAccessTokens(req.params.webstrateId);

	// Admins get the full listing.
	if (req.user.permissions && req.user.permissions.includes('a')) {
		return res.json(tokens);
	}

	// Everyone else only gets their own tokens.
	const ownTokens = {};
	for (const token in tokens) {
		if (tokens[token].username === req.user.username &&
			tokens[token].provider === req.user.provider) {
			ownTokens[token] = tokens[token];
		}
	}

	res.json(ownTokens);
}

/**
 * Copy a webstrate by calling `/<id>?copy[=newWebstrateId]`.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
async function copyWebstrate(req, res, snapshot) {
	try {
		let webstrateId = req.query.copy || await generateWebstrateId(req);

		// If user doesn't have write permissions to the docuemnt, add them if the user is logged in,
		// otherwise just delete all permissions on the new document. Note: this is a literal check
		// for the 'w' letter on purpose. Admin permissions are stripped from the new snapshot below
		// (removeAdminPermissionsFromSnapshot), so an 'a'-only user must be granted 'rw' here to
		// not lose access to their own copy — using canWrite() instead would lock them out.
		if (!req.user.permissions.includes('w')) {
			if (req.user.username === 'anonymous' && req.user.provider === '') {
				snapshot = permissionManager.clearPermissionsFromSnapshot(snapshot);
			} else {
				snapshot = await permissionManager.setUserPermissionsInSnapshot(req.user.username,
					req.user.provider, 'rw', snapshot);
			}
		}

		// Remove all admin permissions from the new snapshot.
		snapshot = await permissionManager.removeAdminPermissionsFromSnapshot(snapshot);
		await documentManager.createNewDocument({ webstrateId, snapshot });
		
		// Also copy over all the assets. Note that we pass through snapshot.v, because we know this
		// will always be set, even if no version is specified, or the user is accessing the webstrate
		// through a tag.
		await assetManager.copyAssets({
			fromWebstrateId: req.params.webstrateId,
			toWebstrateId: webstrateId,
			version: snapshot.v
		});

		// Clone the query into a writeable object to remove ?copy to avoid infinite loops
		let newQuery = Object.assign({}, req.query);
		delete newQuery.copy;
		return res.redirect(url.format({
			pathname:`/${webstrateId}/`,
			query: newQuery
		}));
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

/**
 * Restore a webstrate to a previous version or tag and redirect the user to the document.
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
async function restoreWebstrate(req, res, snapshot) {
	// There shouldn't be a version or tag in the first part of the URL, i.e.
	// `/<id>/<version|tag>/?restore` is not allowed. (Version 0 is a valid version, so
	// presence must be tested against undefined, not with truthiness.)
	if (req.params.version !== undefined || req.params.tag !== undefined) {
		return res.status(409).send('Can not restore a document at a previous tag or version.' +
			// eslint-disable-next-line max-len
			` Did you mean <code><a href="/${req.params.webstrateId}/?restore=${req.params.versionOrTag}">` +
			`/${req.params.webstrateId}/?restore=${req.params.versionOrTag}</a></code>?`);
	}

	// A version or tag in the query string, however, should be defined. (Version 0 is a
	// valid version, so presence must be tested against undefined, not with truthiness;
	// the empty string is the explicitly invalid `?restore` with no value.)
	var { version, tag } = extractVersionOrTag(req.query.restore);
	if ((version === undefined || version === '') && !tag) {
		return res.status(409).send('No tag or version defined.');
	}

	// Ops always have a source (src) set by the client when the op comes in. This source is
	// usually the websocket clientId, but this is a regular HTTP request, so there is no
	// clientId. We'll just use the userId instead.
	var source = req.user.userId;
	try {
		let newVersion = await documentManager.restoreDocument(
			{ webstrateId: req.params.webstrateId, version, tag },
			source);

		// Also restore assets, so the restored version shows the old assets, not the new ones.
		await assetManager.restoreAssets(
			{ webstrateId: req.params.webstrateId, version, tag, newVersion });

		let newQuery = Object.assign({}, req.query);
		delete newQuery.restore;
		return res.redirect(url.format({
			pathname:`/${req.params.webstrateId}/`,
			query: newQuery
		}));
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

/**
 * Delete the assets of a webstrate, then the delete the webstrate itself, and redirect the user
 * to the root (`/`).
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
async function deleteWebstrate(req, res) {
	var source = req.user.userId;

	try {
		await assetManager.deleteAssets(req.params.webstrateId);
		await documentManager.deleteDocument(req.params.webstrateId, source);
		snapshotCacheManager.removeEntry(req.params.webstrateId);
		// Mark this deletion in the deleting browser, so the deleting browser's own
		// clients can tell their delete redirect apart from one triggered by another
		// client: the ?delete response already navigates this browser to /, and the
		// client's own (redundant) redirect would race and abort that navigation. The
		// cookie is short-lived — it only needs to survive the few hundred
		// milliseconds until the clients' deferred redirect decision (see
		// client/webstrates/deleteEvent.js).
		res.cookie(`webstrates-deleted-${req.params.webstrateId}`, '1',
			{ maxAge: 10000, httpOnly: false });
		res.redirect('/');
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

/**
 * Requesting a webstrate by calling /<id>.
 * @param {obj} req Express request object.
 * @param {obj} res Express response object.
 * @private
 */
function serveWebstrate(req, res) {
	// The skeleton HTML is tiny, but it is what ties a page to a specific client bundle
	// (webstrates_<hash>.js): never cache it
	res.set('Cache-Control', 'no-store');
	return res.sendFile(APP_PATH + '/static/client.html', { cacheControl: false });
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
		// --- ?prototypeUrl guard ------------------------------------------------
		//
		// prototypeUrl lets a client make the server fetch a URL, so the fetch
		// is wrapped in two defenses:
		//   1. Only http(s) URLs matching one of the whitelist regexes in
		//      config.prototypeUrlWhitelist are fetched. Redirects are
		//      followed manually and every hop is whitelist-checked the same
		//      way, so a redirect cannot lead the fetch outside the whitelisted
		//      servers.
		//   2. The fetched body is capped as it arrives on both axes — raw wire
		//      bytes (maxPrototypeUrlRawSize) and gzip/deflate-decoded bytes
		//      (maxPrototypeUrlDecodedSize) — so a compressed response cannot
		//      expand unbounded in memory.
		try {
			// Fetch remote data (whitelist-checked on every redirect hop).
			const response = await fetchPrototypeUrl(req.query.prototypeUrl);
			const contentType = response.headers.get('content-type');
			const contentDisposition = response.headers.get('content-disposition');

			// Handle zip files
			if (contentType === 'application/zip' ||
                contentType === 'application/x-zip-compressed' ||
                (contentDisposition && contentDisposition.match(/(filename=\*?)(.*)\.zip$/i))) {

				const arrayBuffer = await response.arrayBuffer();
				const buffer = Buffer.from(arrayBuffer); // Convert ArrayBuffer to Node.js Buffer

				return tmp.file((err, filePath, fd, cleanUpCallback) => {
					if (err) {
						console.error(err);
						return res.status(409).send(String(err));
					}
					return fs.writeFile(filePath, buffer, async err => {
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

			// Handle HTML files
			if ((contentType && contentType.startsWith('text/html')) ||
                (contentDisposition && contentDisposition.match(/(filename=\*?)(.*)\.html?$/i))) {
				const body = await response.text();
				const jsonml = htmlToJsonML(body);
				const webstrateId = req.query.id || await generateWebstrateId(req);
				try {
					await documentManager.createNewDocument({
						webstrateId: webstrateId,
						snapshot: {
							type: 'http://sharejs.org/types/JSONv0',
							data: jsonml
						}
					});
				} catch (err) {
					console.error(err);
					return res.status(409).send(String(err));
				}

				delete req.query.prototypeUrl;
				delete req.query.id;
				return res.redirect(url.format({
					pathname: `/${webstrateId}/`,
					query: req.query
				}));
			}

			res.status(405).send('Can only prototype from text/html or application/zip sources. ' +
                'Received file with content-type: ' + contentType);

		} catch (err) {
			console.error(err);
			return res.status(409).send(String(err));
		}
	}

	var defaultPermissions = permissionManager.getDefaultPermissions(req.user.username,
		req.user.provider);

	// If the user has no default write permissions, they're not allowed to create documents.
	if (!permissionManager.canWrite(defaultPermissions)) {
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
				{ error: `Maximum file size exceeded (${(config.maxAssetSize || 20)} MB).` }
				// Serialize the message (multer attaches an enumerable `storageErrors` property to
				// the file filter's Error, and res.json(err) would only show that).
				: { error: err.message || String(err) });
		}

		if (!req.file) {
			return res.status(409).json({
				error: 'No file received.'
			});
		}

		if (req.file.mimetype !== 'application/zip'
			&& req.file.mimetype !== 'application/x-zip-compressed'
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
 * Limits for importing webstrates from ZIP files (avoid zip bombs).
 * Importing a webstrate from a ZIP extracts every entry straight to disk, but
 * maxAssetSize only bounds the *compressed* upload, so a ~100 KB archive could
 * expand to >100 MB — arbitrarily more, given the right ratio — on disk with a
 * single request. The extraction itself is therefore capped on two axes,
 * both configurable in config.json:
 *   maxZipEntries          — maximum number of entries per archive.
 *   maxZipUncompressedSize — maximum total uncompressed size, in MB.
 * @constant
 */
const MAX_ZIP_ENTRIES = config.maxZipEntries || 1000;
const MAX_ZIP_UNCOMPRESSED_SIZE = (config.maxZipUncompressedSize || 250) * 1024 * 1024;

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
			if (err || !zipFile) {
				console.error(err);
				return reject(err || new Error(`"${filePath}" is not a valid ZIP file.`));
			}

			let htmlDocumentFound = false, createdWebstrate = false;
			let assets = [];

			// An archive that violates
			// any of the MAX_ZIP_* limits — or errors while being read — is aborted:
			// in-flight streams are destroyed, everything already extracted is removed,
			// and the import is rejected, instead of letting a tiny archive expand to
			// hundreds of MBs on disk.
			let aborted = false;
			let entryCount = 0;
			let declaredUncompressedSize = 0;
			let extractedUncompressedSize = 0;
			let extractedFiles = [];
			let currentReadStream, currentWriteStream;

			const abortZipImport = (reason) => {
				if (aborted) return;
				aborted = true;
				if (currentReadStream) {
					currentReadStream.unpipe();
					currentReadStream.destroy();
				}
				if (currentWriteStream) {
					currentWriteStream.destroy();
				}
				zipFile.close();
				// Remove whatever the archive managed to extract before we aborted.
				extractedFiles.forEach(file => fs.unlink(file, () => {}));
				reject(new Error(reason));
			};

			// Count uncompressed bytes as they are actually
			// extracted, in case an entry's declared size in the central directory
			// lies (yauzl's validateEntrySizes also guards this and makes the entry
			// stream emit an error — handled below — this is defense in depth).
			// Attached where the stream is consumed, at pipe() or streamToString(),
			// so no data is read before a consumer exists.
			const countExtractedBytes = (readStream) => {
				readStream.on('data', chunk => {
					extractedUncompressedSize += chunk.length;
					if (extractedUncompressedSize > MAX_ZIP_UNCOMPRESSED_SIZE) {
						abortZipImport('ZIP file expands beyond the maximum uncompressed size of ' +
							`${MAX_ZIP_UNCOMPRESSED_SIZE / 1024 / 1024} MB.`);
					}
				});
			};

			// Errors on the archive itself (e.g. a corrupt central directory) would
			// otherwise go unhandled and leave the import hanging.
			zipFile.on('error', err => {
				console.error(err);
				abortZipImport(`ZIP file is corrupt: ${err.message}`);
			});

			zipFile.on('entry', entry => {
				if (aborted) return;

				// Before extracting anything, reject archives
				// declaring too many entries or more uncompressed content than
				// allowed. yauzl validates the declared sizes while extracting.
				entryCount++;
				declaredUncompressedSize += entry.uncompressedSize;
				if (entryCount > MAX_ZIP_ENTRIES) {
					return abortZipImport('ZIP file contains too many entries (more than ' +
						`${MAX_ZIP_ENTRIES}).`);
				}
				if (declaredUncompressedSize > MAX_ZIP_UNCOMPRESSED_SIZE) {
					return abortZipImport('ZIP file expands beyond the maximum uncompressed size ' +
						`of ${MAX_ZIP_UNCOMPRESSED_SIZE / 1024 / 1024} MB.`);
				}

				if (/\/$/.test(entry.fileName)) {
				// Directory file names end with '/'.
				// Note that entries for directories themselves are optional.
				// An entry's fileName implicitly requires its parent directories to exist.
					zipFile.readEntry();
				} else {
				// file entry
					zipFile.openReadStream(entry, (err, readStream) => {
						if (err || !readStream) {
							console.error(err);
							return abortZipImport(`Could not read "${entry.fileName}" from ZIP file.`);
						}
						currentReadStream = readStream;
						readStream.on('end', function() {
							currentReadStream = currentWriteStream = null;
							zipFile.readEntry();
						});
						// Errors on the entry stream (e.g. yauzl detecting that an entry's
						// contents don't match its declared size, or corrupt deflate data)
						// would otherwise go unhandled.
						readStream.on('error', err => {
							console.error(err);
							abortZipImport(`Could not extract "${entry.fileName}" from ZIP file: ` +
								`${err.message}`);
						});

						if (!htmlDocumentFound && entry.fileName.match(/index\.html?$/i)) {
							htmlDocumentFound = true;
							countExtractedBytes(readStream);
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
								// If user doesn't have write permissions to the document, add them if
								// the user is logged in, otherwise just delete all permissions on the
								// new document. (Note: admin permissions imply write, so a user with
								// only "a" permissions keeps them as-is here — unlike ?copy, no admin
								// permissions are stripped from imported documents.)
								if (!permissionManager.canWrite(userPermissions)) {
									if (req.user.username === 'anonymous' && req.user.provider === '') {
										snapshot = permissionManager.clearPermissionsFromSnapshot(snapshot);
									} else {
										snapshot = await permissionManager
											.setUserPermissionsInSnapshot(req.user.username, req.user.provider,
												'rw', snapshot);
									}
								}
								try {
									await documentManager.createNewDocument({webstrateId, snapshot});
								} catch (err){
									console.error(err);
									return reject(err);
								}
								createdWebstrate = true;
							});
						} else {
							crypto.randomBytes(16, (err, raw) => {
								if (aborted) return;
								const fileName =  raw.toString('hex');
								const filePath = assetManager.UPLOAD_DEST + fileName;
								const writeStream = fs.createWriteStream(filePath);
								currentWriteStream = writeStream;
								extractedFiles.push(filePath);
								// A write error (e.g. the disk filling up) should abort the
								// import, not crash the server.
								writeStream.on('error', err => {
									console.error(err);
									abortZipImport(`Could not extract "${entry.fileName}" from ` +
										`ZIP file: ${err.message}`);
								});
								countExtractedBytes(readStream);
								readStream.pipe(writeStream);

								// If the file has no extension and consists only of numbers,
								// we ignore it as these are not allowed as asset names.
								if (!entry.fileName.match(/([^/]+)$/)[0].match(/^\d+$/)) {
									assets.push({
										filename: fileName,
										originalname: entry.fileName.match(/([^/]+)$/)[0],
										size: entry.uncompressedSize
									});
								}
							});
						}
					});
				}
			});

			// Link all the assets ont the webstrate once done unpacking, if it had a webstrate in it
			zipFile.once('end', async ()=>{
				if (aborted) return;
				try {
					zipFile.close();

					// If no webstrateId exists, either the creation of the webstrate failed or we're waiting
					// on mongodb. Either way, we give mongodb 500ms to figure it out.
					for (let attempts = 3; attempts > 0; attempts--){
						if (createdWebstrate) continue;
						await new Promise((accept,reject)=>{setTimeout(accept,500)})
					}

					if (!createdWebstrate) {
						// We still have no webstrate, give up
						assets.forEach(asset => {
							fs.unlink(assetManager.UPLOAD_DEST + asset.filename, () => {});
						});
						if (htmlDocumentFound) {
							return reject(
								new Error('index.html found, but unable to create webstrate from it. Aborting.'));
						} else {
							return reject(new Error('No index.html found.'));
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
					await assetManager.addAssets(webstrateId, assets, searchables, source);
					accept(webstrateId);
				} catch (err){
					reject(err);
				}
			});

			zipFile.readEntry();
		});
	});
}