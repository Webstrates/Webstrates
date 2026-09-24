// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */

import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Create a webstrate through the native wire protocol: a base-0 commit
// growing the empty mirror, exactly the way the browser client bootstraps a
// fresh document (see createDocV2 in the fuzzing suite — html, head and body
// carry eids 1-3, everything else mints its own).
const createWebstrateOnRawSocket = (page, webstrateId, ops) =>
	page.evaluate((id, ops) => new Promise((resolve) => {
		const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
		const finish = (error) => {
			try { socket.close(); } catch (e) {}
			resolve(error || null);
		};
		setTimeout(() => finish('timeout'), 5000);
		socket.onopen = () => socket.send(JSON.stringify({
			wa: 'commit', d: id, base: 0, token: 'create', ops
		}));
		socket.onerror = () => finish('websocket error');
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.wa === 'reply' && message.token === 'create') {
				finish(message.error ? 'Create failed: ' + JSON.stringify(message.error) : null);
			}
		};
	}), webstrateId, ops);

// Wire-op shorthands for the shells below. sa grows the tree (p parent, i
// index, e fresh eid, t 1=element / 3=text), aa writes attributes (n null =
// the node's content).
const shell = (htmlEid = 1, headEid = 2, bodyEid = 3) => [
	{ k: 'sa', p: 0, i: 0, e: htmlEid, t: 1, n: 'html' },
	{ k: 'sa', p: htmlEid, i: 0, e: headEid, t: 1, n: 'head' },
	{ k: 'sa', p: htmlEid, i: 1, e: bodyEid, t: 1, n: 'body' }
];
const textUnder = (parentEid, index, eid, value) => [
	{ k: 'sa', p: parentEid, i: index, e: eid, t: 3, n: null },
	{ k: 'aa', e: eid, n: null, v: value }
];

