'use strict';

const { ZipArchive, TarArchive } = require('archiver');
const ARCHIVE_FORMATS = { zip: ZipArchive, tar: TarArchive };
const crypto = require('crypto');
const dns = require('dns');
const fs = require('graceful-fs');
const http = require('http');
const https = require('https');
const jsonmlTools = require('jsonml-tools');
const htmlToJsonML = require('html-to-jsonml');
const mime = require('mime-types');
const multer = require('multer');
const net = require('net');
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

const DEFAULT_PROTOTYPE_URL_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];
const PROTOTYPE_URL_FETCH_TIMEOUT_MS = 30000;

/**
 * Parse a dotted-quad IPv4 address into its 4 bytes, or null.
 * @param  {string} address Address to parse.
 * @return {number[]|null}    [a, b, c, d], or null if malformed.
 * @private
 */
function parseIPv4Address(address) {
	if (typeof address !== 'string') return null;
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const bytes = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0')) || Number(part) > 255) {
			return null;
		}
		bytes.push(Number(part));
	}
	return bytes;
}

/**
 * Parse an IPv6 literal into its 16 bytes, or null. Handles :: compression
 * and the optional trailing dotted quad (which occupies the last two
 * groups), e.g. ::ffff:127.0.0.1.
 * @param  {string} address Address to parse.
 * @return {number[]|null}  16 address bytes, or null if malformed.
 * @private
 */
function parseIPv6Address(address) {
	if (typeof address !== 'string') return null;
	const halves = address.toLowerCase().split('::');
	if (halves.length > 2) return null;
	const leftGroups = halves[0] === '' ? [] : halves[0].split(':');
	const rightGroups = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
	// An optional dotted quad ends the address, so it can only be the last
	// group of whichever side terminates it.
	const endGroups = halves.length === 2 ? rightGroups : leftGroups;
	let tailBytes = null;
	if (endGroups.length > 0 && endGroups[endGroups.length - 1].includes('.')) {
		tailBytes = parseIPv4Address(endGroups.pop());
		if (!tailBytes) return null;
	}
	for (const group of [...leftGroups, ...rightGroups]) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
	}
	const groupCount = leftGroups.length + rightGroups.length + (tailBytes ? 2 : 0);
	// With :: present it must stand for at least one zero group.
	if (halves.length === 2 ? groupCount > 7 : groupCount !== 8) return null;
	const groups = new Array(8).fill(0);
	leftGroups.forEach((group, index) => { groups[index] = parseInt(group, 16); });
	rightGroups.forEach((group, index) => {
		groups[8 - rightGroups.length - (tailBytes ? 2 : 0) + index] = parseInt(group, 16);
	});
	if (tailBytes) {
		groups[6] = (tailBytes[0] << 8) | tailBytes[1];
		groups[7] = (tailBytes[2] << 8) | tailBytes[3];
	}
	return groups.reduce((bytes, group) => bytes.concat([(group >> 8) & 0xff, group & 0xff]), []);
}

/**
 * Whether a 4-byte IPv4 address is private/internal/reserved: 0.0.0.0/8,
 * 10.0.0.0/8, 127.0.0.0/8, 100.64.0.0/10 (CGNAT), 169.254.0.0/16
 * (link-local / cloud metadata), 172.16.0.0/12, 192.168.0.0/16,
 * 192.0.0.0/24, 198.18.0.0/15 (benchmarks), 224.0.0.0/4 (multicast) and
 * 240.0.0.0/4 (reserved / broadcast).
 * @param  {number} a First address byte.
 * @param  {number} b Second address byte.
 * @param  {number} c Third address byte.
 * @param  {number} d Fourth address byte.
 * @return {boolean}   True if the address is internal.
 * @private
 */
function isPrivateIPv4Bytes(a, b, c, d) {
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224;
}

