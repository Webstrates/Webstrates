// These tests run
// against their own server instance with prototypeUrlAllowlist=['localhost']
// and 1 MB caps, so every bomb is small: the mock origin below stands in for
// any host an attacker controls (or has compromised) that the server will
// fetch, and every case asserts both the refusal and that no webstrate was
// created from the bomb.
/* global describe before after it */
import { assert } from 'chai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { ZipArchive } from 'archiver';
import harness from '../lib/server-harness.mjs';
import util from '../util.js';

// Creates a ZIP archive in memory from a list of [name, data] entries.
const makeZip = (entries) => new Promise((resolve, reject) => {
	const archive = new ZipArchive();
	const chunks = [];
	archive.on('data', chunk => chunks.push(chunk));
	archive.on('warning', reject);
	archive.on('end', () => resolve(Buffer.concat(chunks)));
	archive.on('error', reject);
	entries.forEach(([name, data]) => archive.append(data, { name }));
	archive.finalize();
});

describe('HTTP API: /new?prototypeUrl= caps fetched bodies (gzip bomb)', function() {
	this.timeout(30000);

	// Served inside every successfully fetched body, so the controls prove the
	// right content actually arrived (and nothing else leaks into webstrates).
	const marker = 'prototype-url-cap-marker-' + util.randomString();

	// Webstrates the controls below create (bombs must never create any), so
	// after() can clean up after ourselves.
	const createdWebstrateIds = [];

	let ownServer, mockServer, mockPort;
	let drip, dripDone;

	const fetchPrototype = (path, id) =>
		fetch(`${ownServer.address}new/?id=${id}&prototypeUrl=` +
			encodeURIComponent(`http://localhost:${mockPort}${path}`), { redirect: 'manual' });

	const freshId = () => 'cap-' + util.randomString();

	// Peak resident set size of the server process (Linux /proc), or null
	// where unavailable: the max-ratio bomb test uses it to pin that the
	// decode aborts mid-expansion, before the full expansion is materialized.
	const serverPeakRssKb = () => {
		try {
			const status = fs.readFileSync(`/proc/${ownServer.child.pid}/status`, 'utf8');
			const match = status.match(/^VmHWM:\s+(\d+) kB/m);
			return match ? Number(match[1]) : null;
		} catch {
			return null;
		}
	};

	// Asserts the webstrate <id> does not exist (a bomb must not leave one behind).
	const assertNoWebstrate = async (id) => {
		const response = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(response.status, 404, `No webstrate should have been created for ${id}`);
	};

	before(async function () {
		this.timeout(90000);
		ownServer = await harness.startServer({
			label: 'prototype-url-body-caps',
			config: {
				prototypeUrlAllowlist: ['localhost'],
				maxPrototypeUrlRawSize: 1,
				maxPrototypeUrlDecodedSize: 1
			}
		});
		// The harness reports the effective configuration (sample ← base ←
		// overrides): the caps must have survived the merge, or the tests below
		// would run against 100 MB defaults instead of 1 MB.
		assert.strictEqual(ownServer.config.maxPrototypeUrlRawSize, 1);
		assert.strictEqual(ownServer.config.maxPrototypeUrlDecodedSize, 1);

		const html = Buffer.from(`<html><body>${marker}</body></html>`);
		const payload = {
			'/html': html,
			'/html-gzip': zlib.gzipSync(html),
			'/html-deflate': zlib.deflateSync(html),
			'/html-deflate-raw': zlib.deflateRawSync(html),
			'/zip-gzip': zlib.gzipSync(await makeZip([['index.html', html]])),
			// ~8 MB of expansions against the 1 MB decoded cap, each only a few
			// KB on the wire so the raw cap never trips first.
			'/bomb-gzip': zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61)),
			'/bomb-deflate': zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024)),
			'/bomb-deflate-raw': zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024)),
			// Three gzip members, each expanding to 512 KB (under the decoded
			// cap each, 1.5 MB in sum): only cumulative counting rejects this.
			'/bomb-multimember': Buffer.concat([
				zlib.gzipSync(Buffer.alloc(512 * 1024, 0x62)),
				zlib.gzipSync(Buffer.alloc(512 * 1024, 0x63)),
				zlib.gzipSync(Buffer.alloc(512 * 1024, 0x64))
			]),
			// A maximum-ratio bomb: eight members of 64 MB of zeros each, so
			// ~512 MB of expansion from ~500 KB on the wire (still under the
			// 1 MB raw cap, so the decoded cap is what must trip). Built from
			// per-member gzipSync calls so the test process itself never
			// materializes the 512 MB plain body at once.
			'/bomb-high-ratio': Buffer.concat(Array.from({ length: 8 },
				() => zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024)))),
			'/garbage-gzip': Buffer.from('definitely not gzip')
		};

		// The drip feed: incompressible bytes (32 KB random chunks paced
		// ~10 ms apart, up to the 2 MB budget — the guard ends the stream
		// after 63 chunks), with no Content-Length — the only case that
		// proves the raw cap counts bytes *as they are received*: a server
		// that only checks at end-of-body (or trusts Content-Length) receives
		// the whole budget, while the capped server's abort is visible as a
		// cut transfer.
		const dripChunk = crypto.randomBytes(32 * 1024);
		let settleDrip = null;
		dripDone = new Promise(resolve => { settleDrip = resolve; });

		mockServer = http.createServer((req, res) => {
			const path = req.url.split('?')[0];
			if (path === '/redirect-ok') {
				res.writeHead(302, { Location: '/html-gzip' });
				return res.end();
			}
			if (path === '/redirect-bomb') {
				res.writeHead(302, { Location: '/bomb-gzip' });
				return res.end();
			}
			if (path === '/bomb-identity') {
				res.writeHead(200, { 'Content-Type': 'text/html' });
				drip = { wrote: 0, finished: false };
				let timer = null;
				res.on('error', () => {}); // a write past the abort is expected
				const stop = () => {
					if (timer) { clearTimeout(timer); timer = null; }
				};
				// Self-terminating on both ends: when the response closes (the
				// server tore the transfer down) or finishes (the budget ran
				// out), the pacing stops and the suite can proceed — a lost
				// response must never leave a repeating timer behind.
				res.once('close', () => { stop(); settleDrip(); });
				res.once('finish', () => { stop(); drip.finished = true; settleDrip(); });
				const writeNext = () => {
					if (res.writableEnded || res.destroyed) return stop();
					if (drip.wrote + dripChunk.length >= 2 * 1024 * 1024) {
						return res.end();
					}
					drip.wrote += dripChunk.length;
					res.write(dripChunk);
					timer = setTimeout(writeNext, 10);
				};
				writeNext();
				return;
			}
			if (!(path in payload)) {
				res.writeHead(404);
				return res.end();
			}
			// No Content-Length on any route: chunked framing only, so nothing
			// can pass by trusting a declared length.
			const encodings = {
				'/html-gzip': 'gzip', '/zip-gzip': 'gzip', '/bomb-gzip': 'gzip',
				'/bomb-multimember': 'gzip', '/bomb-high-ratio': 'gzip',
				'/garbage-gzip': 'gzip',
				'/html-deflate': 'deflate', '/html-deflate-raw': 'deflate',
				'/bomb-deflate': 'deflate', '/bomb-deflate-raw': 'deflate'
			};
			const headers = { 'Content-Type': path === '/zip-gzip' ? 'application/zip' : 'text/html' };
			if (encodings[path]) headers['Content-Encoding'] = encodings[path];
			res.writeHead(200, headers);
			res.end(payload[path]);
		});
		// Dual stack where IPv6 is available (plain IPv4 otherwise), so both
		// resolutions of localhost reach the mock.
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
		// Clean up any webstrates the controls created, before stopping the
		// server they live on.
		for (const webstrateId of createdWebstrateIds) {
			await fetch(`${ownServer.address}${webstrateId}/?delete`).catch(() => {});
		}
		// closeAllConnections releases the drip route's socket if its transfer
		// is ever left open, so no request can hang the suite.
		mockServer.closeAllConnections?.();
		await new Promise(resolve => mockServer.close(resolve));
		await ownServer.stop();
	});

	// --- Controls: small bodies of every encoding must keep working. -------
	for (const [label, path] of [
		['identity', '/html'], ['gzip', '/html-gzip'],
		['zlib-wrapped deflate', '/html-deflate'], ['raw deflate', '/html-deflate-raw']
	]) {
		it(`creates a webstrate from a small ${label} body`, async () => {
			const id = freshId();
			const response = await fetchPrototype(path, id);
			assert.equal(response.status, 302, `${path} should create a webstrate`);
			assert.include(response.headers.get('location') || '', id,
				'the redirect should point at the created webstrate');
			createdWebstrateIds.push(id);
			const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
			assert.include(raw, marker, 'the fetched body must arrive decoded');
		});
	}

	it('creates a webstrate from a fetched, gzip-compressed ZIP', async () => {
		const id = freshId();
		const response = await fetchPrototype('/zip-gzip', id);
		assert.equal(response.status, 302, 'the ZIP import should succeed');
		createdWebstrateIds.push(id);
		const jsonResponse = await fetch(`${ownServer.address}${id}/?json`);
		assert.equal(jsonResponse.status, 200, 'the created webstrate should serve ?json');
		const json = await jsonResponse.text();
		assert.include(json, marker, 'the index.html content must survive the import');
	});

	it('follows a redirect and creates a webstrate from the final body', async () => {
		const id = freshId();
		const response = await fetchPrototype('/redirect-ok', id);
		assert.equal(response.status, 302, 'the redirect chain should end in a webstrate');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker, 'the final (gzip) body must arrive decoded');
	});

	// --- The decoded cap: bombs must abort mid-expansion, not materialize. --
	for (const [label, path] of [
		['gzip', '/bomb-gzip'], ['zlib-wrapped deflate', '/bomb-deflate'],
		['raw deflate', '/bomb-deflate-raw'], ['multi-member gzip', '/bomb-multimember']
	]) {
		it(`refuses a ${label} body that expands beyond the decoded cap`, async () => {
			const startedAt = Date.now();
			const id = freshId();
			const response = await fetchPrototype(path, id);
			assert.equal(response.status, 409, `${path} must be refused, not imported`);
			const body = await response.text();
			assert.include(body, 'prototypeUrl body expands beyond the maximum decoded size of 1 MB.');
			assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
			await assertNoWebstrate(id);
			// The cap must trip mid-expansion (milliseconds), not wait out the
			// 30 s fetch timeout.
			assert.isBelow(Date.now() - startedAt, 20000, 'the cap must trip, not the timeout');
		});
	}

	it('refuses a bomb reached through a redirect', async () => {
		const id = freshId();
		const response = await fetchPrototype('/redirect-bomb', id);
		assert.equal(response.status, 409, 'the redirect target must be capped all the same');
		assert.include(await response.text(),
			'prototypeUrl body expands beyond the maximum decoded size of 1 MB.');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	// --- The raw cap: counting must happen as bytes arrive. ----------------
	it('refuses an identity body that exceeds the raw cap', async function() {
		// The drip takes ~640 ms to reach the cap even on a loaded host.
		this.timeout(30000);
		const id = freshId();
		const response = await fetchPrototype('/bomb-identity', id);
		assert.equal(response.status, 409, 'the 2 MB identity body must be refused');
		assert.include(await response.text(),
			'prototypeUrl response exceeds the maximum raw size of 1 MB.');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
		await dripDone;
		assert.isFalse(drip.finished, 'the transfer should have been cut, not completed');
		// The writer paces at ~10 ms per 32 KB, so a server that only counts
		// at end-of-body receives all ~2 MB; the abort empirically lands at
		// ~1.03 MB. 1.5 MB leaves pacing slack while staying load-bearing:
		// a completed transfer writes 2,064,384 bytes (63 × 32 KB) and fails.
		assert.isBelow(drip.wrote, 1.5 * 1024 * 1024,
			'the server must have stopped receiving mid-transfer, not at end-of-body');
	});

	it('aborts a max-ratio bomb mid-expansion, never materializing it', async function() {
		// A decoder that counts output as it is produced rejects this after
		// ~1 MB; a decoder that materializes the whole body first and only
		// then checks (the original defect: one unbounded *Sync call) holds
		// the full ~512 MB in memory before rejecting — visible as the
		// server's peak RSS. /proc is Linux-only; elsewhere this degrades to
		// the same 409 assertions as the other bombs.
		this.timeout(30000);
		const peakBefore = serverPeakRssKb();
		const id = freshId();
		const response = await fetchPrototype('/bomb-high-ratio', id);
		assert.equal(response.status, 409, 'the max-ratio bomb must be refused');
		assert.include(await response.text(),
			'prototypeUrl body expands beyond the maximum decoded size of 1 MB.');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
		const peakAfter = serverPeakRssKb();
		if (peakBefore !== null && peakAfter !== null) {
			assert.isBelow(peakAfter - peakBefore, 150 * 1024,
				'the server must reject the body before materializing its ~512 MB expansion');
		}
	});

	it('fails cleanly on a corrupt gzip body', async () => {
		const id = freshId();
		const response = await fetchPrototype('/garbage-gzip', id);
		assert.equal(response.status, 409, 'undecodable bodies must surface as errors');
		const body = await response.text();
		assert.notInclude(body, 'maximum', 'a decode error must not be re-labelled a cap');
		assert.isNotOk(response.headers.get('location'), 'no webstrate should be created');
		await assertNoWebstrate(id);
	});

	it('stays responsive after the bomb attempts', async () => {
		// Asserts the bombs left no damage: the server process is still
		// alive (a leaked stream or unhandled 'error' would have crashed it)
		// and fetches still work end-to-end afterwards. (The abort-mid-
		// expansion property itself is pinned by the max-ratio bomb's
		// peak-RSS bound above.)
		assert.strictEqual(ownServer.child.exitCode, null, 'the server must still be alive');
		const id = freshId();
		const response = await fetchPrototype('/html-gzip', id);
		assert.equal(response.status, 302, 'a fetch after the bombs must still work');
		createdWebstrateIds.push(id);
		const raw = await (await fetch(`${ownServer.address}${id}/?raw`)).text();
		assert.include(raw, marker);
		const rootResponse = await fetch(ownServer.address, { redirect: 'manual' });
		assert.isBelow(rootResponse.status, 500, 'the server must answer ordinary requests');
	});
});
