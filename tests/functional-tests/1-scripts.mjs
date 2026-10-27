import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Script Insertion and Execution', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		//pageA.on('console', (...args) => console.log(...args));
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		//pageB.on('console', (...args) => console.log(...args));
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		// Scripts present in the document run when a page populates, so both pages
		// must be fully loaded before any script is inserted — under load, networkidle2
		// can resolve while population is still in flight, and a script committed in
		// that window would execute on the other page as part of its population.
		const loaded = await Promise.all([
			util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 10),
			util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded, 10)
		]);
		assert.isTrue(loaded.every(isLoaded => isLoaded), 'pages should be loaded');
	});

	after(async () => {
		await util.deleteWebstrate(pageA, url);

		await browser.close();
	});

	it('inserting a script should not execute it on inserting client', async () => {
		await pageA.evaluate(() => {
			document.head.innerHTML += `
				<script>window.__scriptRunPre = true; window.__prejQuery = typeof $</script>
				<script src="https://code.jquery.com/jquery-3.2.1.slim.min.js"></script>
				<script>window.__scriptRunPost = true; window.__postjQuery = typeof $</script>
			`;
		});

		const scriptsRun = await util.waitForFunction(pageA, () =>
			window.__scriptRunPre || window.__scriptRunPost || window.jQuery);

		assert.isFalse(scriptsRun);
	});

	it('inserting a script should not execute it on other client', async () => {
		const scriptsRun = await util.waitForFunction(pageB, () =>
			window.__scriptRunPre || window.__scriptRunPost || window.jQuery);

		assert.isFalse(scriptsRun);
	});

	it('scripts should get executed after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		await util.waitForWebstrateLoaded(pageA);

		const scriptsRun = await util.waitForFunction(pageA, () =>
			window.__scriptRunPre && window.__scriptRunPost && window.jQuery, 1);

		assert.isTrue(scriptsRun);
	});

	it('scripts should execute in same order as they\'re present in the document', async () => {
		const prejQuery = await pageA.evaluate(() => window.__prejQuery);
		const postjQuery = await pageA.evaluate(() => window.__postjQuery);

		assert.equal(prejQuery, 'undefined', 'jQuery object should be undefined before loading jQuery');
		assert.equal(postjQuery, 'function', 'jQuery object should be a function after loading jQuery');
	});


});