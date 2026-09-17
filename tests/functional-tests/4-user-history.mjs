import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('User history', function () {
	this.timeout(20000);

	// Webstrate ids are URL segments, so ids may well contain dots. The user history records
	// each visited webstrate under its id, and the ids below are unique per run so entries
	// never leak between runs of the suite or between test files sharing the test user.
	const suffix = util.randomString();
	const dottedWebstrateId = `test-${suffix}.a.b.c`;
	const plainWebstrateId = `test-${suffix}-plain`;
	// The first dot-separated segment of the dotted id: if the server stored the history
	// entry on a nested path, this is the key the history listing would surface instead of
	// the full id.
	const dottedIdPrefix = `test-${suffix}`;

	const dottedUrl = config.server_address + dottedWebstrateId + '/';
	const plainUrl = config.server_address + plainWebstrateId + '/';

	let browser, page;

	// The history action is a websocket protocol of its own: the client library always sends
	// a number as the limit, but any client may send whatever it likes. These tests speak
	// the raw protocol for the limit, so they pin down what the server does on its own,
	// without the client library smoothing anything over.
	const rawUserHistoryRequest = (page_, options) => {
		const token = 'userhistory-' + util.randomString();
		return page_.evaluate((webstrateId, options, token) => {
			// options === null means "send no options field at all".
			const message = { wa: 'userHistory', d: webstrateId, token };
			if (options !== null) message.options = options;

			return new Promise((resolve) => {
				const socket = new window.WebSocket(`ws://${window.location.host}/${webstrateId}/`);
				const finish = (reply) => {
					try { socket.close(); } catch { /* the socket may already be gone. */ }
					resolve(reply);
				};
				setTimeout(() => finish({ error: 'timeout waiting for userHistory reply' }), 5000);
				socket.onerror = () => finish({ error: 'websocket error' });
				socket.onopen = () => {
					// ShareDB expects a handshake before the connection settles into anything
					// usable, so open with one we don't rely on before sending the actual action.
					socket.send(JSON.stringify({ a: 'hs', id: null, protocol: 1, protocolMinor: 2 }));
					setTimeout(() => socket.send(JSON.stringify(message)), 200);
				};
				socket.onmessage = (event) => {
					const reply = JSON.parse(event.data);
					if (reply.wa === 'reply' && reply.token === token) finish(reply);
				};
			});
		}, plainWebstrateId, options, token);
	};

	// The history reply carries each timestamp as an ISO date string; a nested-garbage
	// entry would show up as an object instead and fail this check.
	const isRecentIsoDate = (value) => {
		if (typeof value !== 'string') return false;
		const time = Date.parse(value);
		return !Number.isNaN(time) && time <= Date.now() && time > Date.now() - 60000;
	};

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();

		if (config.authType === 'test') {
			console.log('Logging in testuserA...');
			await util.logInToTest(page, 'testuserA');
			console.log('Logged in testuserA...');
		}
	});

	after(async () => {
		if (config.authType !== 'test') {
			util.warn('Skipping user history tests as no test auth provider was used');
			return;
		}

		// Avoid puppeteer's goto hang on redirects to cached documents.
		await page.setCacheEnabled(false);
		await page.goto(dottedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		await page.goto(plainUrl + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('Webstrates with dots in their ids show up in the user history', async function () {
		if (config.authType !== 'test') return this.skip();

		await page.goto(dottedUrl, { waitUntil: 'networkidle2' });

		await page.evaluate(async () => {
			document.body.setAttribute('data-history-probe', 'first');
			await window.webstrate.dataSaved();
		});

		const history = await page.evaluate(() => window.webstrate.user.history());

		assert.isDefined(history[dottedWebstrateId],
			'The dotted webstrate id is missing from the user history');
		assert.isTrue(isRecentIsoDate(history[dottedWebstrateId]),
			'The history entry of the dotted webstrate is not a recent timestamp: '
			+ JSON.stringify(history[dottedWebstrateId]));

		// An id stored on a nested path would surface under its first dot-separated
		// segment instead of the full id.
		assert.isUndefined(history[dottedIdPrefix],
			'The history contains an entry under a prefix of the dotted webstrate id');
	});

	it('A second activity updates the existing history entry', async function () {
		if (config.authType !== 'test') return this.skip();

		const historyBefore = await page.evaluate(() => window.webstrate.user.history());
		const timestampBefore = Date.parse(historyBefore[dottedWebstrateId]);

		// Make sure the second entry gets its own timestamp.
		await util.sleep(0.05);

		await page.evaluate(async () => {
			document.body.setAttribute('data-history-probe', 'second');
			await window.webstrate.dataSaved();
		});

		const historyAfter = await page.evaluate(() => window.webstrate.user.history());

		assert.isTrue(isRecentIsoDate(historyAfter[dottedWebstrateId]),
			'The updated history entry is not a recent timestamp: '
			+ JSON.stringify(historyAfter[dottedWebstrateId]));
		assert.isAtLeast(Date.parse(historyAfter[dottedWebstrateId]), timestampBefore,
			'The history entry of the dotted webstrate was not updated');
	});

	it('Activity in a webstrate without dots is also recorded in the history', async function () {
		if (config.authType !== 'test') return this.skip();

		await page.goto(plainUrl, { waitUntil: 'networkidle2' });

		await page.evaluate(async () => {
			document.body.setAttribute('data-history-probe', 'plain');
			await window.webstrate.dataSaved();
		});

		const history = await page.evaluate(() => window.webstrate.user.history());

		assert.isTrue(isRecentIsoDate(history[plainWebstrateId]),
			'The plain webstrate is missing from the user history with a recent timestamp');
		// The dotted webstrate from the previous tests is still there, so both kinds of
		// ids live side by side in the history.
		assert.isTrue(isRecentIsoDate(history[dottedWebstrateId]),
			'The dotted webstrate disappeared from the user history');
	});

	it('A negative history limit still gets an answer', async function () {
		if (config.authType !== 'test') return this.skip();

		// A negative limit is not a valid $limit argument, and handing it on to the database
		// would make the request fail without the client ever receiving a reply.
		const reply = await rawUserHistoryRequest(page, { limit: -5 });

		assert.isUndefined(reply.error, 'The history request failed: ' + reply.error);

		const entries = Object.keys(reply.reply);
		assert.equal(entries.length, 1, 'A negative limit should be clamped to a single entry, got: '
			+ JSON.stringify(reply.reply));
	});

	it('History requests with unusable limits fall back to the default limit', async function () {
		if (config.authType !== 'test') return this.skip();

		// Non-numeric limits, zero, and a request without any options at all: all of them
		// should be served with the default limit rather than failing.
		for (const options of [{ limit: 'garbage' }, { limit: 0 }, null]) {
			const reply = await rawUserHistoryRequest(page, options);

			assert.isUndefined(reply.error,
				'The history request with options ' + JSON.stringify(options) + ' failed: '
				+ reply.error);

			assert.isDefined(reply.reply[plainWebstrateId],
				'The history reply with options ' + JSON.stringify(options)
				+ ' does not include the plain webstrate');
			assert.isDefined(reply.reply[dottedWebstrateId],
				'The history reply with options ' + JSON.stringify(options)
				+ ' does not include the dotted webstrate');
		}
	});
});
