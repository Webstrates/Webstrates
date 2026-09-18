// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';


// Webstrates wrap element/node, but userland can further wrap them
describe('Prototype Function Overrides', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, page;

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });

		// Insert a script that overrides the prototype functions on `loaded` — i.e. after Webstrates
		// has installed its own overrides in the `populated` handler (see nodeObjects.js) — and then
		// calls the functions
		await page.evaluate(() => {
			document.head.innerHTML += `
				<script>
					window.__overrides = { cloneNode: 0, importNode: 0 };
					webstrate.on('loaded', function() {
						const cloneNode = Node.prototype.cloneNode;
						Node.prototype.cloneNode = function(deep, ...unused) {
							window.__overrides.cloneNode++;
							return cloneNode.call(this, deep, ...unused);
						};

						const importNode = Document.prototype.importNode;
						Document.prototype.importNode = function(externalNode, deep, ...unused) {
							window.__overrides.importNode++;
							return importNode.call(this, externalNode, deep, ...unused);
						};

						const div = document.createElement('div');
						window.__clone = div.cloneNode(true);
						window.__import = document.importNode(div, true);
					});
				</script>
			`;
		});

		await page.reload({ waitUntil: 'networkidle2' });
		await util.waitForWebstrateLoaded(page);
	});

	after(async () => {
		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('user-defined cloneNode override should get called', async () => {
		const called = await util.waitForFunction(page,
			() => window.__overrides.cloneNode > 0);
		assert.isTrue(called, 'Node.prototype.cloneNode override should have been called');
	});

	it('user-defined importNode override should get called', async () => {
		const called = await util.waitForFunction(page,
			() => window.__overrides.importNode > 0);
		assert.isTrue(called, 'Document.prototype.importNode override should have been called');
	});

	it('webstrate objects should still be attached to cloned and imported nodes', async () => {
		// Webstrates' own wrapping of cloneNode/importNode must still run underneath the userland
		// override, i.e. cloned/imported nodes still get webstrate objects attached.
		const hasWebstrateObjects = await util.waitForFunction(page, () =>
			window.__clone && window.__clone.webstrate && window.__import && window.__import.webstrate);
		assert.isTrue(hasWebstrateObjects,
			'cloned and imported nodes should have webstrate objects attached');
	});
});
