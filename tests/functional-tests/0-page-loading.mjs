// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */

import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';
import harness from '../lib/server-harness.mjs';

describe('Page Loading', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	after(async () => {
		await browser.close();
	});

	it('should connect and create a webstrate using /'+webstrateId+" within 1 sec", async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		let gotoSuccess = true;
		try {
			await pageA.goto(url, { waitUntil: 'domcontentloaded' });
		} catch (err){
			gotoSuccess = false;
		}

		assert.isTrue(gotoSuccess);
	});	

	it('webstrate object becomes available', async () => {
		const webstrateObjectAvailable = await util.waitForFunction(pageA, () => {
			if (!window.webstrate) return false;

			window.webstrate.on('loaded', webstrateId => {
				window.__test_pageLoaded = true;
				window.__test_webstrateId = webstrateId;
			});
			return true;
		});
		assert.isTrue(webstrateObjectAvailable);
	});

	it('loaded event gets triggered', async () => {
		const pageLoadedVariableSet = await util.waitForFunction(pageA, () => window.__test_pageLoaded);
		assert.isTrue(pageLoadedVariableSet);
	});

	it('webstrateId from loaded event matches requested webstrateId', async () => {
		const loadedEventWebstrateId = await pageA.evaluate(() => window.__test_webstrateId);
		assert.equal(loadedEventWebstrateId, webstrateId);
	});

	it('webstrate.loaded gets set to true', async () => {
		const loadedIsTruthy = await util.waitForFunction(pageA, () => window.webstrate.loaded);
		assert.isTrue(loadedIsTruthy);
	});

	it('webstrate.webstrateId matches requested webstrateId', async () => {
		const webstrateObjectWebstrateId = await pageA.evaluate(() => window.webstrate.webstrateId);
		assert.equal(webstrateObjectWebstrateId, webstrateId);
	});

	it('the webstrate has an initial revision history of 1', async ()=>{
		// The document's creation commits asynchronously; the ?v snapshot page can be
		// served before that commit lands and show an earlier state. Poll until the
		// version settles, with the browser cache disabled so every poll refetches.
		let version = 0;
		for (let tries = 0; tries < 20 && version !== 1; tries++) {
			await pageA.setCacheEnabled(false);
			await pageA.goto(url + '?v', { waitUntil: 'domcontentloaded' });
			try {
				version = (await pageA.evaluate(() =>
					JSON.parse(document.querySelector('body').innerText))).version;
			} catch (err) {
				// An error body instead of the version snapshot — retry.
				version = 0;
			}
			if (version !== 1) await util.sleep(0.25);
		}

		assert.equal(version, 1, 'Version should be 1 after creation');
	});

	it('should be able to delete a webstrate', async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await pageA.goto(url + '?v', { waitUntil: 'domcontentloaded' });

		const innerText = await pageA.evaluate(() =>
			JSON.parse(document.querySelector('body').innerText));

		if (innerText.version !== 0) {
			util.warn('Unable to clean up after ourselves, left webstrate', webstrateId, 'on server');
		}

		assert.equal(innerText.version, 0, 'Version should be 0');
	});
});

