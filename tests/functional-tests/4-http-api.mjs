
import http from 'node:http';
import puppeteer from 'puppeteer';
import { MongoClient } from 'mongodb';
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
	this.timeout(30000);

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


	// See util.webstrateIdRegex for the id length range: shortid ids grow by a
	// character each time the server's per-second generation counter crosses a
	// power of 16, which parallel suites bursting /new requests can trigger.
	const webstrateIdRegex = (config.server && config.server.niceWebstrateIds)
		? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,3})'
		: '([A-z0-9-]{9,14})';

	it('/new redirects to random webstrateId matching ' + webstrateIdRegex, async () => {
		pageB = await browser.newPage();
		await pageB.goto(config.server_address + 'new', { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await util.deleteWebstrate(pageA, redirectedUrl);
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
		await pageB.goto(config.server_address + "new?prototypeUrl="+testURL,
			{ waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds
			// (default is requestAnimationFrame or 100ms)
		});

		// Cleanup. Delete only after the page has populated: the /new redirect target
		// still carries the ?prototypeUrl query, so deleting through that URL relies
		// on the delete helper dropping the query — and issuing the delete earlier
		// would broadcast the deletion to pageB before the prototype content arrives.
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await pageA.setCacheEnabled(false);
		await util.deleteWebstrate(pageA, redirectedUrl);
	});

	it('/new?prototypeUrl=zipfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.zip";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl=" + testURL,
			{ waitUntil: 'domcontentloaded' });

		await pageB.waitForFunction(() => window.test, {
			timeout: 10000, // Maximum time to wait in milliseconds (adjust as needed)
			polling: 100 // How often to check the condition in milliseconds
			// (default is requestAnimationFrame or 100ms)
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
		assert.propertyVal(jsonObject, 'success', true,
			'Could not find the success property in test zip json');
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
		await util.deleteWebstrate(pageA, redirectedUrl);

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'subdirectory', true,
			'Could not find the subdirectory property in test zip json in a subdir');
	});

	it('?dir on a non-ZIP asset should return an error instead of crashing the server', async () => {
		const dirWebstrateId = 'test-' + util.randomString();
		const dirUrl = config.server_address + dirWebstrateId;

		pageA = await browser.newPage();
		await pageA.goto(dirUrl, { waitUntil: 'networkidle2' });
		// Wait for the page to be actually loaded before uploading anything.
		assert.isTrue(await util.waitForFunction(pageA,
			() => window.webstrate && window.webstrate.loaded, 15));

		// The webstrate exists server-side only once the page client's ShareDB create
		// op has been committed, and that write can lag the client's loaded event:
		// an upload posted in
		// between is rejected ("Document doesn't exist.") and its reply carries no
		// fileName. ?json answers 404 until the server has the document, so poll it
		// from the test process before uploading.
		await util.waitFor(async () => {
			const response = await fetch(dirUrl + '/?json');
			await response.text();
			return response.status === 200;
		}, 15);

		const notAZipAsset = await uploadAssetByFetch(
			pageA, 'notazip.txt', 'text/plain', NOT_A_ZIP_FILE);
		assert.equal(notAZipAsset.fileName, 'notazip.txt', 'Uploading the non-ZIP asset failed');

		const zipAsset = await uploadAssetByFetch(
			pageA, 'realzip.zip', 'application/zip', REAL_ZIP_FILE);
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
		assert.include(subStructure, 'sub/file.txt',
			'Subdirectory listing does not include sub/file.txt');

		// Used to kill the whole server process: the yauzl.open callback in
		// getZipStructure ignores its error and dereferences zipFile anyway.
		const response = await pageA.goto(dirUrl + '/notazip.txt/?dir',
			{ waitUntil: 'domcontentloaded' });

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
		await util.deleteWebstrate(pageA, dirUrl);
	});

});

