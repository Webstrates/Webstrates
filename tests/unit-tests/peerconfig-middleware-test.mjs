// The peerconfig announcement (middleware/peerConfigMiddleware.js): every
// connection is announced its WebRTC peer connection configuration (the
// STUN/TURN servers for signal streams), picked per connection from the two
// config.json fields — peerConnectionConfig for everybody,
// loggedInPeerConnectionConfig overriding it for logged-in users, nothing for
// anyone when both are unset. These tests drive the middleware directly with
// stub sockets and requests; the client side that applies the announced frame
// (client/webstrates/coreWebsocket.js) and a running server announcing to
// real connections are covered by the functional suites.
import { assert } from 'chai';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

global.APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const require = createRequire(import.meta.url);
// The middleware reads global.config on every connection, not at load time,
// so a single instance serves every test. The save/restore in after() keeps
// the stub config from leaking into specs that run later in the same mocha
// process.
const middleware = require(path.join(global.APP_PATH, 'middleware/peerConfigMiddleware.js'));
const previousGlobalConfig = global.config;

const ANON_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const LOGGED_IN_CONFIG = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }
	]
};

// Run one connection through the middleware with a stub socket.
const connect = (user, config) => {
	global.config = config;
	const frames = [];
	let nextCalls = 0;
	middleware.onconnect({ send: (frame) => frames.push(frame) }, { user }, () => nextCalls++);
	return { frames, nextCalls };
};

// All of these connections must keep the middleware chain going, so the
// assert on nextCalls is the same everywhere: fold it in here.
const expectAnnouncement = (user, config, expected) => {
	const { frames, nextCalls } = connect(user, config);
	assert.strictEqual(nextCalls, 1, 'the middleware chain must continue');
	if (expected === null) {
		assert.deepStrictEqual(frames, [], 'no announcement');
	} else {
		assert.strictEqual(frames.length, 1, 'exactly one announcement');
		assert.strictEqual(frames[0],
			JSON.stringify({ wa: 'peerconfig', peerConnectionConfig: expected }));
	}
};

describe('peerconfig announcement', function () {

	after(() => {
		global.config = previousGlobalConfig;
	});

	it('should announce a logged-in user their loggedInPeerConnectionConfig', () => {
		expectAnnouncement({ userId: 'alice:' },
			{ peerConnectionConfig: ANON_CONFIG, loggedInPeerConnectionConfig: LOGGED_IN_CONFIG },
			LOGGED_IN_CONFIG);
	});

	it('should fall back to peerConnectionConfig for a logged-in user without their own', () => {
		expectAnnouncement({ userId: 'alice:' },
			{ peerConnectionConfig: ANON_CONFIG }, ANON_CONFIG);
	});

	it('should announce an anonymous visitor the peerConnectionConfig', () => {
		expectAnnouncement({ userId: 'anonymous:' },
			{ peerConnectionConfig: ANON_CONFIG, loggedInPeerConnectionConfig: LOGGED_IN_CONFIG },
			ANON_CONFIG);
	});

	it('should never announce loggedInPeerConnectionConfig to an anonymous visitor', () => {
		expectAnnouncement({ userId: 'anonymous:' },
			{ loggedInPeerConnectionConfig: LOGGED_IN_CONFIG }, null);
	});

	it('should treat access-token readers as anonymous', () => {
		// A ?token= connection delegates one document's permissions without
		// being a login; sessionMiddleware marks it with user.token. TURN
		// credentials are neither document-scoped nor time-limited.
		expectAnnouncement({ userId: 'alice:', token: 't' },
			{ peerConnectionConfig: ANON_CONFIG, loggedInPeerConnectionConfig: LOGGED_IN_CONFIG },
			ANON_CONFIG);
	});

	it('should announce nothing to anyone when both fields are unset', () => {
		['', null, undefined, 0, false].forEach((value) => {
			expectAnnouncement({ userId: 'alice:' },
				{ peerConnectionConfig: value, loggedInPeerConnectionConfig: value }, null);
		});
	});

	it('should skip misshaped values, not announce them', () => {
		// A bare array of ICE servers is the plausible mistake: RTCPeerConnection
		// dictionary-converts it to an empty configuration, dropping every
		// server. Strings and numbers make no sense either.
		[[{ urls: 'turn:x' }], 'stun:x', 42, true].forEach((value) => {
			expectAnnouncement({ userId: 'alice:' }, { loggedInPeerConnectionConfig: value },
				null);
		});
	});

	it('should fall back past a misshaped loggedInPeerConnectionConfig', () => {
		expectAnnouncement({ userId: 'alice:' },
			{ peerConnectionConfig: ANON_CONFIG, loggedInPeerConnectionConfig: [{ urls: 'turn:x' }] },
			ANON_CONFIG);
	});

	it('should survive a missing user', () => {
		// No session at all behaves like any other anonymous connection.
		expectAnnouncement(undefined, { peerConnectionConfig: ANON_CONFIG }, ANON_CONFIG);
	});

	it('should survive a missing config', () => {
		global.config = undefined;
		const frames = [];
		let nextCalls = 0;
		middleware.onconnect({ send: (frame) => frames.push(frame) }, { user: { userId: 'alice:' } },
			() => nextCalls++);
		assert.deepStrictEqual(frames, []);
		assert.strictEqual(nextCalls, 1, 'the middleware chain must continue');
	});
});
