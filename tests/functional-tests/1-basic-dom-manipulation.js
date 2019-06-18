// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
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
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		//pageB.on('console', (...args) => console.log(...args));
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

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
		await pageA.reload({ waitUntil: 'networkidle2' });

		const selectedOption = await pageA.evaluate(() =>
			document.querySelector('select').selectedOptions[0].getAttribute('value'));
		const shouldBeSelectedOption = await pageA.evaluate(() =>
			document.querySelector('select > option[selected]').getAttribute('value'));

		assert.equal(selectedOption, shouldBeSelectedOption);
	});

	it('creating attribute name with " should replace it with _', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		await pageA.evaluate(() => {
			document.body.innerHTML = '<div foo"="bar"></div>';
		});

		await util.sleep(1);

		const attrsA = await pageA.evaluate(() => document.querySelector('div').outerHTML);
		const attrsB = await pageB.evaluate(() => document.querySelector('div').outerHTML);

		assert.deepEqual(attrsA, '<div foo_="bar"></div>');
		assert.deepEqual(attrsA, attrsB);
	});

	it('inserting something into the DOM before the \'loaded\' event should not throw an error',
		async () => {
			await pageA.evaluate(async () => {
				document.head.innerHTML = '<script>document.body.innerHTML = "<div></div>";</script>';
			});

			await util.waitForFunction(pageB, () =>
				document.head.innerHTML === '<script>document.body.innerHTML = "<div></div>";</script>');

			// This isn't pretty, but it seems to be the only way. We attach our event listener for
			// errors on the page, then reload the webstrate, wait 500 ms and see if an error has occured.
			let error = false;
			pageA.on('pageerror', _error => error = _error);

			await pageA.reload({ waitUntil: 'networkidle2' });
			await util.sleep(.5);

			assert.equal(error, false);
		});
});