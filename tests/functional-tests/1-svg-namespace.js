const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('SVG namespace', function() {
	this.timeout(10000);

	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle' });

		pageB = await browser.newPage()
		await pageB.goto(url, { waitUntil: 'networkidle' });
	});

	after(async () => {
		await browser.close();
	});

	it('body should initially be empty', async () => {
		const bodyContents = await pageA.evaluate(() => document.body.innerHTML);
		assert.isEmpty(bodyContents, "");
	});

	it('an inserted svg element should show up on all clients', async () => {
		const bodyContents = await pageA.evaluate((svgNs) =>
			document.body.appendChild(document.createElementNS(svgNs, 'svg')),
		SVG_NAMESPACE);

		const svgElementExistsA = await util.waitForFunction(pageA, () =>
			document.querySelector('svg'));
		const svgElementExistsB = await util.waitForFunction(pageB, () =>
			document.querySelector('svg'));

		assert.isTrue(svgElementExistsA, 'exists on page A');
		assert.isTrue(svgElementExistsB, 'exists on page B');
	});

	it('svg element namespace should be ' + SVG_NAMESPACE + ' on all clients', async () => {
		const namespaceA = await pageA.evaluate(() => document.querySelector('svg').namespaceURI);
		const namespaceB = await pageB.evaluate(() => document.querySelector('svg').namespaceURI);

		assert.equal(namespaceA, SVG_NAMESPACE, 'proper namespace on page A');
		assert.equal(namespaceB, SVG_NAMESPACE, 'proper namespace on page B');
	});

	it('an inserted rect element should show up on all clients', async () => {
		const namespaceA = await pageA.evaluate(() => {
			const svg = document.querySelector('svg');
			svg.appendChild(document.createElementNS(svg.namespaceURI, 'rect'))
		});

		const rectElementExistsA = await util.waitForFunction(pageA, () =>
			document.querySelector('rect'));
		const rectElementExistsB = await util.waitForFunction(pageB, () =>
			document.querySelector('rect'));

		assert.isTrue(rectElementExistsA);
		assert.isTrue(rectElementExistsB);
	});

	it('rect element namespace should be "http://www.w3.org/2000/svg" on all clients', async () => {
		const namespaceA = await pageA.evaluate(() => document.querySelector('rect').namespaceURI);
		const namespaceB = await pageB.evaluate(() => document.querySelector('rect').namespaceURI);

		assert.equal(namespaceA, SVG_NAMESPACE);
		assert.equal(namespaceB, SVG_NAMESPACE);
	});

});