/**
 * Whether a 16-byte IPv6 address is private/internal/reserved, including
 * the IPv4 segments embedded in other formats: IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96, incl. ::1), NAT64 (64:ff9b::/96 and the RFC 8215
 * local-use 64:ff9b:1::/48) and 6to4 (2002::/16) are classified by the
 * IPv4 they carry. Also ULA (fc00::/7), link-local (fe80::/10), multicast
 * (ff00::/8), Teredo (2001::/32) and documentation (2001:db8::/32).
 * @param  {number[]} bytes 16 address bytes.
 * @return {boolean}        True if the address is internal.
 * @private
 */
function isPrivateIPv6Bytes(bytes) {
	const rangeIsZero = (from, to) => bytes.slice(from, to).every(byte => byte === 0);
	if (rangeIsZero(0, 16)) return true; // :: (unspecified)
	if (rangeIsZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return isPrivateIPv4Bytes(bytes[12], bytes[13], bytes[14], bytes[15]); // ::ffff:0:0/96
	}
	if (rangeIsZero(0, 12)) {
		return isPrivateIPv4Bytes(bytes[12], bytes[13], bytes[14], bytes[15]); // ::/96 IPv4-compatible
	}
	// NAT64 64:ff9b::/96 (bytes 00 64 ff 9b) — the embedded IPv4 decides.
	if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
		rangeIsZero(4, 12)) {
		return isPrivateIPv4Bytes(bytes[12], bytes[13], bytes[14], bytes[15]);
	}
	// RFC 8215 local-use NAT64 64:ff9b:1::/48 — internal by design.
	if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
		bytes[4] === 0x00 && bytes[5] === 0x01) {
		return true;
	}
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		return isPrivateIPv4Bytes(bytes[2], bytes[3], bytes[4], bytes[5]); // 2002::/16 (6to4)
	}
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true;
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
	if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
	if (bytes[0] === 0xff) return true; // ff00::/8
	return false;
}

/**
 * Whether an IP address of either family is private/internal. Unknown
 * formats are treated as private (fail closed).
 * @param  {string} address Address to check.
 * @return {boolean}        True if the address is internal.
 * @private
 */
function isPrivateAddress(address) {
	const ipv4 = parseIPv4Address(address);
	if (ipv4) return isPrivateIPv4Bytes(ipv4[0], ipv4[1], ipv4[2], ipv4[3]);
	const ipv6 = parseIPv6Address(address);
	if (ipv6) return isPrivateIPv6Bytes(ipv6);
	return true; // fail closed
}

/**
 * Validate one prototypeUrlDNS entry: a bare IP, an ip:port pair, or an
 * IPv6 in [v6]:port form, as accepted by dns.setServers. Server names are
 * rejected on purpose — resolving the resolver would need a resolver.
 * @param  {string} entry Configured entry.
 * @return {string|null}  Normalized entry, or null if invalid.
 * @private
 */
