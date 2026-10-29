// The peerConnectionConfig and loggedInPeerConnectionConfig fields (the
// STUN/TURN servers announced per user by middleware/peerConfigMiddleware.js)
// ride the config.json/config-sample.json merge in helpers/ConfigHelper.js:
// peerConnectionConfig defaults to the sample's public Google STUN server,
// loggedInPeerConnectionConfig to null, and an admin-set object must survive
// a null sample default — which the pre-fix mergeJSON could not do:
// `typeof null === 'object'` sent the merge into Object.entries(null),
// throwing and taking the server down at startup, in getConfig(), the moment
// a field was actually configured. These tests exercise the merge in
// isolation against the repo's real config-sample.json; a running server
// announcing the fields is covered by the functional suites.
import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

global.APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ConfigHelper captures WEBSTRATES_CONFIG when it is loaded, so it has to be
// set before the require below. The fixture file it points at keeps the tests
// off the repo's own config.json (which getConfig() would otherwise create
// from the sample) and is rewritten between tests — getConfig() re-reads it
// on every call. Mocha loads all spec files into one process: the fresh-
// require below keeps this spec order-independent from env-vars-test.mjs and
// uploads-dir-test.mjs, which do the same dance.
const configFixturePath = path.join(os.tmpdir(), `webstrates-peerconfig-test-${process.pid}.json`);
process.env.WEBSTRATES_CONFIG = configFixturePath;

const require = createRequire(import.meta.url);
const configHelperPath = path.join(global.APP_PATH, 'helpers/ConfigHelper.js');
delete require.cache[require.resolve(configHelperPath)];
const configHelper = require(configHelperPath);

const writeFixture = (config) => fs.writeFileSync(configFixturePath, JSON.stringify(config));

const ANON_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const LOGGED_IN_CONFIG = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }
	]
};

describe('peer connection config fields in the config merge', function () {

	after(() => {
		fs.unlinkSync(configFixturePath);
		delete process.env.WEBSTRATES_CONFIG;
	});

	it('should keep an admin-set loggedInPeerConnectionConfig over the sample\'s null', () => {
		// The regression this guards: with the null sample default, the merge
		// used to throw here (Object.entries(null)) and take the server down
		// at startup the moment the field was configured.
		writeFixture({ loggedInPeerConnectionConfig: LOGGED_IN_CONFIG });
		assert.deepStrictEqual(configHelper.getConfig().loggedInPeerConnectionConfig,
			LOGGED_IN_CONFIG);
	});

	it('should default peerConnectionConfig to the sample\'s public STUN server', () => {
		writeFixture({ listeningPort: 7285 });
		const config = configHelper.getConfig();
		assert.deepStrictEqual(config.peerConnectionConfig, ANON_CONFIG,
			'unset -> the Google STUN default is announced to everybody');
		assert.strictEqual(config.loggedInPeerConnectionConfig, null);
		assert.strictEqual(config.listeningPort, 7285);
	});

	it('should preserve an explicit null as the announcement opt-out', () => {
		writeFixture({ peerConnectionConfig: null });
		assert.strictEqual(configHelper.getConfig().peerConnectionConfig, null);
	});

	it('should let an admin\'s iceServers win entry by entry over the sample', () => {
		// The merge fills per index: explicitly configured entries always win;
		// the sample\'s entries only fill an empty list.
		writeFixture({ peerConnectionConfig: { iceServers: [{ urls: 'turn:mine' }] } });
		const config = configHelper.getConfig();
		assert.deepStrictEqual(config.peerConnectionConfig.iceServers, [{ urls: 'turn:mine' }]);
	});

	it('should keep filling object sections from the sample as before', () => {
		writeFixture({ auth: { cookie: { duration: 123 } } });
		const config = configHelper.getConfig();
		assert.strictEqual(config.auth.cookie.duration, 123, 'explicit values still win');
		assert.strictEqual(config.auth.cookie.secure, true, 'missing values still fill in');
	});
});
