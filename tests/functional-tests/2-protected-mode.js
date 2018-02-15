// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Protected Mode', function() {
	this.timeout(10000);

	const webstrateId = 'shy-goat-87'; //'test-' + util.randomString();
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
		await browser.close();
	});

	it('body should initially be empty', async () => {
		const innerHTML = await pageA.evaluate(() => document.body.innerHTML);
		assert.equal(innerHTML.trim(), '', 'body should be empty');
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

	it('transient attribute set should be visible on inserting client', async () =>
	{
		await pageA.evaluate(() =>
			document.body.lastElementChild.setAttribute('x', 'Transient attribute'));

		const hasAttributeA = await util.waitForFunction(pageA, () =>
			document.body.lastElementChild.getAttribute('x'));
		assert.isTrue(hasAttributeA, 'attribute should be visible');

		const attribute = await pageA.evaluate(() => document.body.lastElementChild.getAttribute('x'));
		assert.equal(attribute, 'Transient attribute', 'Attribute is \'Transient attribute!\'');
	});

	it('transient attribute set should not be visible on other client', async () =>
	{
		const hasAttributeB = await util.waitForFunction(pageB, () => document.body.getAttribute('x'));
		assert.isFalse(hasAttributeB, 'attribute should not be visible');
	});

	it('non-transient attribute set should be visible on inserting client', async () =>
	{
		await pageA.evaluate(() =>
			document.body.lastElementChild.setAttribute('y', 'Non-transient attribute',
			{ approved: true }));

		const hasAttributeA = await util.waitForFunction(pageA, () =>
			document.body.lastElementChild.getAttribute('y'));
		assert.isTrue(hasAttributeA, 'attribute should be visible');

		const attribute = await pageA.evaluate(() => document.body.lastElementChild.getAttribute('y'));
		assert.equal(attribute, 'Non-transient attribute', 'Attribute is \'Non-transient attribute\'');
	});

	it('non-transient attribute set should be visible on other client', async () =>
	{
		const hasAttributeB = await util.waitForFunction(pageB, () => document.body.getAttribute('y'));
		assert.isFalse(hasAttributeB, 'attribute should be visible');
	});

	it('edit on non-transient attribute set should be visible to other clients', async () =>
	{
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

});