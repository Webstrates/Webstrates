'use strict';

/**
 * SnapshotCacheManager — server-side cache of the pre-rendered webstrate
 * pages (the "initial load" fast path).
 *
 * On an initial load the server serves the document as HTML rendered straight
 * from the document's SQLite state: every node rides natively — elements
 * carry _="<eid>[,<attrIndex>…]" attributes, text/comment nodes carry an
 * "<eid>,<attrIndex>_" prefix the client trims with deleteData — inside a
 * temporary real <head> (holding only the sync client bundle) followed by a
 * <head_> element carrying the mirror head. Scripts are neutered
 * (type="webstrates/x") so nothing executes before the client bundle has
 * booted. The client adopts the already-painted DOM (the browser's parser
 * has done virtually all the work), checks the content digest carried in
 * data-d, then subscribes and replays the few commits since the render.
 *
 * The paint of a revision is only served stable: on first render the server
 * re-parses its own paint with parse5 (the WHATWG algorithm browsers run)
 * and commits any divergence as the document's own ops — see
 * PaintNormalizer. The digest check is therefore an integrity assert that
 * cannot fire from a server-made paint; it exists for extension
 * interference and parser divergences.
 *
 * Rendering + brotli compressing that page takes a moment, so after ops
 * settle (debounced) the fully-built page is cached per webstrate:
 *
 *   <cacheDir>/<encodeURIComponent(id)>.html.br   brotli-compressed page
 *   <cacheDir>/<encodeURIComponent(id)>.html.meta {v, bytes}
 *
 * A request either finds a fresh entry (v === current revision) and streams
 * it with Content-Encoding: br, or renders one inline (fast compression
 * quality) and serves that while scheduling a high-quality rebuild.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const documentStore = require(APP_PATH + '/helpers/DocumentStore.js');
const paintNormalizer = require(APP_PATH + '/helpers/PaintNormalizer.js');

const cacheDir = () => {
	const configured = global.config.snapshotCacheDir;
	// A relative path (as in the sample config) is anchored to the
	// application, not to whatever directory the process was started from.
	if (!configured) return path.join(APP_PATH, 'snapshot-cache');
	return path.isAbsolute(configured) ? configured : path.join(APP_PATH, configured);
};

// Quality of the asynchronous (post-op, debounced) cache build.
const brotliQuality = () => {
	const q = Number(global.config.snapshotCacheBrotliQuality);
	return (Number.isFinite(q) && q >= 0 && q <= 11) ? q : 11;
};

// Quality of the inline (cache-miss) render served to the current requester.
const inlineBrotliQuality = () => {
	const q = Number(global.config.snapshotCacheInlineBrotliQuality);
	return (Number.isFinite(q) && q >= 0 && q <= 11) ? q : 5;
};

const debounceMs = () => {
	const d = Number(global.config.snapshotCacheDebounceMs);
	return (Number.isFinite(d) && d >= 0) ? d : 5000;
};

// Even under continuous editing, a cache entry never gets older than this
// before it is rebuilt.
const maxStalenessMs = () => {
	const m = Number(global.config.snapshotCacheMaxStalenessMs);
	return (Number.isFinite(m) && m >= 0) ? m : 60000;
};

const cachePath = (webstrateId) =>
	path.join(cacheDir(), encodeURIComponent(webstrateId) + '.html.br');
const metaPath = (webstrateId) =>
	path.join(cacheDir(), encodeURIComponent(webstrateId) + '.html.meta');

// The paint format this build renders (v2: native nodes, temp head, <head_>,
// identity prefixes). Entries stamped with a different format are stale
// however fresh their revision — their bytes were rendered by an older
// serializer and would not adopt.
const CACHE_FORMAT = 2;

// ---------------------------------------------------------------------------
// Page rendering (shared by the cache build and the inline miss path)
// ---------------------------------------------------------------------------

// The hashed client bundle reference from the built static/client.html
// (webpack stamps the hash into it). Read once and cached, keyed on the
// file's mtime.
let bundleRef = null;
let bundleRefMtime = null;

/**
 * The <script src> reference of the client bundle, exactly as the shell page
 * serves it (e.g. "/webstrates.js?8c33e0…"). Falls back to the unhashed path
 * if the built client.html cannot be read.
 * @return {string} Script src.
 * @private
 */
function clientBundleSrc() {
	const clientHtmlPath = path.join(APP_PATH, 'static', 'client.html');
	try {
		const mtime = fs.statSync(clientHtmlPath).mtimeMs;
		if (bundleRef && bundleRefMtime === mtime) return bundleRef;
		const html = fs.readFileSync(clientHtmlPath, 'utf8');
		const match = html.match(/<script[^>]+src="(\/webstrates\.js\?[^"]+)"/);
		bundleRef = match ? match[1] : '/webstrates.js';
		bundleRefMtime = mtime;
	} catch (err) {
		bundleRef = '/webstrates.js';
	}
	return bundleRef;
}