describe('Client version reload', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser;

	after(async () => {
		// Best-effort cleanup of the webstrate created above.
		await fetch(url + '?delete').catch(() => {});
		if (browser) await browser.close();
	});

	it('serves the client bundle under a versioned, immutably cacheable URL', async () => {
		const page = await fetch(url);
		assert.include(page.headers.get('cache-control') || '', 'no-store',
			'the skeleton must never be cached, so it always references the current bundle');
		const html = await page.text();
		const hash = /\/webstrates_([0-9a-f]+)\.js/.exec(html);
		assert.isNotNull(hash, 'skeleton references a hashed webstrates_<hash>.js URL');

		const bundle = await fetch(config.server_address + 'webstrates_' + hash[1] + '.js');
		assert.equal(bundle.status, 200, 'the hashed bundle is served');
		assert.include(bundle.headers.get('cache-control') || '', 'immutable',
			'the hashed bundle is served as immutable, so it can be cached forever');
	});

	it('announces the client version it is shipping on every websocket connection', async () => {
		const wsUrl = config.server_address.replace(/^http/, 'ws') + webstrateId;
		const clientVersion = await util.clientVersion();

		// Any websocket connection (no query params, no version handshake of our own) is
		// first told which client version the server ships; frames are then processed as
		// before, here: ShareDB's handshake reply. Comparing the announced version against
		// the one embedded in its bundle (serverConfig.clientVersion) is up to the client —
		// the server never refuses a connection.
		const messages = await new Promise((resolve) => {
			const socket = new WebSocket(wsUrl);
			const seen = [];
			socket.on('message', data => seen.push(JSON.parse(data.toString())));
			socket.on('message', data => {
				if (JSON.parse(data.toString()).a === 'hs') {
					socket.close();
					resolve(seen);
				}
			});
			socket.on('open', () => socket.send(JSON.stringify({ a: 'hs' })));
			socket.on('error', () => {});
			setTimeout(() => { socket.terminate(); resolve(null); }, 5000);
		});
		assert.isNotNull(messages, 'no ShareDB handshake reply within 5 seconds');
		assert.deepEqual(messages[0], { wa: 'version', v: clientVersion },
			'the first frame on a connection announces the current client version');
		assert.ok(messages.some(m => m.a === 'hs'), 'frames are processed as before');
	});

	it('reloads the page when the server announces a different client version', async () => {
		browser = await puppeteer.launch();
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded);

		// Pretend the page is running a different build and force a websocket reconnect: the
		// client must notice the mismatch with the server's announced version, abort the
		// connection (rather than reconnect and submit anything) and reload the page after
		// a ~5 second wait, after which it is connected again with the real version.
		await page.evaluate(() => {
			window.webstrate.config.serverConfig.clientVersion = '0000000000000000';
		});
		const navigation = page.waitForNavigation({ timeout: 20000 });
		await page.evaluate(() => window.webstrate.getWebsocket().refresh());
		await navigation;

		const clientVersion = await util.clientVersion();
		assert.equal(await page.evaluate(() => window.webstrate.config.serverConfig.clientVersion),
			clientVersion, 'after the reload the page runs the current build again');
		assert.isTrue(await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded), 'the reloaded page reconnects');
	});
});

