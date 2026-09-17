// Instruction to ESLint that 'describe', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
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
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
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
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
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