describe('HTTP API: /new?prototypeUrl= allows only whitelisted URLs', function() {
	this.timeout(30000);

	// A loopback-only service standing in for any host the whitelist does not
	// cover. If the server fetches it on behalf of a /new?prototypeUrl=
	// request, its marker ends up stored inside a newly created webstrate —
	// so every request below must be refused before anything is fetched.
	const localSecret = 'local-secret-' + util.randomString();

	// Webstrates the tests below create (only the whitelisted fetch ever
	// should), so after() can clean up after ourselves.
	const createdWebstrateIds = [];

	let localServer, localPort;

	before(async () => {
		localServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(`<html><body>${localSecret}</body></html>`);
		});
		await new Promise((resolve, reject) => {
			localServer.once('error', reject);
			localServer.listen(0, '127.0.0.1', () => {
				localServer.removeListener('error', reject);
				resolve();
			});
		});
		localPort = localServer.address().port;
	});

	after(async () => {
		await new Promise((resolve) => localServer.close(resolve));
		// Clean up any webstrates the tests created.
		for (const webstrateId of createdWebstrateIds) {
			await fetch(config.server_address + webstrateId + '?delete').catch(() => {});
		}
	});

	it('refuses a prototypeUrl outside the whitelist', async () => {
		// The whitelist the base test server runs (the Webstrates GitHub repos
		// by default, plus the hosts its configuration allows) does not cover
		// loopback, so the fetch must be refused rather than performed.
		const localUrl = `http://localhost:${localPort}/`;
		const response = await fetch(config.server_address + 'new/?prototypeUrl=' +
			encodeURIComponent(localUrl), { redirect: 'manual' });

		const location = response.headers.get('location');
		if (location) {
			createdWebstrateIds.push(new URL(location, config.server_address).pathname
				.replace(/^\//, '').replace(/\/+$/, ''));
		}

		assert.isAtLeast(response.status, 400, 'the server should have refused to fetch ' +
			localUrl + ' (outside the whitelist), but replied ' + response.status + ' ' +
			(location ? 'and created webstrate ' + location : '(no redirect)'));

		const body = await response.text();
		assert.include(body, 'whitelist',
			'the refusal should say the URL is not whitelisted');
		assert.notInclude(body, localSecret,
			'the error response leaked the local service body');
	});

	it('fetches a Webstrates repository on GitHub', async () => {
		// The base test server's whitelist carries the GitHub pattern, and
		// github.com serves its pages as text/html, so a blob URL from the
		// Webstrates organization imports as a webstrate out of the box.
		// (raw.githubusercontent.com is whitelisted all the same, but serves
		// .html files as text/plain, so those the content-type gate refuses.)
		const githubUrl = 'https://github.com/Webstrates/tutorials/blob/' +
			'master/chat-system/chat-system.html';
		const id = 'test-' + util.randomString();
		const response = await fetch(config.server_address + 'new/?id=' + id + '&prototypeUrl=' +
			encodeURIComponent(githubUrl), { redirect: 'manual' });

		const location = response.headers.get('location');
		if (location) {
			createdWebstrateIds.push(new URL(location, config.server_address).pathname
				.replace(/^\//, '').replace(/\/+$/, ''));
		}

		assert.equal(response.status, 302, 'the whitelisted GitHub URL should create a webstrate');
		assert.include(location || '', id,
			'the redirect should point at the created webstrate');

		const rawResponse = await fetch(config.server_address + id + '/?raw');
		const raw = await rawResponse.text();
		assert.include(raw, 'chat-system.html',
			'the created webstrate should contain the fetched GitHub page');
	});
});

// The CORS feature: a document whose root <html> element carries a data-cors attribute — a
// JSON list of URLs — receives Access-Control-Allow-* response headers on requests whose
// Origin host matches the host of one of the listed URLs.
describe('HTTP API: CORS headers (data-cors)', function() {
	this.timeout(30000);

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
		await page.setCacheEnabled(false);
		await util.deleteWebstrate(page, url);

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
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			// The ?json request can transiently be
			// served an error page instead of the snapshot, so only act on a
			// reply that actually parses — anything else just means "poll again".
			const snapshot = await (await fetch(url + '?json')).json().catch(() => null);
			if (snapshot !== null) {
				const stored = snapshot[1]['data-cors'];
				const unescaped = stored === undefined ? null : unescape(stored);
				if (unescaped === value) return;
			}
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

// `?delete` promises to delete a webstrate entirely: its current state *and* its
// history. The history is the ShareDB op log — every operation the webstrate ever
// received — and it belongs to ShareDB's database adapter, which stores it wherever
// it decides (sharedb-mongo: an "o_"-prefixed collection, currently "o_webstrates").
describe('HTTP API: ?delete', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';

	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
	});

	after(async () => {
		await browser.close();
	});

	// Retry a predicate until it holds, or give up after `seconds` seconds.
	const eventually = async (seconds, predicate) => {
		const endAt = Date.now() + seconds * 1000;
		do {
			await util.sleep(0.25);
			if (await predicate()) return true;
		} while (Date.now() < endAt);
		return false;
	};

	// Op documents carry their webstrate's id in `d` (no other Webstrates or ShareDB
	// collection uses that field). Which collection they live in is the database
	// adapter's decision, so count a webstrate's op documents across every collection
	// of the test database rather than hardcoding a name the adapter could change.
	const countOps = async (db, id) => {
		const collectionNames = (await db.listCollections().toArray())
			.map((collection) => collection.name);
		let ops = 0;
		for (const name of collectionNames) {
			ops += await db.collection(name).countDocuments({ d: id });
		}
		return ops;
	};

	// Create a webstrate through the browser client, append a marker text node, and
	// wait for the edit to be committed server-side: ?json serves exactly the committed
	// snapshot, and the op commits together with it.
	const createAndEdit = async (id) => {
		const docUrl = config.server_address + id + '/';
		await page.goto(docUrl, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 5);

		const marker = 'op-history-' + util.randomString();
		await page.evaluate((markerText) => {
			document.body.appendChild(document.createTextNode(markerText));
		}, marker);

		const editCommitted = await eventually(5, async () => {
			const snapshot = await (await fetch(docUrl + '?json')).json();
			return JSON.stringify(snapshot).includes(marker);
		});
		assert.isTrue(editCommitted, `the edit on ${id} never reached the server snapshot`);
	};

	it('deletes the webstrate\'s op history', async () => {
		await createAndEdit(webstrateId);

		const client = new MongoClient(config.server.db);
		await client.connect();
		const db = client.db();
		try {
			// Sanity: before the delete there is a snapshot and an op history (at least the
			// create op plus the edit above) — this also proves countOps finds the ops.
			assert.isNotNull(await db.collection('webstrates').findOne({ _id: webstrateId }),
				'the webstrate snapshot should exist before ?delete');
			const opsBefore = await countOps(db, webstrateId);
			assert.isAtLeast(opsBefore, 2, 'the webstrate should have an op history before ?delete');

			// Delete the webstrate. The redirect response is only sent after
			// deleteDocument has finished, so the database state is final when goto
			// resolves. 
			await page.setCacheEnabled(false);
			await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

			// The current snapshot is gone…
			assert.isNull(await db.collection('webstrates').findOne({ _id: webstrateId }),
				'?delete should delete the webstrate snapshot');
			// …and so is the whole op history: nothing of the webstrate may survive ?delete.
			const opsAfter = await countOps(db, webstrateId);
			assert.equal(opsAfter, 0, '?delete should delete the webstrate\'s op history, but ' +
				`${opsAfter} of ${opsBefore} op documents survived the deletion`);
		} finally {
			await client.close();
		}
	});

	it('does not delete other webstrates\' op history', async () => {
		// A deleteDocument that filtered the ops deletion wrongly (say, a deleteMany
		// without the document filter) would take every other webstrate's history with
		// it. Deleting one webstrate must leave another webstrate entirely alone.
		const targetId = 'test-' + util.randomString();
		const bystanderId = 'test-' + util.randomString();
		await createAndEdit(targetId);
		await createAndEdit(bystanderId);

		const client = new MongoClient(config.server.db);
		await client.connect();
		const db = client.db();
		try {
			// Sanity: both webstrates exist, each with an op history of its own.
			const targetOpsBefore = await countOps(db, targetId);
			const bystanderOpsBefore = await countOps(db, bystanderId);
			assert.isAtLeast(targetOpsBefore, 2, 'the deleted webstrate should have an op history');
			assert.isAtLeast(bystanderOpsBefore, 2,
				'the bystander webstrate should have an op history');
			assert.isNotNull(await db.collection('webstrates').findOne({ _id: bystanderId }),
				'the bystander snapshot should exist before ?delete');

			// Delete only the target webstrate.
			await page.setCacheEnabled(false);
			await page.goto(config.server_address + targetId + '/?delete',
				{ waitUntil: 'domcontentloaded' });

			// The target's ops are gone…
			assert.equal(await countOps(db, targetId), 0,
				'?delete should delete the webstrate\'s op history');
			// …the bystander keeps its snapshot…
			assert.isNotNull(await db.collection('webstrates').findOne({ _id: bystanderId }),
				'?delete must not delete other webstrates\' snapshots');
			// …and every one of its ops.
			const bystanderOpsAfter = await countOps(db, bystanderId);
			assert.equal(bystanderOpsAfter, bystanderOpsBefore, '?delete must not delete other ' +
				`webstrates' op history, but only ${bystanderOpsAfter} of the bystander's ` +
				`${bystanderOpsBefore} ops remain`);
		} finally {
			await client.close();
		}
	});

});