// Basic auth coverage: when basic auth is enabled, every surface of the server must be
// gated by it — the webstrate pages and JSON API (already covered by the old gate's
// position), the client skeleton and client bundles, and, critically, the websocket
// data plane: the websocket is how documents are read and written, so an upgrade that
// slips past the gate exposes the entire document model. 
describe('Basic auth coverage (websocket included)', function() {
	this.timeout(30000);

	const CREDENTIALS = { username: 'auth-test-user', password: 'auth-test-pass' };
	const authHeader = 'Basic '
		+ Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.password}`).toString('base64');
	const wrongAuthHeader = 'Basic '
		+ Buffer.from(`${CREDENTIALS.username}:wrong-password`).toString('base64');

	const webstrateId = 'test-basicauth-' + util.randomString();
	let server;

	before(async () => {
		server = await harness.startServer({
			label: 'basicauth',
			config: { basicAuth: { realm: 'webstrate', ...CREDENTIALS } }
		});
	});

	after(async () => {
		// Best-effort cleanup of the webstrate created by the browser test above
		// (credentials required now — the delete route is gated like everything else).
		await fetch(`${server.address}${webstrateId}/?delete`,
			{ headers: { authorization: authHeader } }).catch(() => {});
		await server.stop();
	});

	// What status does a websocket upgrade to `path` get? Resolves with the HTTP status
	// the server answered the upgrade with; rejects if the upgrade is accepted (the
	// socket opens) — for these "must be gated" tests an accepted upgrade IS the failure.
	const wsUpgradeStatus = (path, headers) => new Promise((resolve, reject) => {
		const socket = new WebSocket(server.address.replace(/^http/, 'ws') + path, { headers });
		const fail = (what) => reject(new Error(`websocket ${path}: ${what}`));
		socket.on('unexpected-response', (request, response) => resolve(response.statusCode));
		socket.on('open', () => { socket.close(); fail('upgrade accepted without authorization'); });
		socket.on('error', () => {}); // expected after a rejected upgrade; already resolved
		setTimeout(() => fail('no answer within 5 seconds'), 5000);
	});

	// --- Without credentials: everything answers 401, the websocket included. ---

	it('rejects the webstrate page without credentials', async () => {
		const res = await fetch(server.address + webstrateId + '/');
		assert.equal(res.status, 401);
	});

	it('rejects the ?json API without credentials', async () => {
		const res = await fetch(server.address + webstrateId + '/?json');
		assert.equal(res.status, 401);
	});

	it('rejects the client skeleton (client.html) without credentials', async () => {
		const res = await fetch(server.address + 'client.html');
		assert.equal(res.status, 401);
	});

	it('rejects the legacy client bundle URL without credentials', async () => {
		const res = await fetch(server.address + 'webstrates.js', { redirect: 'manual' });
		assert.equal(res.status, 401);
	});

	it('rejects the websocket upgrade without credentials', async () => {
		assert.equal(await wsUpgradeStatus(webstrateId), 401,
			'the websocket is the document data plane; it must not slip past basic auth');
	});

	it('rejects the websocket upgrade with wrong credentials', async () => {
		assert.equal(await wsUpgradeStatus(webstrateId, { authorization: wrongAuthHeader }), 401);
	});

	// --- With credentials: everything keeps working, the websocket included. ---

	it('serves the webstrate page with credentials', async () => {
		const res = await fetch(server.address + webstrateId + '/',
			{ headers: { authorization: authHeader } });
		assert.equal(res.status, 200);
	});

	it('serves the client skeleton with credentials', async () => {
		const res = await fetch(server.address + 'client.html',
			{ headers: { authorization: authHeader } });
		assert.equal(res.status, 200);
	});

	it('redirects the legacy client bundle URL to the hashed bundle with credentials',
		async () => {
			const res = await fetch(server.address + 'webstrates.js',
				{ redirect: 'manual', headers: { authorization: authHeader } });
			assert.equal(res.status, 302);
			const location = res.headers.get('location') || '';
			const hash = /webstrates_([0-9a-f]+)\.js/.exec(location);
			assert.isNotNull(hash, 'the redirect points at a hashed bundle');
			const bundle = await fetch(server.address + location.replace(/^\//, ''),
				{ headers: { authorization: authHeader } });
			assert.equal(bundle.status, 200, 'the redirected-to bundle is served');
		});

	it('accepts the websocket upgrade with credentials and speaks the data protocol',
		async () => {
			const firstFrame = await new Promise((resolve, reject) => {
				const socket = new WebSocket(server.address.replace(/^http/, 'ws') + webstrateId,
					{ headers: { authorization: authHeader } });
				const timer = setTimeout(
					() => reject(new Error('no server frame within 5 seconds')), 5000);
				socket.on('message', (data) => {
					clearTimeout(timer);
					socket.close();
					resolve(JSON.parse(data.toString()));
				});
				socket.on('unexpected-response', (request, response) => {
					clearTimeout(timer);
					reject(new Error('upgrade rejected with ' + response.statusCode));
				});
				socket.on('error', () => {});
			});
			// The version middleware announces the shipped client version on connect, so
			// any webstrates-protocol frame proves the data plane answers behind the gate.
			assert.isNotNull(firstFrame.wa, 'server speaks the webstrates ws protocol');
		});

	it('loads a full webstrate in a browser behind basic auth (page and websocket)',
		async () => {
			const browser = await puppeteer.launch();
			try {
				const page = await browser.newPage();
				await page.authenticate(CREDENTIALS);
				await page.goto(server.address + webstrateId + '/',
					{ waitUntil: 'domcontentloaded' });
				// The page's websocket upgrade and its ShareDB traffic have to carry the
				// basic auth credentials too, or the client never gets past connecting.
				const loaded = await util.waitForFunction(page,
					() => window.webstrate && window.webstrate.loaded);
				assert.isTrue(loaded, 'the webstrate client connects and loads its document');
			} finally {
				await browser.close();
			}
		});
});
