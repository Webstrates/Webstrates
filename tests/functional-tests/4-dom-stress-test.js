const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('DOM Stress Test', function() {
	this.timeout(30000);

	const webstrateId = 'SJJUN6Pib'; // test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browserA, browserB, pages, pageA;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		pages = await Promise.all([
			browserA.newPage(), browserA.newPage(), browserA.newPage(),
			browserB.newPage(), browserB.newPage(), browserB.newPage()
		]);

		pageA = pages[0];

		await Promise.all(pages.map(page =>
			page.goto(url, { waitUntil: 'networkidle' })));

		await Promise.all(pages.map(page =>
			util.waitForFunction(page, () =>
				window.webstrate &&
				window.webstrate.loaded &&
				document.body)));
	});

	after(async () => {
		await browserA.close();
		await browserB.close();
	});

	/*it('body shouldn\'t initially be empty', async () => {
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		const attributes = await pageA.evaluate(() =>
			Array.from(document.body.attributes, attr => attr.name));

		assert.isEmpty(innerHTML);
		assert.isEmpty(attributes);
	});*/

	it('DOMs should eventually become consistent after lots of insertions', async () => {
		await pageA.evaluate(() =>
			document.body.setAttribute('contenteditable', ''));

		await Promise.all(pages.map(page =>
			util.waitForFunction(page, () => document.body.attributes.length > 0)));

		for (let i=0; i < 1000; ++i) {
			(async () => {
				await util.sleep(Math.random() / 10);
				const page = pages[Math.random() * pages.length | 0];
				await page.focus('body');
				page.type(util.randomString(1));
			})();
		}

		/*for (let i=0; i < 250; ++i) {
			setTimeout(() => {
				const page = pages[Math.random() * pages.length | 0];
				page.evaluate(() => {
					const splitIdx = (Math.random() * document.body.innerHTML.length) | 0;
					document.body.innerHTML = document.body.innerHTML.substr(0, splitIdx)
					+ document.body.innerHTML.substr(splitIdx + 1);
				});
			}, Math.random() * 100);
		}*/

		await util.sleep(.5);

		let match = false;
		let now = Date.now() / 1000;
		while (!match && (Date.now() / 1000) - now < 15) {
			const innerHTMLs = await Promise.all(pages.map(page =>
				page.evaluate(() => document.body.innerHTML)));
			match = util.allEquals(...innerHTMLs);
		}

		assert.isTrue(match);
	});

});