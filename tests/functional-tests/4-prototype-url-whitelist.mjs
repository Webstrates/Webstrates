// These tests run against their own server instances with deliberately
// narrow prototypeUrlWhitelist patterns, so they can pin exactly where the
// whitelist lets a fetch through: not on other paths, not on other hosts,
// not for other schemes, not through notations that only look whitelisted,
// and not across a redirect that leaves the matching URLs.
/* global describe before after it */
import { assert } from 'chai';
import fs from 'node:fs';
import http from 'node:http';
import harness from '../lib/server-harness.mjs';
import util from '../util.js';

describe('HTTP API: /new?prototypeUrl= whitelist', function() {
	this.timeout(30000);

	// Served inside every body the mock hands out: only a fetch the
	// whitelist actually allowed can ever store it in a webstrate.
	const marker = 'prototype-url-whitelist-marker-' + util.randomString();

	// Webstrates the allowed cases create, so after() can clean up.
	const createdWebstrateIds = [];

	let ownServer, mockServer, mockPort;

	const fetchPrototype = (path, id) =>
		fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://localhost:${mockPort}${path}`), { redirect: 'manual' });

	const freshId = () => 'whitelist-' + util.randomString();

	// Asserts the webstrate <id> does not exist (a refused fetch must not
	// leave one behind).
	const assertNoWebstrate = async (id) => {
		const response = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(response.status, 404, `No webstrate should have been created for ${id}`);
	};

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist',
			config: {
				// Only this prefix is whitelisted: anything else — other
				// paths, other hosts, other schemes — must be refused.
				// Redirects are re-checked against the same patterns, so a
				// redirect from an allowed URL to a non-matching one must be
				// refused too.
				prototypeUrlWhitelist: ['^http://localhost:\\d+/allowed/']
			}
		});
		// The harness reports the effective configuration (sample ← base ←
		// overrides): the whitelist must have survived the merge, or the
		// tests below would run against the defaults.
		assert.deepEqual(ownServer.config.prototypeUrlWhitelist, ['^http://localhost:\\d+/allowed/']);

		mockServer = http.createServer((req, res) => {
			const path = req.url.split('?')[0];
			if (path === '/allowed/redirect-ok') {
				// Relative Location: resolved against the current URL, then
				// whitelist-checked like any other hop.
				res.writeHead(302, { Location: 'doc' });
				return res.end();
			}
			if (path === '/allowed/redirect-out') {
				// A redirect to a URL the whitelist does not match: following
				// it would leave the whitelisted servers.
				res.writeHead(302, { Location: `http://localhost:${mockPort}/blocked` });
				return res.end();
			}
			if (path === '/allowed/loop') {
				// A redirect to itself: the follow budget (five hops) is the
				// only bound on the chain.
				res.writeHead(302, { Location: '/allowed/loop' });
				return res.end();
			}
			if (path === '/allowed/redirect-bad') {
				// A Location no URL parser accepts.
				res.writeHead(302, { Location: 'http://[' });
				return res.end();
			}
			if (path === '/allowed/redirect-noloc') {
				// A 3xx without a Location header.
				res.writeHead(302);
				return res.end();
			}
			if (path === '/allowed/redirect-ftp') {
				// A Location to a non-http(s) scheme.
				res.writeHead(302, { Location: `ftp://localhost:${mockPort}/allowed/doc` });
				return res.end();
			}
			if (path === '/allowed/doc' || path === '/blocked') {
				res.writeHead(200, { 'Content-Type': 'text/html' });
				return res.end(`<html><body>${marker}</body></html>`);
			}
			res.writeHead(404);
			res.end();
		});
		// Dual stack where IPv6 is available (plain IPv4 otherwise), so the
		// mock answers on localhost and 127.0.0.1 alike — the refusals below
		// then prove the whitelist decided, not connectivity.
		await new Promise((resolve, reject) => {
			mockServer.once('error', reject);
			mockServer.listen(0, '::', () => {
				mockServer.removeListener('error', reject);
				resolve();
			});
		}).catch(async () => {
			await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
		});
		mockPort = mockServer.address().port;
	});

	after(async () => {
		// Clean up any webstrates the allowed cases created, before stopping
		// the server they live on.
		for (const webstrateId of createdWebstrateIds) {
			await fetch(`${ownServer.address}${webstrateId}/?delete`).catch(() => {});
		}
		await new Promise(resolve => mockServer.close(resolve));
		await ownServer.stop();
	});

	it('creates a webstrate from a URL matching the whitelist', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/doc', id);
		assert.equal(response.status, 302, 'the whitelisted URL should create a webstrate');
		assert.include(response.headers.get('location') || '', id,
			'the redirect should point at the created webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the fetched body must have been imported');
	});

	it('refuses a URL whose path the whitelist does not match', async () => {
		const id = freshId();
		const response = await fetchPrototype('/blocked', id);
		assert.equal(response.status, 409, 'the non-matching URL must be refused');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a URL whose host the whitelist does not match', async () => {
		// 127.0.0.1 reaches the very same mock (it listens dual stack), so
		// this refusal is the whitelist's, not the network's.
		const id = freshId();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://127.0.0.1:${mockPort}/allowed/doc`), { redirect: 'manual' });
		assert.equal(response.status, 409, 'the other host must be refused');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a host that only resembles the whitelisted one', async () => {
		const id = freshId();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://localhost.evil.example:${mockPort}/allowed/doc`),
		{ redirect: 'manual' });
		assert.equal(response.status, 409, 'the lookalike host must be refused');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a URL that smuggles a foreign host past the pattern as userinfo', async () => {
		// The URL only looks like it starts at localhost; the connection
		// would go to evil.example, whose userinfo the href carries in front
		// of the whitelisted form.
		const id = freshId();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://localhost:${mockPort}@evil.example/allowed/doc`),
		{ redirect: 'manual' });
		assert.equal(response.status, 409, 'the userinfo-smuggled host must be refused');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a URL whose dot segments leave the matching paths', async () => {
		// Raw, the URL starts with the whitelisted /allowed/ prefix; parsed,
		// the dot segments normalize to /blocked. The whitelist must see the
		// normalized href the fetch would request.
		const id = freshId();
		const response = await fetchPrototype('/allowed/../blocked', id);
		assert.equal(response.status, 409, 'the dot-segmented URL must be refused');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('matches a mixed-case host through URL normalization', async () => {
		// Hostnames are case-insensitive, and the URL parser lowercases them
		// before the patterns ever run.
		const id = freshId();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://LOCALHOST:${mockPort}/allowed/doc`), { redirect: 'manual' });
		assert.equal(response.status, 302, 'the normalized host should match the whitelist');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the fetched body must have been imported');
	});

	it('follows a redirect to another URL matching the whitelist', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/redirect-ok', id);
		assert.equal(response.status, 302, 'the redirect chain should end in a webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the redirected fetch must have been imported');
	});

	it('refuses a redirect to a URL the whitelist does not match', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/redirect-out', id);
		assert.equal(response.status, 409, 'the redirect must not leave the whitelist');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a redirect Location that is not a parseable URL', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/redirect-bad', id);
		assert.equal(response.status, 409, 'the unparseable Location must be refused');
		assert.include(await response.text(), 'Invalid prototypeUrl.',
			'the refusal should use the curated message, not a raw parse error');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a 3xx response without a Location header', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/redirect-noloc', id);
		assert.equal(response.status, 409, 'a redirectless 3xx must be refused');
		assert.include(await response.text(), 'Invalid request. Received: 302',
			'the refusal should surface the unusable response status');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a redirect to a non-http(s) URL', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/redirect-ftp', id);
		assert.equal(response.status, 409, 'the ftp redirect target must be refused');
		assert.include(await response.text(), 'http(s)',
			'the refusal should say the redirect target scheme is not fetchable');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a redirect chain longer than five hops', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/loop', id);
		assert.equal(response.status, 409, 'the self-redirecting URL must be refused');
		assert.include(await response.text(), 'Too many redirects',
			'the refusal should say the redirect chain ran out of budget');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('refuses a prototypeUrl that is not an http(s) URL', async () => {
		const id = freshId();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`ftp://localhost:${mockPort}/allowed/doc`), { redirect: 'manual' });
		assert.equal(response.status, 409, 'non-http(s) URLs must be refused');
		assert.include(await response.text(), 'http(s)',
			'the refusal should say the URL scheme is not fetchable');
		await assertNoWebstrate(id);
	});
});