function parseDnsServerEntry(entry) {
	if (typeof entry !== 'string') return null;
	let server = entry.trim();
	let port = '';
	if (server.startsWith('[')) {
		const close = server.indexOf(']');
		if (close === -1) return null;
		port = server.slice(close + 1);
		server = server.slice(1, close);
		if (port !== '' && !port.startsWith(':')) return null;
		if (port.startsWith(':')) port = port.slice(1);
	} else {
		const firstColon = server.indexOf(':');
		if (firstColon !== -1 && firstColon === server.lastIndexOf(':')) {
			// Exactly one colon: "ip:port". (A bare IPv6 has several.)
			port = server.slice(firstColon + 1);
			server = server.slice(0, firstColon);
		}
	}
	if (port !== '' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
	if (net.isIP(server) === 0) return null;
	return port === '' ? server : (server.includes(':') ? `[${server}]:${port}` : `${server}:${port}`);
}

let prototypeUrlDnsServersCache = null;

/**
 * The external DNS servers prototypeUrl hostnames are resolved through:
 * the valid entries of config.prototypeUrlDNS, defaulting to Google
 * (8.8.8.8) and Cloudflare (1.1.1.1) DNS when none are configured.
 * @return {string[]} Normalized dns.setServers entries.
 * @private
 */
function getPrototypeUrlDnsServers() {
	if (prototypeUrlDnsServersCache) return prototypeUrlDnsServersCache;
	const servers = [];
	const configured = Array.isArray(config.prototypeUrlDNS) ? config.prototypeUrlDNS : [];
	for (const entry of configured) {
		const server = parseDnsServerEntry(entry);
		if (server) {
			servers.push(server);
		} else {
			console.warn('Ignoring invalid prototypeUrlDNS entry:', entry);
		}
	}
	prototypeUrlDnsServersCache = servers.length > 0 ? servers : DEFAULT_PROTOTYPE_URL_DNS_SERVERS.slice();
	return prototypeUrlDnsServersCache;
}

/**
 * Resolve a prototypeUrl hostname over EXTERNAL DNS only — one of the
 * servers from getPrototypeUrlDnsServers — and refuse if any of the
 * returned addresses (A or AAAA) is internal. The addresses returned
 * here are the only ones the fetch may ever connect to.
 * @param  {string} hostname Hostname to resolve.
 * @return {Object[]}        [{address, family}] public addresses.
 * @throws {Error}           If nothing resolves or any address is internal.
 * @private
 */
async function resolvePrototypeUrlHostname(hostname) {
	const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
	resolver.setServers(getPrototypeUrlDnsServers());
	const [ipv4Results, ipv6Results] = await Promise.all([
		resolver.resolve4(hostname).catch(() => []),
		resolver.resolve6(hostname).catch(() => [])
	]);
	const addresses = [...ipv4Results, ...ipv6Results];
	if (addresses.length === 0) {
		throw new Error('Could not resolve prototypeUrl host.');
	}
	if (addresses.some(address => isPrivateAddress(address))) {
		throw new Error('Refusing to fetch internal addresses via prototypeUrl.');
	}
	return addresses.map(address => ({ address, family: net.isIPv4(address) ? 4 : 6 }));
}

/**
 * Validate a prototypeUrl request parameter (P-101 fix: SSRF). Only
 * http(s) URLs are allowed, and the host must either be operator-allowlisted
 * (config.prototypeUrlAllowlist) or resolve — through external DNS — to
 * public addresses only. Returns the parsed URL together with the pinned
 * addresses the connection must use (null for allowlisted hosts, which are
 * fetched with the default resolver by operator decision).
 * @param  {string} requestedUrl URL requested by the user.
 * @return {Object}              {url: URL, addresses: [{address, family}] | null}
 * @throws {Error}               If the URL or its host is not fetchable.
 * @private
 */
async function validatePrototypeUrl(requestedUrl) {
	const allowlist = (Array.isArray(config.prototypeUrlAllowlist) ? config.prototypeUrlAllowlist : [])
		.map(host => String(host).toLowerCase());

	let parsedUrl;
	try {
		parsedUrl = new URL(requestedUrl);
	} catch (err) {
		throw new Error('Invalid prototypeUrl.', { cause: err });
	}

	if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
		throw new Error('prototypeUrl must be an http(s) URL.');
	}

	// URL hostnames keep their brackets for IPv6 literals.
	const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');

	if (allowlist.includes(hostname)) {
		return { url: parsedUrl, addresses: null };
	}

	if (net.isIP(hostname)) {
		if (isPrivateAddress(hostname)) {
			throw new Error('Refusing to fetch internal addresses via prototypeUrl.');
		}
		return { url: parsedUrl, addresses: [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }] };
	}

	return { url: parsedUrl, addresses: await resolvePrototypeUrlHostname(hostname) };
}

/**
 * A dns.lookup-compatible lookup callback that pins the connection to the
 * externally-resolved addresses: the server's own resolver — and the
 * internal mapping it holds — is never consulted for the fetch.
 * @param  {string}   hostname  Hostname the fetch will ask about.
 * @param  {Object[]} addresses Pinned [{address, family}] answers.
 * @return {Function}           lookup(hostname, options, callback).
 * @private
 */
