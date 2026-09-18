// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Transient Tags', function() {
	this.timeout(10000);

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
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('body should initially be empty', async () => {
		const bodyContents = await pageA.evaluate(() => document.body.innerHTML);
		assert.isEmpty(bodyContents.trim(), 'body should be empty');
	});

	it('can insert transient tag into body', async () => {
		await pageA.evaluate(() => {
			const t = document.createElement('transient');
			document.body.appendChild(t);
		});

		const containsTransientTag = await util.waitForFunction(pageA,
			() => document.body.innerHTML.trim() === '<transient></transient>');
		assert.isTrue(containsTransientTag);
	});

	it('transient tag should not be visible to other clients', async () => {
		const containsTransientTag = await util.waitForFunction(pageB,
			() => document.body.innerHTML.trim() === '<transient></transient>');
		assert.isFalse(containsTransientTag);
	});

	it('regular tag should be visible on all clients', async () => {
		await pageA.evaluate(() => {
			const span = document.createElement('span');
			document.body.appendChild(span);
		});

		const containsDivTagA = await util.waitForFunction(pageA,
			() => document.body.querySelector('body > transient + span'));
		assert.isTrue(containsDivTagA);

		const containsDivTagB = await util.waitForFunction(pageB,
			() => document.body.querySelector('body > span'));
		assert.isTrue(containsDivTagB);
	});

	it('can insert div into transient tag', async () => {
		await pageA.evaluate(() => {
			const t = document.querySelector('transient');
			const d = document.createElement('div');
			t.appendChild(d);
		});

		const containsTransientTag = await util.waitForFunction(pageA,
			() => document.body.querySelector('transient > div'));

		assert.isTrue(containsTransientTag);
	});

	it('transient tag should still not be visible to other clients', async () => {
		const containsTransientTag = await util.waitForFunction(pageB,
			() => document.body.querySelector('transient'));

		assert.isFalse(containsTransientTag);
	});

	it('can set transient attribute on body', async () => {
		await pageA.evaluate(() => {
			document.body.setAttribute('transient-foo', 'bar');
		});

		const hasTransientAttribute = await util.waitForFunction(pageA,
			() => document.body.getAttribute('transient-foo') === 'bar');

		assert.isTrue(hasTransientAttribute);
	});

	it('transient attribute should not be visible on other clients', async () => {
		const hasTransientAttribute = await util.waitForFunction(pageB,
			() => document.body.hasAttribute('transient-foo'));

		assert.isFalse(hasTransientAttribute);
	});

	it('regular attribute should be visible on all clients', async () => {
		await pageA.evaluate(() => {
			document.body.setAttribute('regular-foo', 'bar');
		});

		const hasTransientAttributeA = await util.waitForFunction(pageA,
			() => document.body.hasAttribute('regular-foo'));
		assert.isTrue(hasTransientAttributeA);

		const hasTransientAttributeB = await util.waitForFunction(pageB,
			() => document.body.hasAttribute('regular-foo'));
		assert.isTrue(hasTransientAttributeB);
	});

	it('should be able to define custom transient attributes and elements', async () => {
		let error = false;
		pageA.on('pageerror', _error => error = ['pageA', _error]);
		pageB.on('pageerror', _error => error = ['pageB', _error]);

		await pageA.evaluate(() => {
			const script = document.createElement('script');
			script.innerHTML =`webstrate.on('loaded', () => {
		const isTransientAttribute = webstrate.config.isTransientAttribute;
		webstrate.config.isTransientAttribute = (DOMNode, attributeName) =>
			attributeName.startsWith('custom-') || isTransientAttribute(DOMNode, attributeName);

		const isTransientElement = webstrate.config.isTransientElement;
		webstrate.config.isTransientElement = (DOMNode) =>
			DOMNode.tagName.toLowerCase() === 'custom' || isTransientElement(DOMNode);
	});`;
			document.head.appendChild(script);
		});

		await util.sleep(.5);
		assert.equal(error, false, 'error before reload: ' + error);

		await pageA.reload({ waitUntil: 'networkidle2' });

		await util.sleep(.5);
		assert.equal(error, false, 'error after reload: ' + error);
	});

	it('can set custom-transient attribute on body', async () => {
		await pageA.evaluate(() => {
			document.body.setAttribute('custom-foo', 'bar');
		});

		const hasCustomAttribute = await util.waitForFunction(pageA,
			() => document.body.getAttribute('custom-foo') === 'bar');

		assert.isTrue(hasCustomAttribute);
	});

	it('custom-transient attribute should not be be visible on other clients', async () => {
		const hasCustomAttribute = await util.waitForFunction(pageB,
			() => document.body.getAttribute('custom-foo') === 'bar');

		assert.isFalse(hasCustomAttribute);
	});

	it('other regular attributes should still be visible on all clients', async () => {
		await pageA.evaluate(() => {
			document.body.setAttribute('other-foo', 'bar');
		});

		const hasTransientAttributeA = await util.waitForFunction(pageA,
			() => document.body.hasAttribute('other-foo'));
		assert.isTrue(hasTransientAttributeA);

		const hasTransientAttributeB = await util.waitForFunction(pageB,
			() => document.body.hasAttribute('other-foo'));
		assert.isTrue(hasTransientAttributeB);
	});

	it('can insert custom-transient tag into body', async () => {
		await pageA.evaluate(() => {
			const c = document.createElement('custom');
			document.body.appendChild(c);
		});

		const containsCustomTransientTag = await util.waitForFunction(pageA,
			() => document.body.querySelector('custom'));
		assert.isTrue(containsCustomTransientTag);
	});

	it('custom-transient tag should not be visible to other clients', async () => {
		const containsCustomTransientTag = await util.waitForFunction(pageB,
			() => document.body.querySelector('custom'));
		assert.isFalse(containsCustomTransientTag);
	});

	it('other regular tag should still be visible on all clients', async () => {
		await pageA.evaluate(() => {
			const other = document.createElement('other');
			document.body.appendChild(other);
		});

		// We don't check for `body > transient + span + custom + other` here, because we've reloaded,
		// so the `transient` tag should be gone.
		const containsOtherTagA = await util.waitForFunction(pageA,
			() => document.body.querySelector('body > span + custom + other'));
		assert.isTrue(containsOtherTagA);

		const containsOtherTagB = await util.waitForFunction(pageB,
			() => document.body.querySelector('body > span + other'));
		assert.isTrue(containsOtherTagB);
	});

});