describe('HTTP API: /new?prototypeUrl= whitelist configuration', function() {
	this.timeout(30000);

	// The configuration these tests pin: patterns that cannot compile must
	// be skipped with a warning while the valid ones keep working.
	const marker = 'prototype-url-config-marker-' + util.randomString();

	const createdWebstrateIds = [];

	let ownServer, mockServer, mockPort;

	const fetchPrototype = (path, id) =>
		fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://localhost:${mockPort}${path}`), { redirect: 'manual' });

	const freshId = () => 'whitelist-config-' + util.randomString();

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist-config',
			config: {
				// One pattern that cannot compile — skipped with a warning —
				// next to one that works.
				prototypeUrlWhitelist: ['^http://localhost:\\d+/allowed/', '(']
			}
		});
		// Arrays are replaced wholesale by the harness merge, so the server
		// runs exactly this whitelist.
		assert.deepEqual(ownServer.config.prototypeUrlWhitelist,
			['^http://localhost:\\d+/allowed/', '(']);

		mockServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(`<html><body>${marker}</body></html>`);
		});
		await new Promise((resolve, reject) => {
			mockServer.once('error', reject);
			mockServer.listen(0, '127.0.0.1', () => {
				mockServer.removeListener('error', reject);
				resolve();
			});
		});
		mockPort = mockServer.address().port;
	});

	after(async () => {
		for (const webstrateId of createdWebstrateIds) {
			await fetch(`${ownServer.address}${webstrateId}?delete`).catch(() => {});
		}
		await new Promise(resolve => mockServer.close(resolve));
		await ownServer.stop();
	});

	it('skips patterns that do not compile and keeps the valid ones', async () => {
		const id = freshId();
		const response = await fetchPrototype('/allowed/doc', id);
		assert.equal(response.status, 302, 'the valid pattern must still let the fetch through');
		assert.include(response.headers.get('location') || '', id,
			'the redirect should point at the created webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the fetched body must have been imported');
	});

	it('warns about patterns that do not compile', async () => {
		// The warning fires when the whitelist is first compiled, which the
		// fetch above has done by now.
		const log = fs.readFileSync(ownServer.logFile, 'utf8');
		assert.include(log, 'Ignoring invalid prototypeUrlWhitelist pattern: (');
	});
});

