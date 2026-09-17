/* global describe before after it */

import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// A client that reconnects resubscribes to its signal subscriptions the moment the new
// connection opens. Its document subscription is still catching up at that point (the
// ShareDB handshake has to complete before the document resubscribe is even sent), so the
// server parks those signal subscribes in its retry loop until the client has rejoined.
// This exercises that window with the real client: one page settles a document-signal
// subscription and keeps it, while another page severs its connection, reconnects and
// drops its signal listener again right while the server is still deferring that page's
// resubscribe. Unsubscribing in that window must only ever cancel the unsubscribing
// client's own pending subscription — the other client's settled subscription has to
// come out of it untouched.
describe('Signals', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageB = await browser.newPage();
		await Promise.all([
			pageA.goto(url, { waitUntil: 'networkidle2' }),
			pageB.goto(url, { waitUntil: 'networkidle2' })
		]);
		await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded)
		]);
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	// Wait for a page's signal subscription to settle on the server: the page publishes a
	// signal addressed to itself and waits to receive it back.
	const settleSubscription = async (page, name) => {
		await page.evaluate(() => {
			window.__signals = window.__signals || [];
			window.__listener = window.__listener || (message => window.__signals.push(message));
			window.webstrate.on('signal', window.__listener);
		});
		// A signal addressed to the page itself only comes back once its subscription has
		// settled on the server, so retry the round trip until it does.
		let settled = false;
		for (let attempt = 0; attempt < 10 && !settled; attempt++) {
			await page.evaluate(() => window.webstrate.signal('settled',
				window.webstrate.clientId));
			settled = await util.waitForFunction(page, () => window.__signals.includes('settled'), 0.5);
		}
		assert.isTrue(settled, `${name} should receive its own signal while connected`);
	};

	it('survives a reconnecting client that unsubscribes during its resubscribe', async () => {
		// Client B subscribes first, then client A, so A holds the most recently settled
		// subscription on the document node when B starts reconnecting below.
		await settleSubscription(pageB, 'client B');
		await settleSubscription(pageA, 'client A');

		const clientIdBefore = await pageB.evaluate(() => window.webstrate.clientId);

		// B severs its connection. The client reconnects on its own (after about a second),
		// resubscribes to its signal subscriptions as the new connection opens, and then
		// drops its signal listener again — while the server is still deferring that very
		// resubscribe. The client's subscription bookkeeping counts one subscription per
		// reconnect resubscribe, so removing the same listener a second time is what makes
		// the unsubscribe actually get sent.
		await pageB.evaluate(() => {
			window.__reconnected = false;
			window.webstrate.on('reconnect', () => {
				window.__reconnected = true;
				window.webstrate.off('signal', window.__listener);
				window.webstrate.off('signal', window.__listener);
			});
			window.webstrate.getWebsocket().refresh();
		});
		assert.isTrue(await util.waitForFunction(pageB, () => window.__reconnected, 10),
			'client B should reconnect after its connection was severed');
		// The new connection has rejoined the document (a new clientId arrives with the
		// join), which is also what lets B's deferred resubscribe land.
		const rejoined = await util.waitForFunction(pageB,
			(oldClientId) => window.webstrate.clientId !== oldClientId, 10, clientIdBefore);
		assert.isTrue(rejoined, 'client B should rejoin the document with a new clientId');

		// Let the deferred resubscribe and the document resubscribe settle.
		await new Promise(resolve => setTimeout(resolve, 1500));

		// A's subscription must be untouched by B's unsubscribe in the resubscribe window:
		// signals on the document still reach A.
		await pageA.evaluate(() => window.webstrate.signal('after-reconnect'));
		const aStillSubscribed = await util.waitForFunction(pageA,
			() => window.__signals.includes('after-reconnect'), 5);
		assert.isTrue(aStillSubscribed, 'client A should still receive signals after B\'s reconnect');
	});
});
