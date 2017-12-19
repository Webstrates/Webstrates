const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Basic DOM Manipulation', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		//pageA.on('console', (...args) => console.log(...args));
		await pageA.goto(url, { waitUntil: 'networkidle' });

		pageB = await browser.newPage();
		//pageB.on('console', (...args) => console.log(...args));
		await pageB.goto(url, { waitUntil: 'networkidle' });
	});

	after(async () => {
		await browser.close();
	});

	it('body shouldn\'t initially contain "Hello, world!"', async () => {
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		assert.notEqual(innerHTML, 'Hello, world!');
	});

	it('body should eventually contain "Hello, world!"', async () => {
		// Wait for page to load.
		await util.waitForFunction(pageB,
			() => window.webstrate && window.webstrate.loaded);

		// Then set body to "Hello, world!".
		await pageB.evaluate(() => {
			document.body.innerHTML = 'Hello, world!';
		});

		const bodyContainsHelloWorld = await util.waitForFunction(pageA,
			() => document.body.innerHTML === 'Hello, world!');
		assert.isTrue(bodyContainsHelloWorld);
	});

	it('select element with selected attribute should be selected after on inserting client',
		async () => {
			await pageA.evaluate(() => {
				document.body.innerHTML += `
				<select>
					<option value="value1">Value 1</option>
					<option value="value2" selected>Value 2</option>
					<option value="value3">Value 3</option>
				</select>`;
			});

			const selectedOption = await pageA.evaluate(() =>
				document.querySelector('select').selectedOptions[0].getAttribute('value'));
			const shouldBeSelectedOption = await pageA.evaluate(() =>
				document.querySelector('select > option[selected]').getAttribute('value'));

			assert.equal(selectedOption, shouldBeSelectedOption);
		});

	it('select element with selected attribute should be selected after on other client',
		async () => {
			await util.waitForFunction(pageB, () => document.querySelector('select'));

			const selectedOption = await pageB.evaluate(() =>
				document.querySelector('select').selectedOptions[0].getAttribute('value'));
			const shouldBeSelectedOption = await pageB.evaluate(() =>
				document.querySelector('select > option[selected]').getAttribute('value'));

			assert.equal(selectedOption, shouldBeSelectedOption);
		});

	it('select element with selected attribute should be selected after reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle' });

		const selectedOption = await pageA.evaluate(() =>
			document.querySelector('select').selectedOptions[0].getAttribute('value'));
		const shouldBeSelectedOption = await pageA.evaluate(() =>
			document.querySelector('select > option[selected]').getAttribute('value'));

		assert.equal(selectedOption, shouldBeSelectedOption);
	});


});