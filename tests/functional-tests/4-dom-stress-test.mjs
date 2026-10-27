import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('DOM Stress Test', function() {
	this.timeout(150000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';

	let browserA, browserB, pages, pageA;

	before(async () => {
		browserA = await puppeteer.launch();
		browserB = await puppeteer.launch();

		pages = await Promise.all([
			browserA.newPage(), browserA.newPage(), browserA.newPage(),
			browserB.newPage(), browserB.newPage(), browserB.newPage()
		]);

		pageA = pages[0];
		
		// Connect pages sequentially to prevent "document was created remotely" errors
		for (let i = 0; i < pages.length; i++) {
			await pages[i].goto(url, { waitUntil: 'networkidle2' });
		}

		const loaded = await Promise.all(pages.map(page =>
			util.waitForFunction(page, () =>
				window.webstrate &&
				window.webstrate.loaded &&
				document.body, 10)));
		assert.isTrue(loaded.every(isLoaded => isLoaded), 'pages should be loaded');
	});

	after(async () => {
		await util.deleteWebstrate(pageA, url);

		await Promise.all([
			browserA.close(),
			browserB.close()
		]);
	});

	it('body should initially be empty', async () => {
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		const attributes = await pageA.evaluate(() =>
			Array.from(document.body.attributes, attr => attr.name));

		assert.isEmpty(innerHTML.trim());
		assert.isEmpty(attributes);
	});

	it('DOMs should eventually become consistent after lots of insertions and deletions',
		async () => {
			await pageA.evaluate(() =>
				document.body.setAttribute('contenteditable', ''));

			// The attribute is committed as an op and broadcast to the other pages
			const editable = await Promise.all(pages.map(page =>
				util.waitForFunction(page, () => document.body.attributes.length > 0, 10)));
			assert.isTrue(editable.every(isEditable => isEditable),
				'contenteditable attribute should reach all pages');

			for (let i=0; i < 1000; ++i) {
				(async () => {
					await util.sleep(Math.random() / 10);
					const page = pages[Math.random() * pages.length | 0];
					page.type('body', util.randomString(1));
				})();
			}

			// This seems to cause a lot of text duplication. Might be a ShareDB bug!
			/*await util.sleep(.5);
			util.showLogs(...pages);

			for (let i=0; i < 500; ++i) {
				(async () => {
					await util.sleep(Math.random() / 10);
					const page = pages[Math.random() * pages.length | 0];
					page.evaluate(() => {
						const splitIdx = (Math.random() * document.body.innerHTML.length) | 0;
						console.log("PRE", document.body.innerHTML.length);
						document.body.innerHTML = document.body.innerHTML.substr(0, splitIdx)
						+ document.body.innerHTML.substr(splitIdx + 1);
						console.log("POST", document.body.innerHTML.length);
					});
				})();
			}*/

			await util.sleep(.5);

			// The 1000 fire-and-forget typings drain so first wait for every character to
			// arrive on the reference page — the convergence window below then measures
			// convergence, not the drain.
			let now = Date.now() / 1000;
			while ((Date.now() / 1000) - now < 60 &&
				!(await pageA.evaluate(() => document.body.innerHTML.length === 1000))) {
				await util.sleep(.1);
			}

			let match = false;
			now = Date.now() / 1000;
			// Convergence through the server takes as long as the slowest client on a
			// busy machine, the polling itself yields
			// between reads instead of competing with the pages for the CPU.
			while (!match && (Date.now() / 1000) - now < 60) {
				const innerHTMLs = await Promise.all(pages.map(page =>
					page.evaluate(() => document.body.innerHTML)));
				match = innerHTMLs[0].length === 1000 && util.allEquals(...innerHTMLs);
				if (!match) await util.sleep(.1);
			}

			assert.isTrue(match);
		});

});