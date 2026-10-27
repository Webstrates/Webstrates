import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Ops', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		page.on('console', (msg) => console.log("Page: "+msg.text()));
		await page.goto(url, { waitUntil: 'networkidle2' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);
	});

	after(async () => {
		await util.deleteWebstrate(page, url);
		await browser.close();
	});

	let ops;
	it('only create op should be in webstrate.getOps()', async () => {
		util.showLogs(page);
		// The op may not be committed to the database the moment the page holds it, so
		// poll the fetch until the create op shows up instead of reading it exactly once.
		await util.waitFor(async () => {
			ops = await page.evaluate(() => new Promise((accept, reject) => {
				window.webstrate.getOps(undefined, undefined, (err, ops) => {
					if (err) return reject(err);
					accept(ops);
				});
			}));
			return ops.length === 1;
		});

		assert.lengthOf(ops, 1);
		assert.match(ops[0].src, /^[0-9a-f]{32}$/);
		assert.equal(ops[0].seq, 1);
		assert.equal(ops[0].v, 0);
		assert.isObject(ops[0].create);
		assert.equal(ops[0].create.type, 'http://sharejs.org/types/JSONv0');
	});

	it('ops in ?ops should match webstrate.getOps()', async () => {
		await page.goto(url + '?ops', { waitUntil: 'domcontentloaded' });

		// Both reads come from the same committed ops, but under load they can race the
		// op commit (one side still seeing no ops), so poll until they agree on the
		// op count; the deepEqual below remains the actual comparison.
		let innerText;
		await util.waitFor(async () => {
			try {
				innerText = await page.evaluate(() =>
					JSON.parse(document.querySelector('body').innerText));
			} catch {
				return false;
			}
			return innerText.length === ops.length && ops.length > 0;
		});

		assert.deepEqual(innerText, ops);
	});

	it('insertions should create more ops in webstrate.getOps()', async () => {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);

		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', 'Hello, ');
			document.body.insertAdjacentHTML('beforeend', 'World!');
		});

		await util.sleep(.5);

		await page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', ' How are you?');
		});

		await util.sleep(1);

		ops = await page.evaluate(() => new Promise((accept, reject) => {
			window.webstrate.getOps(undefined, undefined, (err, ops) => {
				if (err) return reject(err);
				accept(ops);
			});
		}));

		assert.lengthOf(ops, 3);

		assert.equal(ops[1].v, 1);
		assert.lengthOf(ops[1].op, 2);
		assert.equal(ops[1].op[0].li, 'Hello, ');
		assert.equal(ops[1].op[1].li, 'World!');

		assert.equal(ops[2].v, 2);
		assert.lengthOf(ops[2].op, 1);
		assert.equal(ops[2].op[0].li, ' How are you?');
	});

	it('ops in ?ops should still match webstrate.getOps() after insertion', async () => {
		await page.goto(url + '?ops', { waitUntil: 'domcontentloaded' });

		const innerText = await page.evaluate(() =>
			JSON.parse(document.querySelector('body').innerText));

		assert.deepEqual(innerText, ops);
	});

	it('should be able to filter ops with webstrate.getOps()', async () => {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await util.waitForFunction(page, () =>
			window.webstrate && window.webstrate.loaded, 2);

		ops = await page.evaluate(() => new Promise((accept, reject) => {
			window.webstrate.getOps(1, 3, (err, ops) => {
				if (err) return reject(err);
				accept(ops);
			});
		}));

		assert.lengthOf(ops, 2);
		assert.notProperty(ops[0], 'create');
		assert.notProperty(ops[1], 'create');
	});

	it('should be able to filter ops with ?ops', async () => {
		await page.goto(url + '?ops&from=1&to=3', { waitUntil: 'domcontentloaded' });

		const innerText = await page.evaluate(() =>
			JSON.parse(document.querySelector('body').innerText));

		assert.deepEqual(innerText, ops);
	});
});