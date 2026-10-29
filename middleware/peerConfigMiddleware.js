'use strict';

/*
	Per-user WebRTC peer connection configuration (the STUN/TURN iceServers that
	client/webstrates/signalStream.js feeds to new RTCPeerConnection). They come from this server's
	config.json, and every connection is announced its configuration at
	runtime, as a one-shot {wa:'peerconfig', peerConnectionConfig:...} frame in
	the onconnect chain — the same announcement pattern as the client version
	in versionMiddleware.js, handled client-side in
	client/webstrates/coreWebsocket.js — which applies an announcement only
	while its configuration is still unset, so a value a webstrate script set
	itself is never clobbered — and re-announced on every reconnect.

	Riding the onconnect chain also makes the delivery ordering airtight:
	webstrates.js processes no client frame until that chain has completed,
	so the announcement is on the wire before anything the page itself asks
	for — the ShareDB handshake and snapshot on a live page, the fetchdoc
	reply on a ?static page — and the client applies wa frames in arrival
	order, ahead of its ShareDB stream copy (coreWebsocket.js). The userland
	'loaded' event fires only after 'populated' (and 'userObjectAdded')
	have, each a later round trip, and a document's scripts execute while it
	is being populated — so by the time any userland code can read
	webstrate.config.peerConnectionConfig, the announced value (or one a
	script set earlier — first-shot) is in place. Only the limitations at
	the end of this comment leave it unset.

	Which of the two config.json fields goes out is picked per connection:

	- peerConnectionConfig — everybody's default: anonymous visitors, and
	  logged-in users who have no loggedInPeerConnectionConfig (the fallback).
	  The sample config ships it with Google's public STUN server, so out of
	  the box everybody is announced just that. Set to null it announces
	  nothing: the client then has no servers at all until a webstrate script
	  sets webstrate.config.peerConnectionConfig itself.
	- loggedInPeerConnectionConfig — logged-in users only, overriding the
	  fallback. This is where TURN credentials belong.

	Both fields hold the same object shape the WebRTC API expects, e.g.
	{ "iceServers": [ { "urls": "stun:stun.l.google.com:19302" },
	{ "urls": "turn:turn.example.org:3478", "username": "...",
	"credential": "..." } ] }.
*/

// A configured value that is not a plain object — most plausibly a bare array
// of ICE servers — is ignored with a one-time warning: RTCPeerConnection
// dictionary-converts an array to an empty configuration, silently dropping
// every server, which would leave the receiving users with no STUN/TURN at
// all and no diagnostic anywhere.
let warnedAboutInvalidPeerConnectionConfig = false;

const peerConnectionConfigOrNull = (value, field) => {
	if (!value) return null;
	if (typeof value === 'object' && !Array.isArray(value)) return value;
	if (!warnedAboutInvalidPeerConnectionConfig) {
		warnedAboutInvalidPeerConnectionConfig = true;
		const got = Array.isArray(value)
			? 'a bare array of ICE servers'
			: `a ${typeof value}`;
		console.warn(`Ignoring ${field} in config.json: expected a plain object like`,
			'{ "iceServers": [...] } (see peerConnectionConfig and _loggedInPeerConnectionConfig',
			'in config-sample.json), got', got + '.');
	}
	return null;
};

exports.onconnect = (ws, req, next) => {
	const serverConfig = global.config || {};

	// Pick which field applies to this connection (see the header). The
	// anonymous field is the fallback for everybody, the logged-in field only
	// for logged-in users, where it wins.
	const anonymousConfig = peerConnectionConfigOrNull(serverConfig.peerConnectionConfig,
		'peerConnectionConfig');
	const loggedInConfig = peerConnectionConfigOrNull(serverConfig.loggedInPeerConnectionConfig,
		'loggedInPeerConnectionConfig');
	const isLoggedIn = req.user && !req.user.token && req.user.userId !== 'anonymous:';
	const peerConnectionConfig = isLoggedIn
		? (loggedInConfig || anonymousConfig)
		: anonymousConfig;

	// Announced before shareDbMiddleware attaches the ShareDB stream, like the
	// version announcement; the client handles wa frames ahead of anything
	// ShareDB (and filters them out of its ShareDB stream copy, coreDatabase.js),
	// and older clients that predate this announcement simply ignore it.
	if (peerConnectionConfig) {
		ws.send(JSON.stringify({ wa: 'peerconfig', peerConnectionConfig }));
	}
	next();
};