/**
 * The boot style: while the paint streams and the client adopts it, the
 * document itself must not render — a mid-parse layout of the half-adopted
 * tree is wasted work that also blocks the DOMContentLoaded dispatch (and
 * with it the adoption's completion). The body is hidden with display:none
 * (subtree layout skipped entirely, not merely unpainted) and the shell
 * loading UI from static/client.html — the green rotating plane and
 * "Loading Webstrates" — rides as html pseudo-elements, so no DOM node is
 * needed. The style is wire-only (data-webstrates-boot, a name validOp
 * rejects, so a mirror node can never collide with it): the client strips
 * it when the document is revealed — at 'populated' for a plain document,
 * or once a boot loader (paintAdoption's BOOTLOADER_RE) reports completion
 * on a codestrate; the paint digest never
 * sees it. Same !important caveat as any author sheet vs. document styles:
 * a document style that fights the boot hide wins only the reveal's
 * exactness, never correctness.
 * @return {string} <style> markup for the temporary real head.
 * @private
 */
function bootStyle() {
	// The bare `transient` attribute keeps the style out of the client's
	// path tree and model (config.isTransientElement matches [transient]),
	// so the reveal's deferred removal (see paintAdoption) is op-free: no
	// commit, no version bump, no mirror divergence.
	//
	// The look mirrors the shell's favicon-ripple spinner (client.html,
	// d624124): the tab favicon served at /favicon.ico is already warm by
	// the time the boot style parses. The zero-DOM constraint (no node
	// besides the style itself may exist in the walked document) leaves
	// html's two pseudo-element slots: ::before is the icon, ::after the
	// single ripple (the shell's second, staggered ripple has no slot
	// here) growing from icon size to double and fading out.
	return '<style transient data-webstrates-boot="1">'
		+ 'body{visibility:hidden}'
		+ 'body>*{display:none!important}'
		+ 'html::before{content:"";position:fixed;top:calc(50% - 24px);'
		+ 'left:calc(50% - 24px);width:48px;height:48px;'
		+ 'background:url("/favicon.ico") no-repeat center / contain;'
		+ 'z-index:2147483647}'
		+ 'html::after{content:"";position:fixed;top:calc(50% - 48px);'
		+ 'left:calc(50% - 48px);width:96px;height:96px;'
		+ 'background:url("/favicon.ico") no-repeat center / contain;'
		+ 'animation:wsp-emit 2.4s ease-out infinite;z-index:2147483646}'
		+ '@keyframes wsp-emit{from{transform:scale(.5);opacity:.4}'
		+ 'to{transform:scale(1);opacity:0}}'
		+ '</style>';
}

/**
 * One preload link per sourced document script (early fetch). The links are
 * wire-only — no `_`, stripped at adoption together with the bundle script.
 * Template contents are skipped: their scripts never execute, preloading
 * them would only be noise.
 * @param  {Handle} handle DocumentStore handle.
 * @return {[string]}      <link> strings.
 * @private
 */
function preloadLinks(handle) {
	const escapeAttr = (v) => String(v).replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const links = [];
	const walk = (eid) => {
		const node = handle.nodes.get(eid);
		if (!node || node.t !== 1) return; // NODE_ELEMENT
		const name = String(node.n).toLowerCase();
		if (name === 'template') return;
		if (name === 'script') {
			const srcAttr = node.attrs.find((a) => a.n === 'src');
			if (srcAttr) {
				links.push(`<link rel="preload" as="script" href="${escapeAttr(srcAttr.v)}">`);
			}
			return; // scripts have no element children
		}
		for (const child of node.kids) walk(child);
	};
	const root = handle.nodes.get(0);
	const htmlEid = root && root.kids[0];
	if (htmlEid !== undefined) {
		for (const child of handle.nodes.get(htmlEid).kids) walk(child);
	}
	return links;
}

/**
 * Render the full servable page for a webstrate at its current revision:
 * normalized (see PaintNormalizer.ensureStable — the first render of a
 * revision commits the browser-canonical normalization ops when the
 * document holds an unparseable shape), then the wire with the sync client
 * bundle (revision in its URL fragment, content digest in data-d) and the
 * script preloads injected into the temporary real <head>.
 * @param  {Handle}  handle    DocumentStore handle (at head).
 * @return {string|null}       Page HTML, or null when the document is empty.
 * @private
 */
function renderPage(handle) {
	if (handle.revision === 0) return null;
	paintNormalizer.ensureStable(handle);
	// The digest and the wire are both read from the (possibly just
	// normalized) mirror, so the served paint always describes the revision
	// named in the bundle URL.
	const digest = handle.paintDigest();
	const bundleScript = '<script id="__webstrates_client" '
		+ `src="${clientBundleSrc()}#${handle.revision}" data-d="${digest}">`
		+ '</script>' + bootStyle();
	return handle.toHTML(handle.nodes, { bundle: bundleScript,
		preloads: preloadLinks(handle) });
}

