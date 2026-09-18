// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */

import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

const createWebstrateOnRawSocket = (page, webstrateId, data) =>
	page.evaluate((id, data) => new Promise((resolve) => {
		const socket = new window.WebSocket(`ws://${window.location.host}/${id}/`);
		const finish = (error) => {
			try { socket.close(); } catch (e) {}
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
			finish(message.error ? 'Create failed: ' + JSON.stringify(message.error) : null);
		};
	}), webstrateId, data);

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

	const copySourceData = ['html', {}, ['head', {}, ['title', {}, 'Copied title']],
		['body', {}, 'Copy me']];

	it('copying into an empty document whose body element has no attribute object should ' +
		'replace it', async () => {
		const sourceId = 'test-' + util.randomString();
		const destinationId = 'test-' + util.randomString();

		let error = await createWebstrateOnRawSocket(pageA, sourceId, copySourceData);
		assert.isNull(error, `creating source failed: ${error}`);
		error = await createWebstrateOnRawSocket(pageA, destinationId,
			['html', {}, ['head', {}], ['body']]);
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

	it('copying into a non-empty document whose body element has no attribute object ' +
		'should fail', async () => {
		// A body without an attribute object can also carry content, in which case the
		// document isn't an empty shell: the copy must be refused instead of silently
		// replacing the destination.
		const sourceId = 'test-' + util.randomString();
		const destinationId = 'test-' + util.randomString();

		let error = await createWebstrateOnRawSocket(pageA, sourceId, copySourceData);
		assert.isNull(error, `creating source failed: ${error}`);
		error = await createWebstrateOnRawSocket(pageA, destinationId,
			['html', {}, ['head', {}], ['body', 42]]);
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
			// An empty webstrate is an html shell of head and body elements carrying
			// nothing but their webstrate ids, with an optional title. Any combination of
			// removed attributes and elements must leave it empty — copying into it still
			// replaces it.
			this.timeout(60000);

			const sourceId = 'test-' + util.randomString();
			const createError = await createWebstrateOnRawSocket(pageA, sourceId, copySourceData);
			assert.isNull(createError, `creating source failed: ${createError}`);

			const attrs = (wid) => wid ? { __wid: 'testWid' } : {};
			const shells = [];
			for (const headState of ['none', 'empty', 'title']) {
				for (const headWid of headState === 'none' ? [false] : [false, true]) {
					for (const titleWid of headState === 'title' ? [false, true] : [false]) {
						for (const bodyState of ['none', 'empty']) {
							for (const bodyWid of bodyState === 'none' ? [false] : [false, true]) {
								for (const htmlWid of [false, true]) {
									const doc = ['html', attrs(htmlWid)];
									if (headState !== 'none') {
										const head = ['head', attrs(headWid)];
										if (headState === 'title')
											head.push(['title', attrs(titleWid), 'New Codestrate']);
										doc.push(head);
									}
									if (bodyState === 'empty')
										doc.push(['body', attrs(bodyWid)]);
									shells.push(doc);
								}
							}
						}
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
		const createError = await createWebstrateOnRawSocket(pageA, sourceId, copySourceData);
		assert.isNull(createError, `creating source failed: ${createError}`);

		const nonEmptyShells = [
			['html', { lang: 'en' }, ['head', {}], ['body', {}]],
			['html', {}, ['head', {}, ['title', {}, 'T'], ['meta', {}]], ['body', {}]]
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