describe('Transient Attribute', function() {
	this.timeout(10000);

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
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('can insert element with the transient attribute', async () => {
		await pageA.evaluate(() => {
			const d = document.createElement('div');
			d.id = 'transient-attribute-div';
			d.setAttribute('transient', '');
			d.textContent = 'transient content';
			document.body.appendChild(d);
		});

		const containsTransientDiv = await util.waitForFunction(pageA,
			() => document.body.querySelector('#transient-attribute-div') !== null);
		assert.isTrue(containsTransientDiv);
	});

	it('element with the transient attribute should not be visible to other clients', async () => {
		const containsTransientDiv = await util.waitForFunction(pageB,
			() => document.body.querySelector('#transient-attribute-div') !== null);
		assert.isFalse(containsTransientDiv);
	});

	it('can insert children into transient-attribute elements', async () => {
		await pageA.evaluate(() => {
			const t = document.querySelector('#transient-attribute-div');
			const span = document.createElement('span');
			span.id = 'transient-attribute-span';
			span.textContent = 'transient child';
			t.appendChild(span);
		});

		const containsTransientSpan = await util.waitForFunction(pageA,
			() => document.body.querySelector(
				'#transient-attribute-div > #transient-attribute-span') !== null);
		assert.isTrue(containsTransientSpan);
	});

	it('children of transient-attribute elements should not sync to other clients', async () => {
		const containsTransientSpan = await util.waitForFunction(pageB,
			() => document.body.querySelector(
				'#transient-attribute-div > #transient-attribute-span') !== null);
		assert.isFalse(containsTransientSpan);
	});

	it('elements whose transient attribute is removed before insertion are persisted', async () => {
		await pageA.evaluate(() => {
			const d = document.createElement('div');
			d.id = 'no-longer-transient-div';
			d.setAttribute('transient', '');
			d.removeAttribute('transient');
			document.body.appendChild(d);
		});

		const containsDivA = await util.waitForFunction(pageA,
			() => document.body.querySelector('#no-longer-transient-div') !== null);
		assert.isTrue(containsDivA);

		const containsDivB = await util.waitForFunction(pageB,
			() => document.body.querySelector('#no-longer-transient-div') !== null);
		assert.isTrue(containsDivB);
	});

	it('adding the transient attribute to a persisted element does not sync it', async () => {
		await pageA.evaluate(() => {
			const span = document.createElement('span');
			span.id = 'synced-span';
			document.body.appendChild(span);
		});

		const spanSynced = await util.waitForFunction(pageB,
			() => document.body.querySelector('#synced-span') !== null);
		assert.isTrue(spanSynced);

		await pageA.evaluate(() => {
			document.querySelector('#synced-span').setAttribute('transient', '');
		});

		// The transient attribute itself must never arrive anywhere — it is transient as an
		// attribute, too, and it must not desynchronize the JsonML from the path tree.
		await util.sleep(2);
		const transientAttributeOnB = await pageB.evaluate(() =>
			document.body.querySelector('#synced-span').hasAttribute('transient'));
		assert.isFalse(transientAttributeOnB, 'transient attribute should not synchronize');

		// The element stays persisted — later regular edits still synchronize.
		await pageA.evaluate(() => {
			document.querySelector('#synced-span').setAttribute('data-foo', 'bar');
		});

		const regularAttributeArrived = await util.waitForFunction(pageB,
			() => document.body.querySelector('#synced-span').getAttribute('data-foo') === 'bar');
		assert.isTrue(regularAttributeArrived);
	});

	it('the document element can not be made transient', async () => {
		let error = false;
		pageA.on('pageerror', _error => error = _error);

		await pageA.evaluate(() => {
			document.documentElement.setAttribute('transient', '');
		});

		await util.sleep(.5);
		assert.equal(error, false, 'setting transient on the html element threw: ' + error);

		// Despite the html element carrying the transient attribute, the document must keep
		// synchronizing: a regular element inserted afterwards still arrives on other clients.
		await pageA.evaluate(() => {
			const d = document.createElement('div');
			d.id = 'after-html-transient-div';
			document.body.appendChild(d);
		});

		const containsDivB = await util.waitForFunction(pageB,
			() => document.body.querySelector('#after-html-transient-div') !== null);
		assert.isTrue(containsDivB, 'document should keep synchronizing');
	});

	it('comment nodes are persisted with the default transient configuration', async () => {
		// Comments (and any other non-element node) must pass through isTransientElement
		// without throwing and come out non-transient — userland predicates chain on top of
		// the default one (see the WPMv2 isTransientElement override) and rely on this
		// contract, so guard it.
		let error = false;
		pageA.on('pageerror', _error => error = _error);

		await pageA.evaluate(() => {
			document.body.appendChild(document.createComment('a persisted comment'));
		});

		const commentArrivedOnB = await util.waitForFunction(pageB,
			() => Array.from(document.body.childNodes).some(node =>
				node.nodeType === Node.COMMENT_NODE && node.nodeValue === 'a persisted comment'));
		assert.isTrue(commentArrivedOnB, 'comment should be visible to other clients');

		assert.equal(error, false, 'handling a comment node threw: ' + error);
	});

	it('transient-attribute elements do not survive a reload', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });

		const containsTransientDiv = await util.waitForFunction(pageA,
			() => document.body.querySelector('#transient-attribute-div') !== null);
		assert.isFalse(containsTransientDiv, 'transient-attribute element should be gone after reload');
	});

});