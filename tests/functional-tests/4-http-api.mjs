// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe after it */

import http from 'node:http';
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

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
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });
		const regex = '^' + util.escapeRegExp(config.server_address) + webstrateIdRegex + '/$';
		assert.match(redirectedUrl, new RegExp(regex));
	});

	it('root (/) redirects to /frontpage/', async () => {
		pageA = await browser.newPage();
		await pageA.goto(config.server_address, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageA.url();
		assert.equal(redirectedUrl, config.server_address + 'frontpage/');
	});

	it('/new?prototypeUrl=htmlfile creates a valid webstrate', async () => {
		let testURL = "https://webstrate.projects.cavi.au.dk/testcases/test.html";

		pageB = await browser.newPage();
		await pageB.goto(config.server_address + "new?prototypeUrl="+testURL, { waitUntil: 'domcontentloaded' });

		const redirectedUrl = pageB.url();
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
		await pageA.goto(redirectedUrl + '?delete', { waitUntil: 'domcontentloaded' });

		const jsonObject = JSON.parse(pageContent);
		assert.propertyVal(jsonObject, 'subdirectory', true, 'Could not find the subdirectory property in test zip json in a subdir');
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