function makePinnedLookup(hostname, addresses) {
	const expected = hostname.toLowerCase();
	return (lookupHostname, options, callback) => {
		if (String(lookupHostname).toLowerCase() !== expected) {
			return callback(new Error('prototypeUrl host mismatch.'));
		}
		if (options && options.all) {
			return callback(null, addresses.map(({ address, family }) => ({ address, family })));
		}
		const { address, family } = addresses[0];
		return callback(null, address, family);
	};
}

/**
 * Decode a prototypeUrl response body the way fetch() does for the
 * encodings we request (gzip, deflate). Anything else passes through.
 * @param  {Buffer} buffer  Raw body bytes.
 * @param  {string} encoding Content-Encoding header value.
 * @return {Buffer}         Decoded body.
 * @throws {Error}          If the body cannot be decoded.
 * @private
 */
function decodePrototypeUrlBody(buffer, encoding) {
	const enc = String(encoding || '').trim().toLowerCase();
	if (enc === 'gzip') return zlib.gunzipSync(buffer);
	if (enc === 'deflate') {
		try {
			return zlib.inflateSync(buffer);
		} catch (err) {
			return zlib.inflateRawSync(buffer);
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
 * Fetch one validated prototypeUrl hop over http(s).request with the
 * connection pinned to the externally-resolved addresses, gzip/deflate
 * decoding and a hard timeout. Connections are not pooled (agent: false),
 * so no prototypeUrl socket is ever reused by anything else.
 * @param  {Object} validated {url, addresses} from validatePrototypeUrl.
 * @return {Promise<PrototypeUrlResponse>}
 * @private
 */
function requestPrototypeUrl(validated) {
	const transport = validated.url.protocol === 'https:' ? https : http;
	// URL hostnames keep their brackets for IPv6 literals.
	const hostname = validated.url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return new Promise((resolve, reject) => {
		const options = {
			agent: false,
			headers: { 'accept-encoding': 'gzip, deflate' }
		};
		if (validated.addresses) {
			options.lookup = makePinnedLookup(hostname, validated.addresses);
		}
		const request = transport.request(validated.url, options, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('error', reject);
			response.on('aborted', () => reject(new Error('prototypeUrl fetch aborted.')));
			response.on('end', () => {
				clearTimeout(timer);
				try {
					resolve(new PrototypeUrlResponse(response,
						decodePrototypeUrlBody(Buffer.concat(chunks), response.headers['content-encoding'])));
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
 * Fetch a prototypeUrl after validating and pinning every hop (P-101
 * fix): redirects are followed manually, and each redirect target is
 * validated (and pinned) the same way as the original URL.
 * @param  {string} requestedUrl URL requested by the user.
 * @return {PrototypeUrlResponse} Fetched response (a non-2xx response is an error).
 * @throws {Error}                On invalid destinations or failed fetches.
 * @private
 */
async function fetchPrototypeUrl(requestedUrl) {
	let current = await validatePrototypeUrl(requestedUrl);

	for (let redirects = 0; redirects < 5; redirects++) {
		const response = await requestPrototypeUrl(current);
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			current = await validatePrototypeUrl(new URL(location, current.url).href);
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
	yauzl.open(APP_PATH + '/uploads/' + fileName, { lazyEntries: true }, (err, zipFile) => {
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
	if ("asset" in req.params) {
		req.params.assetName = req.params.asset;
		if (req.params.extension) req.params.assetName += "." + req.params.extension;
		if (req.params.assetPath) req.params.assetPath = req.params.assetPath.join("/");
	}

	// version (number) or tag (string)
	if ("versionOrTag" in req.params) {
		if (/^-?\d+$/.test(req.params.versionOrTag)) {
			req.params.version = Number(req.params.versionOrTag);
		} else {
			req.params.tag = req.params.versionOrTag;
		}
	}

	if ("assetOrVersionOrTag" in req.params) {
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
				const version = await documentManager.getVersionFromTag(req.params.webstrateId, req.params.assetOrVersionOrTag);
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
	// /<webstrateId>/<versionOrTag>/.
	if (req.query.v && !req.params.versionOrTag) {
		const version = req.query.v;
		// Destructure v out rather than deleting it from req.query: Express 5's req.query is
		// re-parsed from the URL on every access, so a delete would only affect a throwaway
		// object and the ?v parameter would ride along on the redirect. That made the
		// redirected page hit the "current version number" API below (?v is that request)
		// and get served JSON instead of the document.
		const { v: _v, ...restQuery } = req.query;
		return res.redirect(url.format({
			pathname: `/${req.params.webstrateId}/${version}/`,
			query: restQuery
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

				if ('dir' in req.query) {
					const zipStructure = await getZipStructure(asset.fileName);
					res.json(zipStructure);
					return;
				}

				if (req.params.assetPath) {
					return yauzl.open(APP_PATH + '/uploads/' + asset.fileName, { lazyEntries: true },
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

				// An asset record can outlive its file (the file system and the database can
				// lose sync). Serving such a record would 500 through sendFile's error
				// path; report it as what it is — a missing asset — and lazily drop the
				// dead record, the same way the ?dl download path does. A re-upload of the
				// same content resurrects the file (see AssetManager.addAsset).
				const assetFilePath = APP_PATH + '/uploads/' + asset.fileName;
				if (!fs.existsSync(assetFilePath)) {
					// No reason to make the user wait for the record cleanup.
					assetManager.deleteAssetFromDatabase(asset.fileName);
					return res.status(404).send(`Asset "${req.params.assetName}" is no longer ` +
						'available (its file is missing).');
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

			if (!req.user.permissions.includes('w')) {
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

		return serveWebstrate(req, res, snapshot);
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
					`${req.params.webstrateId} doesn't exist. Deleting it from database.`);
				// The deletion happens async, but there's no reason to make the user wait for it.
				assetManager.deleteAssetFromDatabase(asset.fileName);
			}
		});
		archive.finalize();
		const potentialTag = req.params.tag ? ('-' + req.params.tag) : '';
		const filename = req.query.filename || `${req.params.webstrateId}-${snapshot.v}${potentialTag}.${format}`;
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
		// otherwise just delete all permissions on the new document.
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
		let newVersion = await documentManager.restoreDocument({ webstrateId: req.params.webstrateId, version, tag },
			source);

		// Also restore assets, so the restored version shows the old assets, not the new ones.
		await assetManager.restoreAssets({ webstrateId: req.params.webstrateId, version, tag, newVersion });

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
		res.redirect('/');
	} catch (err){
		console.error(err);
		return res.status(409).send(String(err));
	}
}

/**
 * Requesting a webstrate by calling /<id>.
 *
 * Head requests of existing documents are served as a pre-rendered page: the
 * document's own HTML on the v2 painted wire (identity-carrying `_`
 * attributes and eid,x_ content prefixes — see DocumentStore.toHTML), with
 * the sync client bundle and script preloads injected into the temporary
 * real <head>, brotli-compressed, from the snapshot cache (or rendered
 * inline at a lower compression quality when no fresh entry exists). The
 * client adopts the painted DOM in place as it streams in instead of
 * rebuilding from a snapshot.
 *
 * Versioned/tagged requests and empty documents get the plain client shell:
 * the pre-rendered page only exists for the head revision, and an empty
 * document has nothing to render (the client bootstraps html/head/body
 * through a commit).
 * @param {obj}      req      Express request object.
 * @param {obj}      res      Express response object.
 * @param {snapshot} snapshot Document snapshot.
 * @private
 */
function serveWebstrate(req, res, snapshot) {
	// Old versions and tags: serve the shell, the client fetches the snapshot.
	if (req.params.version !== undefined || req.params.tag !== undefined) {
		return sendClientShell(res);
	}

	// Empty document: the client creates the basic DOM structure through a commit.
	if (!snapshot || !snapshot.type) {
		return sendClientShell(res);
	}

	let page = null;
	try {
		page = snapshotCacheManager.readEntry(req.params.webstrateId);
		if (!page) {
			// No fresh entry: render inline (fast compression quality) and
			// refresh the cache in the background.
			page = snapshotCacheManager.renderInline(req.params.webstrateId);
			if (page) {
				snapshotCacheManager.scheduleRebuild(req.params.webstrateId);
			}
		}
	} catch (err) {
		console.error(err);
	}
	if (!page) return sendClientShell(res);

	const acceptsBr = (req.headers['accept-encoding'] || '').includes('br');
	const etag = `"wsv${page.v}${acceptsBr ? '-br' : ''}"`;
	if (req.headers['if-none-match'] === etag) {
		return res.status(304).set('ETag', etag).set('Vary', 'Accept-Encoding').end();
	}

	res.status(200);
	res.set('Content-Type', 'text/html; charset=UTF-8');
	// The page content changes with every commit, so it must be revalidated —
	// but the ETag makes that cheap for repeated loads.
	res.set('Cache-Control', 'no-cache');
	res.set('ETag', etag);
	res.set('Vary', 'Accept-Encoding');

	if (acceptsBr) {
		res.set('Content-Encoding', 'br');
		return res.send(page.buffer);
	}

	// Client doesn't accept brotli: decompress the page and send it plain.
	return zlib.brotliDecompress(page.buffer, (err, html) => {
		if (err) {
			console.error(err);
			return res.send('<html><body><h1>Internal server error.</h1></body></html>');
		}
		res.send(html);
	});
}

/**
 * Send the plain client shell (static/client.html) — the fallback for empty
 * documents, versioned/tagged requests, and render failures.
 * @param {obj} res Express response object.
 * @private
 */
function sendClientShell(res) {
	// The shell is what an empty document serves; the very same URL serves the
	// pre-rendered page once the document exists. Caching it for longer than a
	// revalidation would pin returning visitors to the shell and cost them the
	// adoption fast path (max-age=0 keeps the ETag revalidation, so an
	// unchanged shell still comes back as a cheap 304).
	return res.sendFile(APP_PATH + '/static/client.html', { maxAge: 0 });
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
		// --- ?prototypeUrl SSRF guard ------------------------------------------
		//
		// prototypeUrl lets an unauthenticated client make the server fetch a URL,
		// so the fetch is wrapped in three defenses:
		//   1. Only http(s) URLs, and only hosts that are either operator-allowlisted
		//      (config.prototypeUrlAllowlist) or resolve to public addresses.
		//   2. Hostnames are resolved over EXTERNAL DNS only — one of the servers in
		//      config.prototypeUrlDNS (defaulting to Google/Cloudflare), never the
		//      server's own resolver: /etc/hosts, /etc/resolv.conf and any
		//      split-horizon view describe the internal network, and neither the
		//      validation nor the fetch may use or expose that internal mapping.
		//   3. The connection is pinned to the addresses the external resolver
		//      returned, so the hostname is never resolved (or re-resolved) on the
		//      way to connect. Redirects are followed manually and every hop is
		//      validated and pinned the same way.
		// Address checks are byte-level so the IPv4 segments embedded in IPv6
		// literals (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, NAT64
		// 64:ff9b::/96 and 6to4 2002::/16) are classified by the IPv4 they carry:
		// ::ffff:127.0.0.1 and its hex twin ::ffff:7f00:1 are both loopback.
        try {
			// Fetch remote data (validated, resolved externally and pinned — P-101 fix).
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
								// new document.
								if (!userPermissions.includes('w')) {
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
							return reject(new Error('index.html found, but unable to create webstrate from it. Aborting.'));
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