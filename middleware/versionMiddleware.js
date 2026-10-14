'use strict';

// Client version announcements. The webpack build embeds a version (16 hex
// chars of sha256 over everything that shapes the client bundle) in the bundle itself,
// as serverConfig.clientVersion — see webpack.config.js — so every client knows which
// build it is running, whatever URL it was loaded from. On every websocket connection
// this middleware announces the version of the client bundle the server is shipping
// ({wa:'version', v:<version>}). Clients compare that against their embedded one
// (client/webstrates/coreWebsocket.js) and, on a mismatch, close the connection without
// reconnecting and reload the page after a short wait: long-running pages pick up a new
// build after an upgrade without manual intervention, and an outdated client never
// submits changes to a server it may be incompatible with.
//
// Enforcement is entirely client-side: the server announces but never refuses. Clients
// from before this mechanism (and clients hand-loaded without an embedded version)
// simply don't check and keep working.
//
// The announced value is extracted from the bundle this server is shipping (cached by
// the bundle file's mtime, so a rebuilt bundle is picked up without a server restart —
// e.g. under webpack --watch), which means it is always exactly the build a freshly
// loaded page gets. A bundle that predates the embedded version (built by an older
// webpack config) carries none; such a server simply doesn't announce and behaves as
// before.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bundlePath = path.join(global.APP_PATH, 'static', 'webstrates.js');

// What we last read from the bundle: its content hash (the file name the hashed-bundle
// route serves it under) and the clientVersion the build embedded in it.
let cachedBundle = null;
let warnedAboutMissingBundle = false;

const readBundle = () => {
	try {
		const stats = fs.statSync(bundlePath);
		if (!cachedBundle || cachedBundle.mtimeMs !== stats.mtimeMs) {
			const content = fs.readFileSync(bundlePath);
			cachedBundle = {
				mtimeMs: stats.mtimeMs,
				hash: crypto.createHash('sha256')
					.update(content)
					.digest('hex')
					.slice(0, 16),
				// The build embeds the version as a plain clientVersion:"<16 hex>" pair
				// inside the serverConfig object literal in the bundle (key unquoted in
				// minified production builds, quoted in JSON.stringify output).
				clientVersion: (/"?clientVersion"?\s*:\s*"([0-9a-f]{16})"/.exec(content) || [])[1] || null
			};
		}
		return cachedBundle;
	} catch {
		return null;
	}
};

/**
 * The hash of the client bundle itself (16 hex chars of its sha256) — the file name the
 * hashed-bundle route serves it under. Null when no servable bundle exists: either
 * webstrates.js is missing, or its hashed copy webstrates_<hash>.js hasn't been written
 * (yet) — the build writes the bundle before the hashed copy, so the two are briefly out
 * of step mid-build, and a tree last built by a pre-hashing webpack has no copy at all.
 * @return {string|null} Bundle hash, or null.
 */
exports.clientBundleHash = () => {
	const bundle = readBundle();
	if (!bundle) {
		if (!warnedAboutMissingBundle) {
			warnedAboutMissingBundle = true;
			console.error('Could not read the client bundle (static/webstrates.js):',
				'run "npm run build".');
		}
		return null;
	}
	// The hashed copy is what the routes actually serve, so the redirect may only point
	// at the hash once it exists (checked per call, not cached: the copy appears without
	// webstrates.js being touched again). Redirecting to a hash we cannot serve would
	// dead-end the client on a 404 bundle.
	if (!fs.existsSync(path.join(path.dirname(bundlePath), `webstrates_${bundle.hash}.js`))) {
		return null;
	}
	return bundle.hash;
};

exports.onconnect = (ws, req, next) => {
	// Tell the client which build we are shipping, so it can detect that it was loaded
	// from a different one and reload (see the version handling in coreWebsocket.js).
	// Bundles from before the embedded version get no announcement at all.
	const bundle = readBundle();
	if (bundle && bundle.clientVersion) {
		ws.send(JSON.stringify({ wa: 'version', v: bundle.clientVersion }));
	}
	next();
};
