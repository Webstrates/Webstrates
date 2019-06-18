// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Script Insertion and Execution', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		//pageA.on('console', (...args) => console.log(...args));
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		//pageB.on('console', (...args) => console.log(...args));
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

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