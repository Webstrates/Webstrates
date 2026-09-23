// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import http from 'node:http';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// A plain text asset (not a ZIP) and a ZIP asset containing hello.txt and
// sub/file.txt, for testing the asset directory listing (?dir).
const NOT_A_ZIP_FILE = 'data:text/plain;base64,' + btoa('This is not a ZIP file.');
const REAL_ZIP_FILE = 'data:application/zip;base64,' +
	'UEsDBBQAAAAIAK5qL112hwFmEgAAABAAAAAJAAAAaGVsbG8udHh0y0jNyclXKE9NKi4pSixJLQYAUEsDBBQ' +
	'AAAAIAK5qL10AAAAAAgAAAAAAAAAEAAAAc3ViLwMAUEsDBBQAAAAIAK5qL13N82tGGgAAABgAAAAMAAAAc3Vi' +
	'L2ZpbGUudHh0S8vMSVXIzCvOTElVKC5NSsksSk0uyS+qBABQSwECFAMUAAAACACuai9ddocBZhIAAAAQAAAACQ' +
	'AAAAAAAAAAAAAAgAEAAAAAaGVsbG8udHh0UEsBAhQDFAAAAAgArmovXQAAAAACAAAAAAAAAAQAAAAAAAAAAAAQ' +
	'AP1BOQAAAHN1Yi9QSwECFAMUAAAACACuai9dzfNrRhoAAAAYAAAADAAAAAAAAAAAAAAAgAFdAAAAc3ViL2Zpb' +
	'GUudHh0UEsFBgAAAAADAAMAowAAAKEAAAAAAA==';

// Uploads an asset to the current webstrate through the HTTP API.
const uploadAssetByFetch = async (page, fileName, mimeType, base64Data) => {
	return await page.evaluate(async (fileName, mimeType, base64Data) => {
		const file = new File(
			[Uint8Array.from(atob(base64Data.split(',')[1]), char => char.charCodeAt(0))],
			fileName, { type: mimeType });
		const formData = new FormData();
		formData.append('file[]', file);
		const response = await fetch(location.pathname,
			{ method: 'POST', body: formData, credentials: 'include' });
		return await response.json();
	}, fileName, mimeType, base64Data);
};