describe('HTTP API: /new?prototypeUrl= non-array whitelist', function() {
	this.timeout(30000);

	// A whitelist key that is not an array at all (here: null, what an
	// operator might write to switch the guard off) is NOT padded back to
	// the sample default the way an empty array is — it yields no patterns,
	// so every prototypeUrl must be refused, and the server says so.
	let ownServer;

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist-nonarray',
			config: {
				// The harness replaces non-object overrides wholesale, so the
				// null reaches the server's config verbatim.
				prototypeUrlWhitelist: null
			}
		});
		// The merge must not have papered the null over with an array (the
		// sample default), or the tests below would not exercise the
		// non-array path at all.
		assert.strictEqual(ownServer.config.prototypeUrlWhitelist, null);
	});

	after(async () => {
		await ownServer.stop();
	});

	it('refuses every URL when the whitelist is not an array', async () => {
		// Even a URL the shipped default would carry: a non-array is not
		// padded back to the sample, so nothing is whitelisted at all. The
		// refusal happens before any fetch, so this needs no network.
		const id = 'whitelist-nonarray-' + util.randomString();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent('https://github.com/Webstrates/tutorials/blob/' +
				'master/chat-system/chat-system.html'), { redirect: 'manual' });
		assert.equal(response.status, 409, 'a non-array whitelist must deny everything');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		const json = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(json.status, 404, `No webstrate should have been created for ${id}`);
	});

	it('warns that the whitelist key is not an array', async () => {
		// The warning fires when the whitelist is first compiled, which the
		// refusal above has done by now.
		const log = fs.readFileSync(ownServer.logFile, 'utf8');
		assert.include(log, 'config.prototypeUrlWhitelist is not an array; ' +
			'no URL is whitelisted.');
	});
});

