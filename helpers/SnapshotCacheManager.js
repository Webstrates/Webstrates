'use strict';

/**
 * SnapshotCacheManager — server-side cache of heavily brotli-compressed
 * webstrate snapshots ("compressed load events").
 *
 * Motivation: on an initial load the client currently receives the full
 * JsonML snapshot as uncompressed JSON over the websocket and then
 * reconstructs the DOM from it node-by-node in JS (coreJsonML.toHTML on the
 * client). For a large document that is (a) a big uncompressed transfer, (b)
 * a full JsonML -> DOM reconstruction in JavaScript, and (c) server-side, a
 * BSON deserialize + JSON.stringify of the whole snapshot per new client.
 *
 * This manager occasionally (debounced after ops settle) stores, per
 * webstrate, a file
 *
 *   <cacheDir>/<encodeURIComponent(id)>.json.br
 *
 * containing a brotli-compressed (default quality 11) JSON payload
 *
 *   { v: <version>, type: <sharedb type URI>, data: <JsonML snapshot> }
 *
 * - `data` is stored VERBATIM as it would arrive over the websocket (with
 *   `&dot;`-encoded attribute keys etc.), so a client that ingests it via
 *   sharedb's Doc.ingestSnapshot() holds exactly the state the normal
 *   snapshot fetch would have given it. A client that has ingested version v
 *   can then call doc.subscribe() — sharedb's subscribe message carries
 *   doc.version, and the server answers with ONLY the ops since v (see
 *   Agent._subscribe: "Snapshot is returned only when subscribing from a
 *   null version"). No snapshot ever crosses the wire again. The client
 *   builds the DOM from the JsonML via coreJsonML.toHTML, as it always did.
 *
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');

// The feature is opt-in: it activates when config.compressedSnapshots === true.
const isEnabled = () => global.config.compressedSnapshots === true;

const cacheDir = () => global.config.compressedSnapshotCacheDir
	|| path.join(APP_PATH, 'snapshot-cache');

const brotliQuality = () => {
	const q = Number(global.config.compressedSnapshotBrotliQuality);
	return (Number.isFinite(q) && q >= 0 && q <= 11) ? q : 11;
};

const debounceMs = () => {
	const d = Number(global.config.compressedSnapshotDebounceMs);
	return (Number.isFinite(d) && d >= 0) ? d : 5000;
};

// Even under continuous editing (the debounce above would otherwise be
// pushed out forever), a cache entry never gets older than this before it is
// rebuilt. A stale entry stays *correct* (the client catches up through the
// ops since the cached version), but an arbitrarily old one would eventually
// cost more op-stream bytes than a fresh snapshot.
const maxStalenessMs = () => {
	const m = Number(global.config.compressedSnapshotMaxStalenessMs);
	return (Number.isFinite(m) && m >= 0) ? m : 60000;
};

const cachePath = (webstrateId) =>
	path.join(cacheDir(), encodeURIComponent(webstrateId) + '.json.br');
const metaPath = (webstrateId) =>
	path.join(cacheDir(), encodeURIComponent(webstrateId) + '.json.meta');

// ---------------------------------------------------------------------------
// Cache maintenance
// ---------------------------------------------------------------------------

const pendingRebuilds = new Map(); // webstrateId -> { timer, scheduledAt }
const buildingNow = new Set(); // webstrateIds with a rebuild in flight

function ensureCacheDir() {
	fs.mkdirSync(cacheDir(), { recursive: true });
}

function removeCacheEntry(webstrateId) {
	for (const file of [cachePath(webstrateId), metaPath(webstrateId)]) {
		try { fs.unlinkSync(file); } catch (err) { /* not there — fine */ }
	}
}

/**
 * Build the cache payload for a webstrate and write it (brotli-compressed)
 * atomically: `{v, type, data}` — the JsonML verbatim, nothing else. The
 * client rebuilds the DOM from it via coreJsonML.toHTML, as on a normal load;
 * the cache only removes the snapshot bytes from the wire.
 * @param {string} webstrateId Webstrate id.
 * @return {object|null} The stored payload (for logging), or null if the
 *   document doesn't exist (entry removed).
 * @private
 */
async function buildAndWrite(webstrateId) {
	if (!isEnabled()) return null;

	let snapshot;
	try {
		snapshot = await documentManager.getDocument({ webstrateId });
	} catch (err) {
		console.error(`SnapshotCache: failed to fetch "${webstrateId}":`, err.message);
		return null;
	}

	if (!snapshot || !snapshot.type || !snapshot.data) {
		// Document deleted or empty: no cache entry.
		removeCacheEntry(webstrateId);
		return null;
	}

	const payload = { v: snapshot.v, type: snapshot.type, data: snapshot.data };

	const json = JSON.stringify(payload);
	// Async brotli (libuv threadpool): quality 11 takes seconds for large
	// documents, and the synchronous variant would block the server's event
	// loop for that entire time — stalling every concurrent client load
	// whenever a rebuild runs.
	const compressed = await new Promise((resolve, reject) => {
		zlib.brotliCompress(json, {
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality() }
		}, (err, out) => err ? reject(err) : resolve(out));
	});

	ensureCacheDir();
	const file = cachePath(webstrateId);
	const tmp = file + '.tmp' + process.pid;
	fs.writeFileSync(tmp, compressed);
	fs.renameSync(tmp, file);

	// Small sidecar with the cached version, so the ?snapshot route can stamp
	// an ETag / debug header without decompressing the payload.
	fs.writeFileSync(metaPath(webstrateId), JSON.stringify({ v: snapshot.v, bytes: json.length }));

	return { webstrateId, v: snapshot.v, uncompressedBytes: json.length,
		compressedBytes: compressed.length };
}

