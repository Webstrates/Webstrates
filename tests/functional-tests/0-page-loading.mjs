// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

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

		// The pre-versioning URL now points at the current versioned bundle.
		const legacy = await fetch(config.server_address + 'webstrates.js', { redirect: 'manual' });
		assert.equal(legacy.status, 302);
		assert.equal(legacy.headers.get('location'), '/webstrates_' + hash[1] + '.js');
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