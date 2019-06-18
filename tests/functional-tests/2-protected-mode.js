// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Protected Mode', function () {
	this.timeout(10000);

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
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		assert.isEmpty(innerHTML.trim(), 'body should be empty');
	});

	it('isProtected property should exist on webstrate object and it should be false', async () => {
		const webstrate = await pageA.evaluate(() => window.webstrate);
		assert.exists(webstrate.isProtected, 'webstrate.isProtected property does not exist');
		assert.isFalse(webstrate.isProtected, 'webstrate is protected');
	});

	it('should be possible to add data-protected attribute', async () => {
		await pageA.evaluate(() =>
			document.documentElement.setAttribute('data-protected', ''));

		const attributeSetA = await util.waitForFunction(pageA, () =>
			document.documentElement.getAttribute('data-protected') === '');
		assert.isTrue(attributeSetA);

		const attributeSetB = await util.waitForFunction(pageB, () =>
			document.documentElement.getAttribute('data-protected') === '');
		assert.isTrue(attributeSetB);
	});

	// We don't do this just to test the attribute, the page must be reloaded after making the body
	// protected.
	it('data-protected attribute should be visible after reload', async () => {
		await Promise.all([pageA.reload(), pageB.reload()]);

		const attributeSetA = await util.waitForFunction(pageA, () =>
			document.documentElement.getAttribute('data-protected') === '');
		assert.isTrue(attributeSetA);
	});

	it('webstrate should be protected', async () => {
		const webstrate = await pageA.evaluate(() => window.webstrate);
		assert.isTrue(webstrate.isProtected, 'webstrate isn\'t protected');
	});

	it('inserted transient div should be visible on inserting client', async () => {
		await pageA.evaluate(() => {
			const div = document.createElement('div');
			div.innerHTML = 'X';
			document.body.appendChild(div);
		});

		const bodyHasOneChild = await util.waitForFunction(pageA, () =>
			document.body.children.length === 1);
		assert.isTrue(bodyHasOneChild);

		const childContentsA = await pageA.evaluate(() => document.body.firstElementChild.innerHTML);
		assert.equal(childContentsA, 'X', 'div should contain exactly \'X');
	});

	it('inserted transient div should not be visible on other client', async () => {
		const bodyHasChildrenB = await util.waitForFunction(pageB, () =>
			document.body.children.length > 0);
		assert.isFalse(bodyHasChildrenB, 'transient div should not be visible on other client');
	});

	it('inserted non-transient div should be visible on inserting client', async () => {
		await pageA.evaluate(() => {
			const div = document.createElement('div', { approved: true });
			div.innerHTML = 'Y';
			document.body.appendChild(div);
		});

		const bodyHasTwoChildren = await util.waitForFunction(pageA, () =>
			document.body.children.length === 2);
		assert.isTrue(bodyHasTwoChildren,
			'body has two children (transient div and non-transient div)');

		const childContentsA = await pageA.evaluate(() => document.body.lastElementChild.innerHTML);
		assert.equal(childContentsA, 'Y', 'div should contain exactly \'Y');
	});

	it('inserted non-transient div should be visible on other client', async () => {
		const bodyHasOneChildB = await util.waitForFunction(pageB, () =>
			document.body.children.length === 1);
		assert.isTrue(bodyHasOneChildB, 'body should have exactly one child');
	});

	it('inserted non-transient div with defined namespace should be visible on inserting client',
		async () => {
			await pageA.evaluate(() => {
				const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div',
					{ approved: true });
				div.innerHTML = 'Y';
				document.body.appendChild(div);
			});

			const bodyHasThreeChildren = await util.waitForFunction(pageA, () =>
				document.body.children.length === 3);
			assert.isTrue(bodyHasThreeChildren,
				'body has two children (transient div and non-transient div)');

			const childContentsA = await pageA.evaluate(() => document.body.lastElementChild.innerHTML);
			assert.equal(childContentsA, 'Y', 'div should contain exactly \'Y');
		});

	it('inserted non-transient div with defined namespace should be visible on other client',
		async () => {
			const bodyHasTwoChildrenB = await util.waitForFunction(pageB, () =>
				document.body.children.length === 2);
			assert.isTrue(bodyHasTwoChildrenB, 'body should have exactly one child');
		});


	it('transient attribute set should be visible on inserting client', async () => {
		await pageA.evaluate(() =>
			document.body.lastElementChild.setAttribute('x', 'Transient attribute'));

		const hasAttributeA = await util.waitForFunction(pageA, () =>
			document.body.lastElementChild.getAttribute('x'));
		assert.isTrue(hasAttributeA, 'attribute should be visible');

		const attribute = await pageA.evaluate(() => document.body.lastElementChild.getAttribute('x'));
		assert.equal(attribute, 'Transient attribute', 'Attribute is \'Transient attribute!\'');
	});

	it('transient attribute set should not be visible on other client', async () => {
		const hasAttributeB = await util.waitForFunction(pageB, () => document.body.getAttribute('x'));
		assert.isFalse(hasAttributeB, 'attribute should not be visible');
	});

	it('non-transient attribute set should be visible on inserting client', async () => {
		await pageA.evaluate(() =>
			document.body.lastElementChild.setAttribute('y', 'Non-transient attribute',
				{ approved: true }));

		const hasAttributeA = await util.waitForFunction(pageA, () =>
			document.body.lastElementChild.hasAttribute('y'));
		assert.isTrue(hasAttributeA, 'attribute should be visible');

		const attribute = await pageA.evaluate(() => document.body.lastElementChild.getAttribute('y'));
		assert.equal(attribute, 'Non-transient attribute', 'Attribute is \'Non-transient attribute\'');
	});

	it('non-transient attribute set should be visible on other client', async () => {
		const hasAttributeB = await util.waitForFunction(pageB, () =>
			document.body.lastElementChild.hasAttribute('y'));
		assert.isTrue(hasAttributeB, 'attribute should be visible');

		const attribute = await pageB.evaluate(() => document.body.lastElementChild.getAttribute('y'));
		assert.equal(attribute, 'Non-transient attribute', 'Attribute is \'Non-transient attribute\'');
	});

	it('edit on non-transient attribute set should be visible to other clients', async () => {
		await util.sleep(1);

		await pageA.evaluate(() => document.body.lastElementChild.setAttribute('y', 'Edit A'));

		const correctAttributeValueA = await util.waitForFunction(pageB, () =>
			document.body.lastElementChild.getAttribute('y') === 'Edit A');
		assert.isTrue(correctAttributeValueA, 'attribute set on client A gets reflected to B');

		await pageB.evaluate(() => document.body.lastElementChild.setAttribute('y', 'Edit B'));

		const correctAttributeValueB = await util.waitForFunction(pageA, () =>
			document.body.lastElementChild.getAttribute('y') === 'Edit B');
		assert.isTrue(correctAttributeValueB, 'attribute set on client B gets reflected to A');
	});

	it('id property should be visible as non-transient id attribute on inserting client',
		async () => {
			await pageA.evaluate(() => document.body.id = 'body-id');

			const hasAttributeId = await util.waitForFunction(pageA, () =>
				document.body.hasAttribute('id'));
			assert.isTrue(hasAttributeId, 'attribute not visible');

			const attributeValue = await pageA.evaluate(() => document.body.id);
			assert.equal(attributeValue, 'body-id', 'The id attribute is not \'body-id\'');
		});

	it('id property should be visible as non-transient id attribute on other client', async () => {
		const hasAttributeId = await util.waitForFunction(pageB, () =>
			document.body.hasAttribute('id'));
		assert.isTrue(hasAttributeId, 'attribute not visible');

		const attributeValue = await pageB.evaluate(() => document.body.id);
		assert.equal(attributeValue, 'body-id', 'The id attribute is not \'body-id\'');
	});

	it('classList.add should be visible as non-transient class attribute on inserting client',
		async () => {
			await pageA.evaluate(() => document.body.classList.add('class1'));

			const hasAttributeClass = await util.waitForFunction(pageA, () =>
				document.body.getAttribute('class'));
			assert.isTrue(hasAttributeClass, 'attribute not visible');

			const attributeValue = await pageA.evaluate(() => document.body.getAttribute('class'));
			assert.equal(attributeValue, 'class1', 'The class attribute is not \'class1\'');
		});

	it('classList.add should be visible as non-transient class attribute on other client',
		async () => {
			const hasAttributeClass = await util.waitForFunction(pageB, () =>
				document.body.hasAttribute('class'));
			assert.isTrue(hasAttributeClass, 'attribute not visible');

			const attributeValue = await pageB.evaluate(() => document.body.getAttribute('class'));
			assert.equal(attributeValue, 'class1', 'The id attribute is not \'class1\'');
		});

	it('classList.contains should work on both clients',
		async () => {
			const pageAContainsClass = await util.waitForFunction(pageA, () =>
				document.body.classList.contains('class1'));
			assert.isTrue(pageAContainsClass, 'class attribute does not contain \'class1\'');

			const pageBContainsClass = await util.waitForFunction(pageB, () =>
				document.body.classList.contains('class1'));
			assert.isTrue(pageBContainsClass, 'class attribute does not contain \'class1\'');
		});

	it('style properties should be visible as non-transient style attribute on inserting client',
		async () => {
			await pageA.evaluate(() => document.body.style.backgroundColor = 'hotpink');

			const hasAttribute = await util.waitForFunction(pageA, () =>
				document.body.getAttribute('style'));
			assert.isTrue(hasAttribute, 'style attribute not visible');

			const propertyValue = await pageA.evaluate(() => document.body.style.backgroundColor);
			assert.equal(propertyValue, 'hotpink',
				'style.backgroundColor property is not \'hotpink\'');

			const attributeValue = await pageA.evaluate(() =>
				document.body.getAttribute('style'));
			assert.equal(attributeValue, 'background-color: hotpink;',
				'style attribute is not \'background-color: hotpink\'');
		});

	it('style properties should be visible as non-transient style attribute on other client',
		async () => {
			const hasAttribute = await util.waitForFunction(pageB, () =>
				document.body.getAttribute('style'));
			assert.isTrue(hasAttribute, 'style attribute not visible');

			const propertyValue = await pageB.evaluate(() => document.body.style.backgroundColor);
			assert.equal(propertyValue, 'hotpink',
				'style.backgroundColor property is not \'hotpink\'');

			const attributeValue = await pageB.evaluate(() =>
				document.body.getAttribute('style'));
			assert.equal(attributeValue, 'background-color: hotpink;',
				'style attribute is not \'background-color: hotpink\'');
		});

	it('dataset properties should be visible as non-transient data-* attribute on inserting client',
		async () => {
			await pageA.evaluate(() => document.body.dataset.camelCase = 'kebab-case');

			const hasAttribute = await util.waitForFunction(pageA, () =>
				document.body.getAttribute('data-camel-case'));
			assert.isTrue(hasAttribute, 'attribute not visible');

			const datasetValue = await pageA.evaluate(() => document.body.dataset.camelCase);
			assert.equal(datasetValue, 'kebab-case',
				'The data-camel-case property is not \'kebab-case\'');

			const attributeValue = await pageA.evaluate(() =>
				document.body.getAttribute('data-camel-case'));
			assert.equal(attributeValue, 'kebab-case',
				'The data-camel-case attribute is not \'kebab-case\'');
		});

	it('dataset properties should be visible as non-transient data-* attribute on other client',
		async () => {
			const hasAttribute = await util.waitForFunction(pageB, () =>
				document.body.getAttribute('data-camel-case'));
			assert.isTrue(hasAttribute, 'attribute not visible');

			const datasetValue = await pageB.evaluate(() => document.body.dataset.camelCase);
			assert.equal(datasetValue, 'kebab-case',
				'The data-camel-case property is not \'kebab-case\'');

			const attributeValue = await pageB.evaluate(() =>
				document.body.getAttribute('data-camel-case'));
			assert.equal(attributeValue, 'kebab-case',
				'The data-camel-case attribute is not \'kebab-case\'');
		});
});