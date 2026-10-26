// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';


// Webstrates wrap element/node, but userland can further wrap them
describe('Prototype Function Overrides', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, page;

	before(async function () {
		this.timeout(90000);
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle2' });

		// The ops pipeline and the webstrate
		// object's document reference only exist once the page has loaded, and both
		// the script insertion and the version read below depend on them, so wait
		// for the load before inserting the script.
		assert.isTrue(await util.waitForFunction(page,
			() => window.webstrate && window.webstrate.loaded, 15));

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

		// The script only takes effect on the reloaded page if its insertion has been
		// committed first — the reload can race the op commit and come back
		// without the script, leaving the overrides below never installed.
		await page.evaluate(async () => {
			await window.webstrate.dataSaved();
		});

		// The page's version at this point is the document's final version — no
		// further ops are coming — so any snapshot served to a later reload should
		// match it.
		const versionBefore = await page.evaluate(() => window.webstrate.version);

		await page.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(page,
			() => window.webstrate && window.webstrate.loaded, 15));

		// The server's snapshot cache serves whatever entry it has on disk with no
		// staleness bound — correctness relies on clients catching up through the
		// ops since the cached version, which the parallel runner's CPU starvation
		// can hold up for a long time. Worse, a reload that lands while the
		// post-write rebuild is still in flight (its debounce and the Mongo read
		// both stretch under load) ingests the same pre-script entry again. So a
		// reloaded page is only the page under test once its version has caught
		// up with the one captured above — give a behind page a short chance to
		// converge, then reload until one of them does.
		let reloads = 0;
		while (!(await util.waitForFunction(page,
			(v) => window.webstrate && window.webstrate.loaded && window.webstrate.version >= v,
			5, versionBefore)) && reloads < 3) {
			reloads++;
			util.warn('prototype overrides: snapshot still at version ' +
				(await page.evaluate(() =>
					window.webstrate && window.webstrate.loaded ? window.webstrate.version : 'not loaded')) +
				', expected ' + versionBefore + ' — reloading');
			await page.reload({ waitUntil: 'networkidle2' });
		}
		assert.isTrue(await util.waitForFunction(page, () => window.__overrides, 15),
			'the override script should be present after the reloads');
	});

	after(async () => {
		await util.deleteWebstrate(page, url);

		await browser.close();
	});

	it('user-defined cloneNode override should get called', async () => {
		// The overrides run in the loaded handler, which can lag the loaded flag 
		const called = await util.waitForFunction(page,
			() => window.__overrides.cloneNode > 0, 15);
		assert.isTrue(called, 'Node.prototype.cloneNode override should have been called');
	});

	it('user-defined importNode override should get called', async () => {
		const called = await util.waitForFunction(page,
			() => window.__overrides.importNode > 0, 15);
		assert.isTrue(called, 'Document.prototype.importNode override should have been called');
	});

	it('webstrate objects should still be attached to cloned and imported nodes', async () => {
		// Webstrates' own wrapping of cloneNode/importNode must still run underneath the userland
		// override, i.e. cloned/imported nodes still get webstrate objects attached.
		const hasWebstrateObjects = await util.waitForFunction(page, () =>
			window.__clone && window.__clone.webstrate && window.__import && window.__import.webstrate,
		15);
		assert.isTrue(hasWebstrateObjects,
			'cloned and imported nodes should have webstrate objects attached');
	});
});
