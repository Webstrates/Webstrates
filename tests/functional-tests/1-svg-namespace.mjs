import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('SVG Namespace', function() {
	this.timeout(30000);

	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await util.deleteWebstrate(pageA, url);

		await browser.close();
	});

	it('body should initially be empty', async () => {
		const bodyContents = await pageA.evaluate(() => document.body.innerHTML);
		assert.isEmpty(bodyContents.trim());
	});

	it('inserted svg element should show up on all clients', async () => {
		await pageA.evaluate((svgNs) =>
			document.body.appendChild(document.createElementNS(svgNs, 'svg')),
		SVG_NAMESPACE);

		const svgElementExistsA = await util.waitForFunction(pageA, () =>
			document.querySelector('svg'), 5);
		const svgElementExistsB = await util.waitForFunction(pageB, () =>
			document.querySelector('svg'), 5);

		assert.isTrue(svgElementExistsA, 'exists on page A');
		assert.isTrue(svgElementExistsB, 'exists on page B');
	});

	it('svg element namespace should be "' + SVG_NAMESPACE + '" on all clients', async () => {
		const namespaceA = await pageA.evaluate(() => document.querySelector('svg').namespaceURI);
		const namespaceB = await pageB.evaluate(() => document.querySelector('svg').namespaceURI);

		assert.equal(namespaceA, SVG_NAMESPACE, 'proper svg namespace on page A');
		assert.equal(namespaceB, SVG_NAMESPACE, 'proper svg namespace on page B');
	});

	it('svg element namespace should be "' + SVG_NAMESPACE + '" after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		// The reloaded page populates over the websocket after load, so the svg can
		// still be absent when networkidle2 resolves on a busy machine — wait for it.
		const svgExists = await util.waitForFunction(pageA, () =>
			document.querySelector('svg'), 15);
		assert.isTrue(svgExists, 'svg element exists after reload on page A');

		const namespace = await pageA.evaluate(() => document.querySelector('svg').namespaceURI);
		assert.equal(namespace, SVG_NAMESPACE, 'proper svg namespace after reload on page A');
	});

	it('an inserted rect element should show up on all clients', async () => {
		await pageA.evaluate(() => {
			const svg = document.querySelector('svg');
			svg.appendChild(document.createElementNS(svg.namespaceURI, 'rect'));
		});

		const rectElementExistsA = await util.waitForFunction(pageA, () =>
			document.querySelector('rect'));
		const rectElementExistsB = await util.waitForFunction(pageB, () =>
			document.querySelector('rect'));

		assert.isTrue(rectElementExistsA, 'exists on page A');
		assert.isTrue(rectElementExistsB, 'exists on page A');
	});

	it('rect element namespace should be "' + SVG_NAMESPACE + '" on all clients', async () => {
		const namespaceA = await pageA.evaluate(() => document.querySelector('rect').namespaceURI);
		const namespaceB = await pageB.evaluate(() => document.querySelector('rect').namespaceURI);

		assert.equal(namespaceA, SVG_NAMESPACE);
		assert.equal(namespaceB, SVG_NAMESPACE);
	});

	it('rect element namespace should be "' + SVG_NAMESPACE + '" after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		// As above: wait for the population to re-apply the rect before reading it.
		const rectExists = await util.waitForFunction(pageA, () =>
			document.querySelector('rect'), 15);
		assert.isTrue(rectExists, 'rect element exists after reload on page A');

		const namespace = await pageA.evaluate(() => document.querySelector('rect').namespaceURI);
		assert.equal(namespace, SVG_NAMESPACE, 'proper rect namespace after reload on page A');
	});

	it('an inserted foreignObject (with p child) should show up on all clients',
		async () => {
			await pageA.evaluate((svgNs) => {
				const foreignObject = document.createElementNS(svgNs, 'foreignObject');
				foreignObject.appendChild(document.createElement('p'));
				document.querySelector('svg').appendChild(foreignObject);
			}, SVG_NAMESPACE);

			const foreignObjectExistsA = await util.waitForFunction(pageA, () =>
				document.querySelector('svg > foreignObject > p'));
			const foreignObjectExistsB = await util.waitForFunction(pageB, () =>
				document.querySelector('svg > foreignObject > p'));

			assert.isTrue(foreignObjectExistsA, 'exists on page A');
			assert.isTrue(foreignObjectExistsB, 'exists on page B');
		});

	it('foreignObject element namespace should be "' + SVG_NAMESPACE + '" on all clients',
		async () => {
			const namespaceA = await pageA.evaluate(() =>
				document.querySelector('svg > foreignObject').namespaceURI);
			const namespaceB = await pageB.evaluate(() =>
				document.querySelector('svg > foreignObject').namespaceURI);

			assert.equal(namespaceA, SVG_NAMESPACE, 'proper foreignObject namespace on page A');
			assert.equal(namespaceB, SVG_NAMESPACE, 'proper foreignObject namespace on page B');
		});

	it('p element namespace should be "' + XHTML_NAMESPACE + '" on all clients', async () => {
		const namespaceA = await pageA.evaluate(() =>
			document.querySelector('svg > foreignObject > p').namespaceURI);
		const namespaceB = await pageB.evaluate(() =>
			document.querySelector('svg > foreignObject > p').namespaceURI);

		assert.equal(namespaceA, XHTML_NAMESPACE, 'proper p namespace on page A');
		assert.equal(namespaceB, XHTML_NAMESPACE, 'proper p namespace on page B');
	});

	it('foreignObject element namespace should be "' + SVG_NAMESPACE + '" after reload',
		async () => {
			await pageA.reload({ waitUntil: 'networkidle2' });

			// The reloaded page must be populated before its elements can be queried;
			// populate lags networkidle2
			assert.isTrue(await util.waitForFunction(pageA,
				() => window.webstrate && window.webstrate.loaded, 15));

			const namespace = await pageA.evaluate(() =>
				document.querySelector('svg > foreignObject').namespaceURI);
			assert.equal(namespace, SVG_NAMESPACE, 'proper rect namespace after reload on page A');
		});

	it('p element namespace should be "' + XHTML_NAMESPACE + '" after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		// The reloaded page must be populated before its elements can be queried;
		// populate lags networkidle2
		assert.isTrue(await util.waitForFunction(pageA,
			() => window.webstrate && window.webstrate.loaded, 15));

		const namespace = await pageA.evaluate(() =>
			document.querySelector('svg > foreignObject > p').namespaceURI);
		assert.equal(namespace, XHTML_NAMESPACE, 'proper rect namespace after reload on page A');
	});

});