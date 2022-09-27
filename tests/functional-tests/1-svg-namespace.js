// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('SVG Namespace', function() {
	this.timeout(10000);

	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

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
			const namespace = await pageA.evaluate(() =>
				document.querySelector('svg > foreignObject').namespaceURI);
			assert.equal(namespace, SVG_NAMESPACE, 'proper rect namespace after reload on page A');
		});

	it('p element namespace should be "' + XHTML_NAMESPACE + '" after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });
		const namespace = await pageA.evaluate(() =>
			document.querySelector('svg > foreignObject > p').namespaceURI);
		assert.equal(namespace, XHTML_NAMESPACE, 'proper rect namespace after reload on page A');
	});

});