describe('HTTP API', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async ()=>{
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageB = await browser.newPage();
	})

	after(async () => {
		await browser.close();
	});


	const webstrateIdRegex = (config.server && config.server.niceWebstrateIds)
		? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,3})'
		: '([A-z0-9-]{8,10})';

	it('/new redirects to random webstrateId matching ' + webstrateIdRegex, async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address + 'new', { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		const regex = '^' + util.escapeRegExp(config.server_address) + webstrateIdRegex + '/$';
		assert.match(redirectedUrl, new RegExp(regex));
	});

	it('root (/) redirects to /frontpage/', async () => {
		pageA = await browser.newPage();
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(config.server_address, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageA.url();
		assert.equal(redirectedUrl, config.server_address + 'frontpage/');
	});

	it('/new?prototypeUrl=htmlfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.html";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl="+testURL, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds (default is requestAnimationFrame or 100ms)
		});
	});

	it('/new?prototypeUrl=zipfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.zip";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl=" + testURL, { waitUntil: 'domcontentloaded' });

		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds (default is requestAnimationFrame or 100ms)
		});

		let testAsset = await pageB.evaluate(() => {
			return webstrate.assets[0];
		});

		assert.include(testAsset, {
			fileName: 'test-asset.ico', fileSize: 15086, mimeType: 'image/vnd.microsoft.icon'
		})
	});

	it('ZIP files serve their content (base)', async () => {
		let assetURL = pageB.url()+"test.zip/json_test.json";
		console.log(assetURL);

		pageA = await browser.newPage();
		await pageA.goto(assetURL, { waitUntil: 'domcontentloaded' });
		const pageContent = await pageA.evaluate(() => {
			return document.body.innerText;
		});

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'success', true, 'Could not find the success property in test zip json');
	});

	it('ZIP files serve their content (subdir)', async () => {
		let assetURL = pageB.url() + "test.zip/directory/json_test2.json";

		pageA = await browser.newPage();
		await pageA.goto(assetURL, { waitUntil: 'domcontentloaded' });
		const pageContent = await pageA.evaluate(() => {
			return document.body.innerText;
		});

		// Cleanup
		const redirectedUrl = pageB.url();
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'subdirectory', true, 'Could not find the subdirectory property in test zip json in a subdir');
	});

	it('?dir on a non-ZIP asset should return an error instead of crashing the server', async () => {
		const dirWebstrateId = 'test-' + util.randomString();
		const dirUrl = config.server_address + dirWebstrateId;

		pageA = await browser.newPage();
		await pageA.goto(dirUrl, { waitUntil: 'networkidle2' });
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 5);

		const notAZipAsset = await uploadAssetByFetch(pageA, 'notazip.txt', 'text/plain', NOT_A_ZIP_FILE);
		assert.equal(notAZipAsset.fileName, 'notazip.txt', 'Uploading the non-ZIP asset failed');

		const zipAsset = await uploadAssetByFetch(pageA, 'realzip.zip', 'application/zip', REAL_ZIP_FILE);
		assert.equal(zipAsset.fileName, 'realzip.zip', 'Uploading the ZIP asset failed');

		await pageA.goto(dirUrl + '/realzip.zip/?dir', { waitUntil: 'domcontentloaded' });
		let content = await pageA.evaluate(() => document.body.textContent);
		const zipStructure = JSON.parse(content);
		assert.isArray(zipStructure, '?dir on a ZIP asset should return a JSON array');
		assert.include(zipStructure, 'hello.txt', 'ZIP listing does not include hello.txt');
		assert.include(zipStructure, 'sub/file.txt', 'ZIP listing does not include sub/file.txt');

		await pageA.goto(dirUrl + '/realzip.zip/sub/', { waitUntil: 'domcontentloaded' });
		content = await pageA.evaluate(() => document.body.textContent);
		const subStructure = JSON.parse(content);
		assert.isArray(subStructure, 'Listing a ZIP subdirectory should return a JSON array');
		assert.include(subStructure, 'sub/file.txt', 'Subdirectory listing does not include sub/file.txt');

		// Used to kill the whole server process: the yauzl.open callback in
		// getZipStructure ignores its error and dereferences zipFile anyway.
		const response = await pageA.goto(dirUrl + '/notazip.txt/?dir', { waitUntil: 'domcontentloaded' });

		assert.isNotNull(response, 'Server did not respond to ?dir on a non-ZIP asset');
		assert.equal(response.status(), 409, '?dir on a non-ZIP asset should be rejected with 409');
		content = await pageA.evaluate(() => document.body.innerText);
		assert.include(content, 'is not a valid ZIP file',
			'Error response should state that the asset is not a valid ZIP file');

		await pageA.goto(dirUrl + '/notazip.txt', { waitUntil: 'domcontentloaded' });
		content = await pageA.evaluate(() => document.body.textContent);
		assert.equal(content, 'This is not a ZIP file.',
			'Server did not keep serving the non-ZIP asset after the ?dir request');

		// Cleanup
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await pageA.goto(dirUrl + '?delete', { waitUntil: 'domcontentloaded' });
	});

});
describe('HTTP API: /new?prototypeUrl= refuses internal addresses', function() {
	this.timeout(30000);

	// Marker served by the "internal" service below. If the server fetches an internal address
	// on behalf of an untrusted /new?prototypeUrl= request, this string ends up stored inside a
	// newly created webstrate — a server-side request forgery (SSRF) vulnerability.
	const internalSecret = 'internal-secret-' + util.randomString();

	// Webstrates created by the requests below (this only happens on a vulnerable server), so
	// that after() can clean up after ourselves.
	const createdWebstrateIds = [];

	let internalServer, internalPort;

	before(async () => {
		// A service that is only reachable on the loopback interfaces, i.e. only from the server
		// itself. It stands in for any internal service (a database admin console, cloud
		// metadata service, intranet host, ...) that an external attacker should not be able to
		// make the server fetch through prototypeUrl. Listening on '::' is dual stack on Linux,
		// so both the IPv4 and the IPv6 loopback forms below are live targets.
		internalServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(`<html><body>${internalSecret}</body></html>`);
		});
		// Listen dual stack where IPv6 is available, and fall back to plain IPv4 otherwise
		// (e.g. CI hosts without IPv6) — on such hosts the IPv6 loopback URL below simply
		// points at an unreachable address that the server must refuse all the same.
		await new Promise((resolve, reject) => {
			internalServer.once('error', reject);
			internalServer.listen(0, '::', () => {
				internalServer.removeListener('error', reject);
				resolve();
			});
		}).catch(async () => {
			await new Promise((resolve) => internalServer.listen(0, '127.0.0.1', resolve));
		});
		internalPort = internalServer.address().port;
	});

	after(async () => {
		await new Promise((resolve) => internalServer.close(resolve));

		// Clean up any webstrates the server created from the internal service's responses.
		for (const webstrateId of createdWebstrateIds) {
			await fetch(config.server_address + webstrateId + '?delete').catch(() => {});
		}
	});

	// Internal URLs in every notation that maps to the loopback service (on a vulnerable
	// server, each of these fetches the internal service and stores its body as a webstrate),
	// plus private and link-local addresses that must be refused all the same. The URL
	// factories are evaluated inside the tests, after before() has picked a port.
	const internalPrototypeUrls = [
		['loopback, ipv4', () => `http://127.0.0.1:${internalPort}/`],
		['loopback, this-network address (0.0.0.0)', () => `http://0.0.0.0:${internalPort}/`],
		['loopback, ipv4 as integer (2130706433)', () => `http://2130706433:${internalPort}/`],
		['loopback, ipv4 shorthand (127.1)', () => `http://127.1:${internalPort}/`],
		['loopback, ipv6', () => `http://[::1]:${internalPort}/`],
		['loopback, ipv4-mapped ipv6', () => `http://[::ffff:127.0.0.1]:${internalPort}/`],
		['loopback, ipv4-mapped ipv6 in hex', () => `http://[::ffff:7f00:1]:${internalPort}/`],
		['loopback, ipv4-compatible ipv6', () => `http://[::127.0.0.1]:${internalPort}/`],
		['loopback, nat64-embedded ipv4 (64:ff9b::/96)',
			() => `http://[64:ff9b::127.0.0.1]:${internalPort}/`],
		['loopback, 6to4-embedded ipv4 (2002::/16)',
			() => `http://[2002:7f00:1::]:${internalPort}/`],
		// Hostnames that resolve to loopback addresses: "localhost" through the server's own
		// name resolution, and a public DNS name (nip.io) that resolves to 127.0.0.1. The
		// server must neither trust its internal name resolution for prototypeUrl fetches nor
		// accept a hostname that resolves to an internal address.
		['hostname resolving to loopback (localhost)', () => `http://localhost:${internalPort}/`],
		['publicly resolvable hostname pointing at loopback (nip.io)',
			() => `http://127.0.0.1.nip.io:${internalPort}/`],
		// Private (RFC1918) and link-local (e.g. cloud metadata) addresses.
		['private address (10/8)', () => `http://10.0.0.1:${internalPort}/`],
		['private address (192.168/16)', () => `http://192.168.0.1:${internalPort}/`],
		['link-local address (169.254/16, e.g. cloud metadata)',
			() => `http://169.254.169.254:${internalPort}/`]
	];

	for (const [label, internalUrlFactory] of internalPrototypeUrls) {
		it(`refuses prototypeUrl pointing at internal address: ${label}`, async () => {
			const internalUrl = internalUrlFactory();
			const response = await fetch(config.server_address + 'new/?prototypeUrl=' +
				encodeURIComponent(internalUrl), { redirect: 'manual' });

			// Remember any webstrate the server created here, so after() can delete it again.
			// (On a vulnerable server this records exactly the evidence of the leak.)
			const location = response.headers.get('location');
			if (location) {
				createdWebstrateIds.push(new URL(location, config.server_address).pathname
					.replace(/^\//, '').replace(/\/+$/, ''));
			}

			// A vulnerable server fetches the internal service, creates a webstrate from the
			// response body and redirects to it (302). The server must refuse instead.
			assert.isAtLeast(response.status, 400, `the server should have refused to fetch ` +
				`${internalUrl} (internal address), but replied ${response.status} ` +
				`${location ? 'and created webstrate ' + location : '(no redirect)'}`);

			// Whatever error response the server returns must not contain anything the server
			// fetched from the internal service.
			const body = await response.text();
			assert.notInclude(body, internalSecret,
				'the error response leaked the internal service body');
		});
	}

	it('never stores the internal service body as a webstrate', async () => {
		const response = await fetch(config.server_address + 'new/?prototypeUrl=' +
			encodeURIComponent(`http://127.0.0.1:${internalPort}/`), { redirect: 'manual' });

		const location = response.headers.get('location');
		if (location) {
			createdWebstrateIds.push(new URL(location, config.server_address).pathname
				.replace(/^\//, '').replace(/\/+$/, ''));

			// A Location header means the server created a webstrate from the internal
			// service's response. Fetch the webstrate's raw content to check whether the
			// internal body leaked into it.
			const webstrateUrl = new URL(location, config.server_address);
			webstrateUrl.search = 'raw';
			const rawResponse = await fetch(webstrateUrl);
			const raw = await rawResponse.text();
			assert.notInclude(raw, internalSecret, 'the server stored the internal service ' +
				`response as webstrate ${location}`);
		}

		// Without a redirect no webstrate was created — but the request must still have been
		// refused rather than silently succeeded.
		assert.isAtLeast(response.status, 400, 'the server created no webstrate but did not ' +
			`refuse either (status ${response.status})`);
	});

});

// The CORS feature: a document whose root <html> element carries a data-cors attribute — a
// JSON list of URLs — receives Access-Control-Allow-* response headers on requests whose
// Origin host matches the host of one of the listed URLs.
describe('HTTP API: CORS headers (data-cors)', function() {
	this.timeout(10000);

	// The cross-origin requests below are plain GETs carrying an Origin header, and the
	// origins can be arbitrary URLs: the server compares hosts only.
	const ALLOWED_ORIGIN = 'http://allowed.example';
	const DENIED_ORIGIN = 'http://denied.example';

	// Documents created on the side (raw-socket test), so after() can delete them.
	const createdWebstrateIds = [];

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';

	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded);
	});

	after(async () => {
		// Slashed delete URL + disabled browser cache, so the goto can't hang on a
		// redirect (302) to a cached document (see DOM-STRESS-FLAKE.md). Unlike the hooks
		// above, this one navigated to the bare url just before (caching the slashed
		// response), so both legs of the recipe were live here.
		await page.setCacheEnabled(false);
		await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });

		// Clean up the documents the raw-socket test created.
		for (const createdId of createdWebstrateIds) {
			await fetch(config.server_address + createdId + '?delete').catch(() => {});
		}

		await browser.close();
	});

	// Set (or remove, when value is null) the root element's data-cors attribute through the
	// real client, then wait for the change to reach the server's committed snapshot: ?json
	// serves exactly the snapshot the CORS logic evaluates, and fetching right after the
	// DOM change would race the op sync. The client HTML-escapes attribute values on their
	// way into the snapshot (double quotes arrive as &quot;), so compare after the same
	// un-escaping the server performs on data-cors.
	const setDataCors = async (value) => {
		await page.evaluate((attributeValue) => {
			if (attributeValue === null) {
				document.documentElement.removeAttribute('data-cors');
			} else {
				document.documentElement.setAttribute('data-cors', attributeValue);
			}
		}, value);
		const unescape = (stored) => stored.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const snapshot = await (await fetch(url + '?json')).json();
			const stored = snapshot[1]['data-cors'];
			const unescaped = stored === undefined ? null : unescape(stored);
			if (unescaped === value) return;
			await util.sleep(0.25);
		}
		assert.fail(`data-cors change to ${JSON.stringify(value)} never reached the server snapshot`);
	};

	// GET a document the way a cross-origin request would, and return the response status
	// and the CORS response headers (null when a header is absent).
	const corsHeaders = async (docUrl, origin) => {
		const response = await fetch(docUrl, { headers: { Origin: origin } });
		await response.text(); // Drain the body so the connection is released.
		return {
			status: response.status,
			allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
			allowCredentials: response.headers.get('Access-Control-Allow-Credentials'),
			allowHeaders: response.headers.get('Access-Control-Allow-Headers')
		};
	};

	// Create a webstrate with arbitrary initial JsonML through a raw ShareDB websocket from
	// the connected page (the pattern of the permissions tests) — the only way into the
	// system for documents whose root element is not <html>, which the browser client never
	// produces. Resolves null on success, or a description of the failure.
	const createWebstrateOnRawSocket = (docId, data) =>
		page.evaluate((id, data) => new Promise((resolve) => {
			const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
			const finish = (error) => {
				try { socket.close(); } catch { /* ignore */ }
				resolve(error || null);
			};
			setTimeout(() => finish('timeout'), 5000);
			socket.onopen = () => socket.send(JSON.stringify({
				a: 'op', c: 'webstrates', d: id, v: 0, seq: 1, x: {},
				create: { type: 'http://sharejs.org/types/JSONv0', data: data }
			}));
			socket.onerror = () => finish('websocket error');
			socket.onmessage = (event) => {
				const message = JSON.parse(event.data);
				if (message.wa || message.a === 'init') return;
				finish(message.a === 'op' && !message.error ? null : 'Create failed: ' +
					JSON.stringify(message));
			};
		}), docId, data);

	it('sends Access-Control-Allow-* headers to an origin listed in data-cors', async () => {
		await setDataCors(JSON.stringify([ALLOWED_ORIGIN]));
		const headers = await corsHeaders(url, ALLOWED_ORIGIN);
		assert.equal(headers.status, 200, 'the cross-origin request should be served');
		assert.equal(headers.allowOrigin, ALLOWED_ORIGIN,
			'Access-Control-Allow-Origin should echo the requesting origin');
		assert.equal(headers.allowCredentials, 'true', 'Access-Control-Allow-Credentials ' +
			'should be true');
		assert.equal(headers.allowHeaders, 'Origin, X-Requested-With, Content-Type, Accept',
			'Access-Control-Allow-Headers should list the accepted request headers');
	});

	it('matches data-cors entries by host, ignoring scheme and path', async () => {
		// The host comparison is deliberately lax: scheme and any path suffix do not
		// matter, only the host does.
		await setDataCors(JSON.stringify(['https://allowed.example/some/page/']));
		const headers = await corsHeaders(url, ALLOWED_ORIGIN);
		assert.equal(headers.allowOrigin, ALLOWED_ORIGIN,
			'data-cors entries are matched by host, not by string equality');
	});

	it('parses single-quoted data-cors values leniently', async () => {
		// Single quotes (and &quot;) are converted to double quotes before JSON.parsing,
		// so hand-written values don't have to be strict JSON.
		await setDataCors(`['${ALLOWED_ORIGIN}']`);
		const headers = await corsHeaders(url, ALLOWED_ORIGIN);
		assert.equal(headers.allowOrigin, ALLOWED_ORIGIN,
			'a single-quoted data-cors value should grant CORS all the same');
	});

	it('sends no CORS headers to an origin not listed in data-cors', async () => {
		await setDataCors(JSON.stringify([ALLOWED_ORIGIN]));
		const headers = await corsHeaders(url, DENIED_ORIGIN);
		assert.equal(headers.status, 200, 'the document itself is still served');
		assert.isNull(headers.allowOrigin, 'an unlisted origin must not receive ' +
			'Access-Control-Allow-Origin');
	});

	it('sends no CORS headers without a data-cors attribute', async () => {
		await setDataCors(null);
		const headers = await corsHeaders(url, ALLOWED_ORIGIN);
		assert.equal(headers.status, 200, 'the document itself is still served');
		assert.isNull(headers.allowOrigin, 'documents without data-cors must not receive ' +
			'Access-Control-Allow-Origin');
	});

	it('sends no CORS headers when data-cors is unparseable', async () => {
		await setDataCors('not json');
		const headers = await corsHeaders(url, ALLOWED_ORIGIN);
		assert.equal(headers.status, 200, 'the document itself is still served');
		assert.isNull(headers.allowOrigin, 'an unparseable data-cors value must not ' +
			'receive Access-Control-Allow-Origin');
	});

	it('grants CORS only on documents whose root element is html', async () => {
		// Both documents carry the same data-cors listing the requesting origin; only the
		// root element differs. data-cors is an attribute of the root <html> element: on a
		// document whose root element is not html (here a plain ShareDB-created div
		// document), it must not grant CORS.
		const dataCors = JSON.stringify([ALLOWED_ORIGIN]);
		const htmlId = 'test-' + util.randomString();
		const divId = 'test-' + util.randomString();
		createdWebstrateIds.push(htmlId, divId);

		const htmlCreateError = await createWebstrateOnRawSocket(htmlId,
			['html', { 'data-cors': dataCors }, ['head', {}], ['body', {}]]);
		assert.isNull(htmlCreateError, 'creating the html-root document failed');
		const divCreateError = await createWebstrateOnRawSocket(divId,
			['div', { 'data-cors': dataCors }, ['span', {}, 'not an html document']]);
		assert.isNull(divCreateError, 'creating the div-root document failed');

		const htmlHeaders = await corsHeaders(config.server_address + htmlId + '/', ALLOWED_ORIGIN);
		const divHeaders = await corsHeaders(config.server_address + divId + '/', ALLOWED_ORIGIN);
		assert.equal(htmlHeaders.allowOrigin, ALLOWED_ORIGIN,
			'the html-root control document should be CORS-enabled');
		assert.isNull(divHeaders.allowOrigin, 'a non-HTML document must not receive ' +
			'Access-Control-Allow-Origin');
	});

});