describe('HTTP API: /new?prototypeUrl= default whitelist from config-sample.json', function() {
	this.timeout(60000);

	// The default lives in config-sample.json only: its prototypeUrlWhitelist
	// entry is merged under every configuration, and a key that is explicitly
	// empty is padded back to it (helpers/ConfigHelper.js) — so a server
	// configured with [] runs the shipped default. github.com serves its
	// pages as text/html, so a blob URL from the Webstrates organization
	// imports as a webstrate out of the box.
	const createdWebstrateIds = [];

	let ownServer;

	const fetchPrototype = (url, id) =>
		fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=${encodeURIComponent(url)}`,
			{ redirect: 'manual' });

	const freshId = () => 'whitelist-sample-' + util.randomString();

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist-sample',
			config: {
				// An empty array: the generated config file carries it, and
				// the server's own ConfigHelper merge pads it back to the
				// sample's entry — the shipped default in force.
				prototypeUrlWhitelist: []
			}
		});
		// The harness reports the generated file's contents (empty), not the
		// server-side padding — the tests below observe the padding through
		// what the server lets through.
		assert.deepEqual(ownServer.config.prototypeUrlWhitelist, []);
	});

	after(async () => {
		for (const webstrateId of createdWebstrateIds) {
			await fetch(`${ownServer.address}${webstrateId}?delete`).catch(() => {});
		}
		await ownServer.stop();
	});

	it('refuses a localhost URL the shipped default does not carry', async () => {
		// The gate refuses before any fetch, so no mock is needed for this.
		const id = freshId();
		const response = await fetchPrototype('http://localhost:7007/', id);
		assert.equal(response.status, 409, 'the sample default must not include localhost');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		const json = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(json.status, 404, `No webstrate should have been created for ${id}`);
	});

	it('fetches a Webstrates repository on GitHub through the sample default', async () => {
		const id = freshId();
		const response = await fetchPrototype('https://github.com/Webstrates/tutorials/blob/' +
			'master/chat-system/chat-system.html', id);
		assert.equal(response.status, 302, 'the sample default must allow the Webstrates repos');
		assert.include(response.headers.get('location') || '', id,
			'the redirect should point at the created webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, 'chat-system.html',
			'the created webstrate should contain the fetched GitHub page');
	});
});

describe('HTTP API: /new?prototypeUrl= whitelist with no valid patterns', function() {
	this.timeout(30000);

	// Every entry is skipped with a warning — '(' does not compile, null is
	// not a pattern — so nothing remains whitelisted and every prototypeUrl
	// must be refused, including URLs the built-in default would carry.
	let ownServer;

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist-empty',
			config: {
				prototypeUrlWhitelist: ['(', null]
			}
		});
		// Both entries survive the harness merge wholesale (and the
		// production ConfigHelper merge), so the server really sees them.
		assert.deepEqual(ownServer.config.prototypeUrlWhitelist, ['(', null]);
	});

	after(async () => {
		await ownServer.stop();
	});

	it('refuses every URL when no configured pattern is valid', async () => {
		// A URL the default whitelist would carry, refused before any fetch
		// — this needs no network, the gate throws on its own.
		const id = 'whitelist-empty-' + util.randomString();
		const response = await fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent('https://github.com/Webstrates/tutorials/blob/' +
				'master/chat-system/chat-system.html'), { redirect: 'manual' });
		assert.equal(response.status, 409, 'an all-invalid whitelist must deny everything');
		assert.include(await response.text(), 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		const json = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(json.status, 404, `No webstrate should have been created for ${id}`);
	});

	it('warns about each skipped pattern', async () => {
		// The warnings fire when the whitelist is first compiled, which the
		// refusal above has done by now.
		const log = fs.readFileSync(ownServer.logFile, 'utf8');
		assert.include(log, 'Ignoring invalid prototypeUrlWhitelist pattern: (');
		assert.include(log, 'Ignoring invalid prototypeUrlWhitelist pattern: null');
	});
});

describe('HTTP API: /new?prototypeUrl= unanchored patterns admit lookalike hosts', function() {
	this.timeout(30000);

	// Patterns are substring tests: this one names no path delimiter, so it
	// also matches hosts that merely start with "localhost". The tests pin
	// that reality — a hostname-exact matcher would refuse below — which is
	// why the getPrototypeUrlWhitelist doc comment tells operators to
	// terminate hostnames with "/".
	const marker = 'prototype-url-unanchored-marker-' + util.randomString();

	const createdWebstrateIds = [];

	let ownServer, mockServer, mockPort;

	const fetchPrototype = (url, id) =>
		fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=${encodeURIComponent(url)}`,
			{ redirect: 'manual' });

	const freshId = () => 'whitelist-unanchored-' + util.randomString();

	before(async () => {
		ownServer = await harness.startServer({
			label: 'prototype-url-whitelist-unanchored',
			config: {
				// Deliberately delimiter-free: matches localhost and every
				// host prefixed "localhost".
				prototypeUrlWhitelist: ['^http://localhost']
			}
		});
		assert.deepEqual(ownServer.config.prototypeUrlWhitelist, ['^http://localhost']);

		mockServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(`<html><body>${marker}</body></html>`);
		});
		// Dual stack where IPv6 is available (plain IPv4 otherwise), so the
		// localhost control URL reaches the mock.
		await new Promise((resolve, reject) => {
			mockServer.once('error', reject);
			mockServer.listen(0, '::', () => {
				mockServer.removeListener('error', reject);
				resolve();
			});
		}).catch(async () => {
			await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
		});
		mockPort = mockServer.address().port;
	});

	after(async () => {
		for (const webstrateId of createdWebstrateIds) {
			await fetch(`${ownServer.address}${webstrateId}?delete`).catch(() => {});
		}
		await new Promise(resolve => mockServer.close(resolve));
		await ownServer.stop();
	});

	it('still fetches a URL the unanchored pattern names', async () => {
		const id = freshId();
		const response = await fetchPrototype(`http://localhost:${mockPort}/doc`, id);
		assert.equal(response.status, 302, 'the matching URL should create a webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the fetched body must have been imported');
	});

	it('admits a host that merely starts like the pattern', async () => {
		// localhost.invalid is a reserved, never-resolvable name (RFC 6761)
		// that still parses — and still matches the prefix pattern, so the
		// gate must let it through and the fetch must fail at DNS, not at
		// the whitelist. That is substring matching, live.
		const id = freshId();
		const response = await fetchPrototype(`http://localhost.invalid:${mockPort}/doc`, id);
		assert.equal(response.status, 409, 'the unresolvable lookalike must fail the request');
		const body = await response.text();
		assert.notInclude(body, 'whitelist',
			'the pattern matched: the failure must be the fetch, not the gate');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		const json = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(json.status, 404, `No webstrate should have been created for ${id}`);
	});
});