describe('Basic DOM Manipulation', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		//pageA.on('console', (msg) => console.log("A: "+msg.text()));
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		//pageB.on('console', (msg) => console.log("B: "+msg.text()));
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('body shouldn\'t initially contain "Hello, world!"', async () => {
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		assert.notEqual(innerHTML, 'Hello, world!');
	});

	it('body should eventually contain "Hello, world!"', async () => {
		// Wait for page to load.
		await util.waitForFunction(pageB,
			() => window.webstrate && window.webstrate.loaded);

		// Then set body to "Hello, world!".
		await pageB.evaluate(() => {
			document.body.innerHTML = 'Hello, world!';
		});

		const bodyContainsHelloWorld = await util.waitForFunction(pageA,
			() => {return document.body.innerHTML === 'Hello, world!';});
		assert.isTrue(bodyContainsHelloWorld);
	});

	it('select element with selected attribute should be selected after on inserting client',
		async () => {
			await pageA.evaluate(() => {
				document.body.innerHTML += `
				<select>
					<option value="value1">Value 1</option>
					<option value="value2" selected>Value 2</option>
					<option value="value3">Value 3</option>
				</select>`;
			});

			const selectedOption = await pageA.evaluate(() =>
				document.querySelector('select').selectedOptions[0].getAttribute('value'));
			const shouldBeSelectedOption = await pageA.evaluate(() =>
				document.querySelector('select > option[selected]').getAttribute('value'));

			assert.equal(selectedOption, shouldBeSelectedOption);
		});

	it('select element with selected attribute should be selected after on other client',
		async () => {
			await util.waitForFunction(pageB, () => document.querySelector('select'));

			const selectedOption = await pageB.evaluate(() =>
				document.querySelector('select').selectedOptions[0].getAttribute('value'));
			const shouldBeSelectedOption = await pageB.evaluate(() =>
				document.querySelector('select > option[selected]').getAttribute('value'));

			assert.equal(selectedOption, shouldBeSelectedOption);
		});

	it('select element with selected attribute should be selected after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		const selectedOption = await pageA.evaluate(() =>
			document.querySelector('select').selectedOptions[0].getAttribute('value'));
		const shouldBeSelectedOption = await pageA.evaluate(() =>
			document.querySelector('select > option[selected]').getAttribute('value'));

		assert.equal(selectedOption, shouldBeSelectedOption);
	});

	it('creating attribute name with " should replace it with _', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		await pageA.evaluate(() => {
			document.body.innerHTML = '<div foo"="bar"></div>';
		});

		await util.sleep(1);

		const attrsA = await pageA.evaluate(() => document.querySelector('div').outerHTML);
		const attrsB = await pageB.evaluate(() => document.querySelector('div').outerHTML);

		assert.deepEqual(attrsA, '<div foo_="bar"></div>');
		assert.deepEqual(attrsA, attrsB);
	});

	it('inserting something into the DOM before the \'loaded\' event should not throw an error',
		async () => {
			await pageA.evaluate(async () => {
				document.head.innerHTML = '<script>document.body.innerHTML = "<div></div>";</script>';
			});

			await util.waitForFunction(pageB, () =>
				document.head.innerHTML === '<script>document.body.innerHTML = "<div></div>";</script>');

			// This isn't pretty, but it seems to be the only way. We attach our event listener for
			// errors on the page, then reload the webstrate, wait 500 ms and see if an error has occured.
			let error = false;
			pageA.on('pageerror', _error => error = _error);

			await pageA.reload({ waitUntil: 'networkidle2' });
			await util.sleep(.5);

			assert.equal(error, false);
		});

	it('setting title through webstrate.document shouldn\'t throw an error (issue #68)', async () => {
		// webstrate.document is a proxy of the document. Assigning native properties (like
		// title) on it used to throw "Illegal invocation", because the proxy became the
		// receiver of the document's native setters instead of the document itself.
		const error = await pageA.evaluate(() => {
			try {
				window.webstrate.document.title = 'Title set through webstrate.document';
				return null;
			} catch (err) {
				return err.message;
			}
		});
		assert.isNull(error, `setting title threw: ${error}`);

		// The assignment went to the real document, so it takes effect locally...
		const titleA = await pageA.evaluate(() => document.title);
		assert.equal(titleA, 'Title set through webstrate.document');

		// ...and syncs to other clients like any other DOM change.
		const titleSynced = await util.waitForFunction(pageB, () =>
			document.title === 'Title set through webstrate.document');
		assert.isTrue(titleSynced);
	});

	// html > head > title > 'Copied title', body > 'Copy me' — the copy source
	// every test below reuses.
	const copySourceOps = [
		...shell(),
		{ k: 'sa', p: 2, i: 0, e: 4, t: 1, n: 'title' },
		...textUnder(4, 0, 5, 'Copied title'),
		...textUnder(3, 0, 6, 'Copy me')
	];

	it('copying into an empty document should replace it', async () => {
		const sourceId = 'test-' + util.randomString();
		const destinationId = 'test-' + util.randomString();

		let error = await createWebstrateOnRawSocket(pageA, sourceId, copySourceOps);
		assert.isNull(error, `creating source failed: ${error}`);
		error = await createWebstrateOnRawSocket(pageA, destinationId, shell());
		assert.isNull(error, `creating destination failed: ${error}`);

		await pageA.goto(config.server_address + sourceId + '/?copy=' + destinationId,
			{ waitUntil: 'networkidle2' });

		// The copy redirects to the destination, which carries the source's content.
		assert.equal(pageA.url(), config.server_address + destinationId + '/');
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded);
		assert.equal(await pageA.title(), 'Copied title');
		assert.equal(await pageA.evaluate(() => document.body.innerText.trim()), 'Copy me');

		await pageA.goto(config.server_address + sourceId + '/?delete',
			{ waitUntil: 'domcontentloaded' });
		await pageA.goto(config.server_address + destinationId + '/?delete',
			{ waitUntil: 'domcontentloaded' });
	});

	it('copying into a document whose body carries content should fail', async () => {
		// In the JsonML days ['body', 42] could pose as a bare shell (the
		// attribute slot holding a number instead of an object); on the wire
		// every body child is plainly content, and content means the
		// destination is not an empty shell: the copy must be refused instead
		// of silently replacing the document.
		const sourceId = 'test-' + util.randomString();
		const destinationId = 'test-' + util.randomString();

		let error = await createWebstrateOnRawSocket(pageA, sourceId, copySourceOps);
		assert.isNull(error, `creating source failed: ${error}`);
		error = await createWebstrateOnRawSocket(pageA, destinationId,
			[...shell(), ...textUnder(3, 0, 4, '42')]);
		assert.isNull(error, `creating destination failed: ${error}`);

		await pageA.goto(config.server_address + sourceId + '/?copy=' + destinationId,
			{ waitUntil: 'networkidle2' });

		// No redirect: the copy failed and the destination still exists.
		assert.include(pageA.url(), '?copy=');
		const responseBody = await pageA.evaluate(() => document.body.innerText);
		assert.include(responseBody, 'Webstrate already exists');

		await pageA.goto(config.server_address + sourceId + '/?delete',
			{ waitUntil: 'domcontentloaded' });
		await pageA.goto(config.server_address + destinationId + '/?delete',
			{ waitUntil: 'domcontentloaded' });
	});

	it('removing attributes and elements from an empty webstrate should keep it empty',
		async function() {
			// An empty webstrate is an html shell of head and body elements with
			// nothing but their element ids (eids) and an optional title. Any
			// combination of removed elements must leave it empty — copying into it
			// still replaces it. The eid dimension replaces the old __wid one: in the
			// JsonML model identity lived in an attribute (a shell could carry
			// __wids and still count as empty); here identity is the eid itself,
			// invisible to the emptiness check — so a shell minted with arbitrary
			// eids is as empty as the canonical 1-2-3 shell.
			this.timeout(60000);

			const sourceId = 'test-' + util.randomString();
			const createError = await createWebstrateOnRawSocket(pageA, sourceId, copySourceOps);
			assert.isNull(createError, `creating source failed: ${createError}`);

			const shells = [];
			for (const eidBase of [0, 100]) {
				for (const headState of ['none', 'empty', 'title']) {
					for (const bodyState of ['none', 'empty']) {
						const htmlEid = eidBase + 1, headEid = eidBase + 2,
							bodyEid = eidBase + 3;
						const ops = [{ k: 'sa', p: 0, i: 0, e: htmlEid, t: 1, n: 'html' }];
						if (headState !== 'none') {
							ops.push({ k: 'sa', p: htmlEid, i: 0, e: headEid, t: 1, n: 'head' });
							if (headState === 'title') {
								ops.push({ k: 'sa', p: headEid, i: 0, e: eidBase + 4,
									t: 1, n: 'title' },
								...textUnder(eidBase + 4, 0, eidBase + 5, 'New Codestrate'));
							}
						}
						if (bodyState === 'empty') {
							ops.push({ k: 'sa', p: htmlEid,
								i: headState === 'none' ? 0 : 1, e: bodyEid, t: 1,
								n: 'body' });
						}
						shells.push(ops);
					}
				}
			}

			const destinationIds = [];
			for (const doc of shells) {
				const destinationId = 'test-' + util.randomString();
				const error = await createWebstrateOnRawSocket(pageA, destinationId, doc);
				assert.isNull(error, `creating destination failed: ${error}`);

				const response = await fetch(config.server_address + sourceId + '/?copy='
					+ destinationId, { redirect: 'manual' });
				assert.equal(response.status, 302,
					`copying into ${JSON.stringify(doc)} should replace the destination`);
				assert.equal(response.headers.get('location'), '/' + destinationId + '/');
				destinationIds.push(destinationId);
			}

			await fetch(config.server_address + sourceId + '/?delete');
			for (const destinationId of destinationIds) {
				await fetch(config.server_address + destinationId + '/?delete');
			}
		});

	it('copying into a document with extra attributes or head content should fail', async () => {
		// Attributes other than the webstrate id on the html element, or head content other
		// than a single title, mean the document isn't an empty shell: the copy must be
		// refused instead of silently replacing the destination.
		const sourceId = 'test-' + util.randomString();
		const createError = await createWebstrateOnRawSocket(pageA, sourceId, copySourceOps);
		assert.isNull(createError, `creating source failed: ${createError}`);

		// The wire counterparts of the old JsonML non-empty shells: an html
		// carrying an attribute, and a head holding more than a single title.
		const nonEmptyShells = [
			[...shell(), { k: 'aa', e: 1, i: 0, n: 'lang', v: 'en' }],
			[...shell(),
				{ k: 'sa', p: 2, i: 0, e: 4, t: 1, n: 'title' },
				...textUnder(4, 0, 5, 'T'),
				{ k: 'sa', p: 2, i: 1, e: 7, t: 1, n: 'meta' }]
		];

		for (const doc of nonEmptyShells) {
			const destinationId = 'test-' + util.randomString();
			const error = await createWebstrateOnRawSocket(pageA, destinationId, doc);
			assert.isNull(error, `creating destination failed: ${error}`);

			const response = await fetch(config.server_address + sourceId + '/?copy='
				+ destinationId, { redirect: 'manual' });
			assert.equal(response.status, 409, `copying into ${JSON.stringify(doc)} should fail`);
			assert.include(await response.text(), 'Webstrate already exists');

			await fetch(config.server_address + destinationId + '/?delete');
		}

		await fetch(config.server_address + sourceId + '/?delete');
	});
});