/**
 * Schedule a debounced cache rebuild for a webstrate (typically from the
 * sharedb afterWrite hook: some quiet time after the last op, the cache is
 * refreshed — "occasionally"). Deletes remove the entry immediately.
 * Under continuous editing the debounce is bounded by maxStalenessMs.
 *
 * A miss-triggered rebuild (op === null, from the ?snapshot route) is NOT
 * debounced: the requester polls ?snapshot until the entry appears, and
 * every poll would re-arm — i.e. indefinitely postpone — the write debounce.
 * It runs immediately instead (deduplicated while a build is in flight).
 * @param {string} webstrateId Webstrate id.
 * @param {object} op         The committed op (del/create detection), or null
 *   for a lazy build after a cache miss.
 * @public
 */
module.exports.scheduleRebuild = function(webstrateId, op) {
	if (!webstrateId || !isEnabled()) return;

	if (op && op.del) {
		// A deleted document must not be served from the cache.
		const pending = pendingRebuilds.get(webstrateId);
		if (pending) clearTimeout(pending.timer);
		pendingRebuilds.delete(webstrateId);
		removeCacheEntry(webstrateId);
		return;
	}

	if (!op) {
		// Cache-miss lazy build: run now (unless one is already in flight or
		// an op-triggered debounced rebuild is pending — the freshest data
		// wins either way).
		if (buildingNow.has(webstrateId)) return;
		const pending = pendingRebuilds.get(webstrateId);
		if (pending && pending.timer) return;
		return runRebuild(webstrateId);
	}

	let entry = pendingRebuilds.get(webstrateId);
	if (!entry) {
		entry = { timer: null, scheduledAt: Date.now() };
		pendingRebuilds.set(webstrateId, entry);
	} else if (entry.timer && Date.now() - entry.scheduledAt > maxStalenessMs()) {
		// The entry is already due (continuous editing has pushed the debounce
		// out for longer than the staleness bound): rebuild now.
		clearTimeout(entry.timer);
		return runRebuild(webstrateId);
	}

	if (entry.timer) clearTimeout(entry.timer);
	entry.timer = setTimeout(() => runRebuild(webstrateId), debounceMs());
};

function runRebuild(webstrateId) {
	const entry = pendingRebuilds.get(webstrateId);
	if (entry) clearTimeout(entry.timer);
	pendingRebuilds.delete(webstrateId);
	buildingNow.add(webstrateId);
	buildAndWrite(webstrateId).then(info => {
		buildingNow.delete(webstrateId);
		if (info) {
			console.log(`SnapshotCache: stored "${info.webstrateId}" v${info.v} ` +
				`(${info.uncompressedBytes} -> ${info.compressedBytes} bytes)`);
		}
	}).catch(err => {
		buildingNow.delete(webstrateId);
		console.error('SnapshotCache: rebuild failed:', err);
	});
}

/**
 * Remove a webstrate's cache entry immediately (and cancel any pending
 * rebuild). Used by non-sharedb delete paths (the ?delete HTTP route deletes
 * straight from Mongo, so the afterWrite hook never sees it).
 *
 * NOTE: a rebuild already in flight for the id can still land (and re-create
 * the entry) if its getDocument resolved before the deletion; a client
 * loading that stale entry fails the ops-only subscribe, discards it and
 * subscribes cleanly (coreDatabase's retry path), and the next write to the
 * recreated document rebuilds a fresh entry.
 * @param {string} webstrateId Webstrate id.
 * @public
 */
module.exports.removeEntry = function(webstrateId) {
	if (!webstrateId) return;
	const pending = pendingRebuilds.get(webstrateId);
	if (pending) clearTimeout(pending.timer);
	pendingRebuilds.delete(webstrateId);
	removeCacheEntry(webstrateId);
};

/**
 * Read a cached payload for serving. Reads the compressed file straight
 * from disk (no decompression here — the response carries Content-Encoding:
 * br and the browser's network stack decompresses it).
 * @param  {string} webstrateId Webstrate id.
 * @return {{v: number, uncompressedBytes: number, buffer: Buffer}|null}
 *   Cache entry, or null on a miss.
 * @public
 */
module.exports.readEntry = function(webstrateId) {
	if (!isEnabled()) return null;
	try {
		const buffer = fs.readFileSync(cachePath(webstrateId));
		const meta = JSON.parse(fs.readFileSync(metaPath(webstrateId), 'utf8'));
		return { v: meta.v, uncompressedBytes: meta.bytes, buffer };
	} catch (err) {
		return null;
	}
};

// Test hook (never used in production paths).
module.exports._buildAndWrite = buildAndWrite;