/**
 * Render the page for a webstrate and compress it (async brotli on the libuv
 * threadpool).
 * @param  {string}  webstrateId Webstrate id.
 * @param  {number}  quality     Brotli quality.
 * @return {Promise<{v, buffer, bytes}|null>} Compressed page, or null when
 *   the document is empty.
 * @public
 */
async function buildPage(webstrateId, quality = brotliQuality()) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		const html = renderPage(handle);
		if (html === null) return null;
		const v = handle.revision;
		const compressed = await new Promise((resolve, reject) => {
			zlib.brotliCompress(Buffer.from(html, 'utf8'), {
				params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality }
			}, (err, out) => err ? reject(err) : resolve(out));
		});
		return { v, buffer: compressed, bytes: html.length };
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
}

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
 * Build the cache entry for a webstrate atomically: brotli-compressed page
 * plus a small meta sidecar ({v, bytes, fmt}) so freshness (and the wire
 * format version) can be checked without decompressing.
 * @param {string} webstrateId Webstrate id.
 * @return {Promise<object|null>} Build info, or null for empty documents.
 * @private
 */
async function buildAndWrite(webstrateId) {
	const info = await buildPage(webstrateId, brotliQuality());
	if (!info) {
		// Document deleted or empty: no cache entry.
		removeCacheEntry(webstrateId);
		return null;
	}

	ensureCacheDir();
	const file = cachePath(webstrateId);
	const tmp = file + '.tmp' + process.pid;
	fs.writeFileSync(tmp, info.buffer);
	fs.renameSync(tmp, file);
	fs.writeFileSync(metaPath(webstrateId), JSON.stringify({ v: info.v,
		bytes: info.bytes, fmt: CACHE_FORMAT }));

	return { webstrateId, v: info.v, uncompressedBytes: info.bytes,
		compressedBytes: info.buffer.length };
}

/**
 * Schedule a debounced cache rebuild for a webstrate (from the commit path:
 * some quiet time after the last commit, the cached page is refreshed).
 * Under continuous editing the debounce is bounded by maxStalenessMs.
 * @param {string} webstrateId Webstrate id.
 * @public
 */
module.exports.scheduleRebuild = function(webstrateId) {
	if (!webstrateId) return;

	let entry = pendingRebuilds.get(webstrateId);
	if (!entry) {
		entry = { timer: null, scheduledAt: Date.now() };
		pendingRebuilds.set(webstrateId, entry);
	} else if (entry.timer && Date.now() - entry.scheduledAt > maxStalenessMs()) {
		// The rebuild is already due (continuous editing has pushed the
		// debounce out past the staleness bound): rebuild now.
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
 * rebuild). Used by the delete paths.
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
 * Read a cached page for serving, but only when it is fresh (its version
 * matches the document's current revision). A stale entry is dropped and a
 * rebuild scheduled.
 * @param  {string} webstrateId Webstrate id.
 * @return {{v: number, buffer: Buffer}|null} Fresh cache entry, or null.
 * @public
 */
module.exports.readEntry = function(webstrateId) {
	try {
		const meta = JSON.parse(fs.readFileSync(metaPath(webstrateId), 'utf8'));
		const currentRevision = documentStore.getHandle(webstrateId).revision;
		documentStore.releaseHandle(webstrateId);
		if (meta.fmt !== CACHE_FORMAT || meta.v !== currentRevision) {
			// Stale: drop it now and refresh it in the background.
			removeCacheEntry(webstrateId);
			module.exports.scheduleRebuild(webstrateId);
			return null;
		}
		return { v: meta.v, buffer: fs.readFileSync(cachePath(webstrateId)) };
	} catch (err) {
		return null;
	}
};

// Test hook (never used in production paths).
module.exports._buildAndWrite = buildAndWrite;

/**
 * Render a page synchronously (inline miss path) — compressed at the lower
 * inline quality, which stays in the low milliseconds even for large
 * documents.
 * @param  {string} webstrateId Webstrate id.
 * @return {{v: number, buffer: Buffer}|null}
 * @public
 */
module.exports.renderInline = function(webstrateId) {
	const handle = documentStore.getHandle(webstrateId);
	try {
		if (handle.revision === 0) return null;
		const html = renderPage(handle);
		if (html === null) return null;
		const compressed = zlib.brotliCompressSync(Buffer.from(html, 'utf8'), {
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: inlineBrotliQuality() }
		});
		return { v: handle.revision, buffer: compressed };
	} finally {
		documentStore.releaseHandle(webstrateId);
	}
};
