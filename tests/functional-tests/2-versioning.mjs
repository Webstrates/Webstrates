// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Versioning', function () {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);
	});

	after(async () => {
		await page.setCacheEnabled(false);
		await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('version should be 1 before we begin', async () => {
		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 1);
	});

	it('insertions should increase version', async () => {
		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', 'Hello, ');
			document.body.insertAdjacentHTML('beforeend', 'World!');
		});

		await util.sleep(.5);

		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', ' How are you?');
		});

		await util.sleep(.5);

		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 3);
	});

	it('should have one session tag to begin with', async () => {
		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.lengthOf(Object.values(tags), 1);
		assert.exists(tags[0]); // tags is an object, 0 is the key name.
	});

	// Tags can't begin with a number, so we prepend an x to ensure that it won't.
	const tagName = 'x' + util.randomString();
	it('should be possible to create tag', async () => {
		await page.evaluate((t) => window.webstrate.tag(t), tagName);

		await util.sleep(.5);

		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.lengthOf(Object.values(tags), 2);
		assert.equal(tags[3], tagName); // tags is an object, 3 is the key name.
	});

	it('should be possible to restore to previous version', async () => {
		await page.evaluate(async () => {
			await new Promise((resolve, reject) => {
				window.webstrate.restore(2, (err, v) => {
					if (err) {
						reject();
					} else {
						resolve();
					}
				});
			});
		});

		const innerText = await page.evaluate(() => document.body.innerText);

		assert.equal(innerText, 'Hello, World!');
	});

	it('restoring should bump up version', async () => {
		const version = await page.evaluate(() => window.webstrate.version);

		// The empty document is version 1.
		// "Hello, World!" is version 2,
		// "Hello, World! How are you?" is version 3.
		// The noop op created by the restore is version 4.
		// Finally, the restored "Hello, World!" is version 5.
		assert.equal(version, 5);
	});

	it('should be possible to restore to previous tag', async () => {
		await page.evaluate(async (t) => {
			await new Promise((resolve, reject) => {
				window.webstrate.restore(t, (err, v) => {
					if (err) {
						reject();
					} else {
						resolve();
					}
				});
			});
		}, tagName);

		const innerText = await page.evaluate(() => document.body.innerText);

		assert.equal(innerText, 'Hello, World! How are you?');
	});

	it('restoring should bump up version again', async () => {
		const version = await page.evaluate(() => window.webstrate.version);

		// The noop op created by the restore is version 6.
		// The restored "Hello, World! How are you?" is version 7.
		assert.equal(version, 7);
	});

	it('restoring should also work using the HTTP API', async () => {
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await page.setCacheEnabled(false);
		await page.goto(url + '?restore=2', { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 2);
		assert.equal(page.url(), url + '/');

		const innerText = await page.evaluate(() => document.body.innerText);
		assert.equal(innerText, 'Hello, World!');

		const version = await page.evaluate(() => window.webstrate.version);
		// The noop op created by the restore is version 8.
		// Finally, the restored "Hello, World!" is version 9.
		assert.equal(version, 9);
	});

	it('should be possible to restore to a version passed as a string', async () => {
		// Some client flows produce the version as a string, e.g. from a URL query, and the
		// restore should accept it just like the equivalent number.
		await page.evaluate(async () => {
			await new Promise((resolve, reject) => {
				window.webstrate.restore('3', (err, v) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		});

		const innerText = await page.evaluate(() => document.body.innerText);
		assert.equal(innerText, 'Hello, World! How are you?');
	});
});

// A restore that reverts more than one edit reverts them one op at a time, so the fully
// restored content only exists at the last of those ops' versions. The reply and the tag
// that the restore creates must reference that fully-restored version — a version in
// between only holds some of the reverts.
describe('Versioning (restores spanning multiple ops)', function () {
	this.timeout(20000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, page;

	// Every restore tags the version it restores to with "<label> (restored at <date>)",
	// using the tag label of the restored version as the prefix.
	const restoreTag = () => page.evaluate(() => {
		const tags = window.webstrate.tags();
		return Object.entries(tags).find(([, label]) => label.includes('restored at')) || null;
	});

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);
	});

	after(async () => {
		// Slashed delete URL + disabled browser cache, so the goto can't hang on a
		// redirect (302) to a cached document (see DOM-STRESS-FLAKE.md).
		await page.setCacheEnabled(false);
		await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('version should be 1 before we begin', async () => {
		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 1);
	});

	// Two edits in two separate elements, so that reverting them requires one op per edit.
	it('edits in separate elements should bump the version per edit', async () => {
		await page.evaluate(() => {
			const heading = document.createElement('h1');
			heading.textContent = 'Heading';
			document.body.appendChild(heading);
		});

		await util.waitForFunction(page, () => window.webstrate.version === 2);

		await page.evaluate(() => {
			const paragraph = document.createElement('p');
			paragraph.textContent = 'Paragraph';
			document.body.appendChild(paragraph);
		});

		await util.waitForFunction(page, () => window.webstrate.version === 3);
	});

	it('restoring should reply with the fully-restored version', async () => {
		const restoredVersion = await page.evaluate(() => {
			return new Promise((resolve, reject) => {
				window.webstrate.restore(1, (err, v) => {
					if (err) return reject(err);
					resolve(v);
				});
			});
		});

		// The empty document is version 1, "Heading" is version 2,
		// "Heading"+"Paragraph" is version 3, the restore no-op is version 4, and reverting
		// the two elements takes one op each, so the restored document is version 6.
		assert.equal(restoredVersion, 6);
	});

	it('restoring should restore the original content', async () => {
		await util.waitForFunction(page, () => window.webstrate.version === 6, 5);

		const innerText = await page.evaluate(() => document.body.innerText);
		assert.equal(innerText, '');
	});

	it('the tag created by the restore should point at the fully-restored version', async () => {
		const tag = await restoreTag();
		assert.isNotNull(tag, 'expected the restore to create a tag');
		assert.equal(Number(tag[0]), 6);
	});

	it('should be possible to restore back to the restore tag', async () => {
		const tag = await restoreTag();
		assert.isNotNull(tag, 'expected the restore to create a tag');
		const label = tag[1];

		await page.evaluate((label) => {
			return new Promise((resolve, reject) => {
				window.webstrate.restore(label, (err) => {
					if (err) return reject(err);
					resolve();
				});
			});
		}, label);

		await util.sleep(.5);

		// The restore tag points at the fully-restored document, so restoring back to it
		// must yield that same content again, not a document that still contains one of
		// the edits that the first restore reverted.
		const innerText = await page.evaluate(() => document.body.innerText);
		assert.equal(innerText, '');
	});
});

// Version 0 is the state of a document before its initial creation op, and it is where
// every new document's session tag sits. Since 0 is falsy, every gate that tested a
// version with truthiness (`!!version ^ !!tag`, `if (version)`, `!version`) rejected it:
// restoring to version 0 answered "Can't restore, need either a tag label or version. Not
// both.", untagging version 0 never reached the server, and `?restore=0` was a 409 — while
// the very same version stayed reachable through its tag label all along.
describe('Versioning (version zero)', function () {
	this.timeout(20000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 2);
	});

	after(async () => {
		// Slashed delete URL + disabled browser cache, so the goto can't hang on a
		// redirect (302) to a cached document (see DOM-STRESS-FLAKE.md).
		await page.setCacheEnabled(false);
		await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('the session tag should sit on version 0', async () => {
		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.exists(tags[0]); // tags is an object, 0 is the key name.
	});

	it('should be possible to restore to version 0', async () => {
		const newVersion = await page.evaluate(() => {
			return new Promise((resolve, reject) => {
				window.webstrate.restore(0, (err, v) => {
					if (err) return reject(err);
					resolve(v);
				});
			});
		});

		await util.waitForFunction(page, () => window.webstrate.version === 4, 5);

		// The initial document is version 1, the restore no-op is version 2, and reverting
		// the initial creation op takes one op per jsondiff component (delete, insert
		// null) — versions 3 and 4.
		assert.equal(newVersion, 4);

		// Version 0 is the empty document, so the restored document has no content.
		const innerText = await page.evaluate(() => document.body.innerText);
		assert.equal(innerText, '');

		// The restore tags the version it restores to, like every other restore.
		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.include(tags[4], 'restored at');
	});

	it('should be possible to untag version 0', async () => {
		await page.evaluate(() => window.webstrate.untag(0));

		// The tag map updates optimistically on the client, so reload and read the tags
		// the server sends to verify that version 0's tag is really gone. (Goto the
		// canonical slashed URL: the bare one redirects, and a redirect to a cached
		// document is exactly the navigation that hangs in puppeteer.)
		await page.goto(url + '/', { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 2);

		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.notExists(tags[0]);
	});

	it('should be possible to restore to version 0 using the HTTP API', async () => {
		// Avoid puppeteer's goto hang on redirects to cached documents.
		await page.setCacheEnabled(false);
		await page.goto(url + '?restore=0', { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () => window.webstrate && window.webstrate.loaded, 2);
		assert.equal(page.url(), url + '/');

		// The document is already empty after the first restore to version 0, so this
		// restore only sends the no-op — version 5 — and moves the restore tag to it.
		const version = await page.evaluate(() => window.webstrate.version);
		assert.equal(version, 5);

		const tags = await page.evaluate(() => window.webstrate.tags());
		assert.include(tags[5], 'restored at');
	});
});

// Subscribing to a webstrate sends a `{wa: 'tags', …}` message listing every tag on the
// document, and `?tags` serves the same list over HTTP. The tags collection stores a full
// snapshot copy per tag (that is what makes serving /<webstrateId>/<tag>/ possible)
describe('Versioning (tag payload)', function () {
	this.timeout(20000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	// Tags can't begin with a number, so we prepend an x.
	const tagName = 'x' + util.randomString();

	// Enough body text that a leaked snapshot would blow the size assertion below wide
	// open: two tags × this much text is ~96 KB, while the intended payload is a few
	// hundred bytes for any sane number of tags.
	const BODY_TEXT = 'lorem ipsum '.repeat(4000);

	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);

		await page.evaluate((text) => {
			document.body.insertAdjacentHTML('beforeend', `<p>${text}</p>`);
		}, BODY_TEXT);
		await util.sleep(.5);

		await page.evaluate((t) => window.webstrate.tag(t), tagName);
		await util.sleep(.5);
	});

	after(async () => {
		// Slashed delete URL + disabled browser cache, so the goto can't hang on a
		// redirect (302) to a cached document (see DOM-STRESS-FLAKE.md).
		await page.setCacheEnabled(false);
		await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	// Subscribe over a raw websocket, the way the browser client does, and capture the
	// tags message the server sends along with the snapshot.
	it('should send only {v, label, timestamp} per tag when a client subscribes', async () => {
		const message = await new Promise((resolve, reject) => {
			const socket = new WebSocket(
				config.server_address.replace(/^http/, 'ws') + webstrateId + '/');
			const timeout = setTimeout(() => {
				socket.terminate();
				reject(new Error('no tags message within 5 seconds'));
			}, 5000);
			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
			socket.on('open', () => socket.send(JSON.stringify({ a: 'hs' })));
			socket.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				// Handshake first, then subscribe — the message flow the browser client uses.
				if (msg.a === 'hs') {
					socket.send(JSON.stringify({ a: 's', c: 'webstrates', d: webstrateId, v: 0 }));
					return;
				}
				if (msg.wa === 'tags') {
					clearTimeout(timeout);
					socket.close();
					resolve(msg);
				}
			});
		});

		assert.isArray(message.tags, 'the tags message must carry a tags array');
		assert.isAtLeast(message.tags.length, 1, 'the set-up tag should be present');
		message.tags.forEach((tag) => {
			assert.deepEqual(Object.keys(tag).sort(), ['label', 'timestamp', 'v'],
				`tag payload must carry only label/timestamp/v, got: ${Object.keys(tag)}`);
		});
		assert.include(message.tags.map((tag) => tag.label), tagName);

		// Belt and suspenders: with the snapshot data in it, the message for two tags and
		// this much body text is well over 90 KB. Without it, it is a few hundred bytes.
		const messageLength = JSON.stringify(message).length;
		assert.isBelow(messageLength, 50000,
			`tags message is ${messageLength} bytes — it is carrying snapshot data`);
	});

	// The ?tags HTTP endpoint serves the same DocumentManager.getTags list and must not
	// ship snapshots either.
	it('should serve only {v, label, timestamp} per tag from the ?tags endpoint', async () => {
		const response = await fetch(url + '?tags');
		const tags = await response.json();

		assert.isArray(tags);
		assert.isAtLeast(tags.length, 1, 'the set-up tag should be present');
		tags.forEach((tag) => {
			assert.deepEqual(Object.keys(tag).sort(), ['label', 'timestamp', 'v'],
				`?tags payload must carry only label/timestamp/v, got: ${Object.keys(tag)}`);
		});
	});
});

// Auto-tagging marks the start of a new editing session: a "Session of …" tag fires on a
// document's first op and on the first op after tagging.autotagInterval seconds of
// inactivity. The interval was once read as the tagging config object itself, whose NaN
// made the inactivity check never pass — only the first op of a document was ever tagged.
// The suite starts its own server with a two-second interval, so the session semantics can
// be tested in seconds instead of the default hour.
describe('Versioning (auto-tagging)', function () {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	let browser, page;
	let server, url, tagPrefix;

	const sessionTags = () => page.evaluate((prefix) =>
		Object.values(window.webstrate.tags()).filter((label) => label.startsWith(prefix)),
	tagPrefix);

	before(async function () {
		// Under the harness this suite gets its own server with a short auto-tag interval.
		// Without one (mocha against an external server), skip: that server's interval is
		// unknown, and the default (an hour) does not fit inside a test.
		if (!process.env.WEBSTRATES_HARNESS_STATE) this.skip();

		const harness = await import('../lib/server-harness.mjs');
		server = await harness.startServer({
			label: 'versioning-autotag',
			port: 7354,
			config: {
				// Keep the base server's database (a dedicated mongod under parallel checkouts).
				db: config.server.db,
				tagging: { autotagInterval: 2 }
			}
		});
		url = server.address + webstrateId;
		tagPrefix = server.config.tagging.tagPrefix;

		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);
	});

	after(async () => {
		// Slashed delete URL + disabled browser cache (see DOM-STRESS-FLAKE.md).
		if (page && url) {
			await page.setCacheEnabled(false);
			await page.goto(url + '/?delete', { waitUntil: 'domcontentloaded' });
		}
		if (browser) await browser.close();
		if (server) await server.stop();
	});

	it('should auto-tag the first op of a new document', async () => {
		const tags = await sessionTags();
		assert.lengthOf(tags, 1);
	});

	it('should not auto-tag while edits stay within the inactivity interval', async () => {
		await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', 'Hello'));
		await util.waitForFunction(page, () => window.webstrate.version === 2);
		await util.sleep(.2);

		const tags = await sessionTags();
		assert.lengthOf(tags, 1);
	});

	it('should auto-tag the first op after the inactivity interval', async () => {
		await util.sleep(3);

		await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', ' again'));
		await util.waitForFunction(page, () => window.webstrate.version === 3);

		// The tag write is asynchronous on the server, so give it a moment to arrive.
		const tagged = await util.waitForFunction(page, (prefix) =>
			Object.values(window.webstrate.tags())
				.filter((label) => label.startsWith(prefix)).length === 2, 5, tagPrefix);
		assert.isTrue(tagged, 'expected a new session tag after the inactivity interval');
	});
});
