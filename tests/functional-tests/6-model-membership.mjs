// Regression tests for the model-membership audit: the
// DOM, the PathTree and the JsonML document model must agree about *which*
// nodes and attributes are part of the model. The gates that decide membership
// live in three places (corePathTree's transience check, coreJsonML.fromHTML,
// config.isTransientAttribute) and used to disagree for a handful of node and
// attribute types — most severely for comments containing "DOCTYPE" and
// processing instructions, which fromHTML cannot serialize but the PathTree
// registered: the creator then submitted `li: null`, putting a literal null
// into the document that crashed toHTML (null.nodeType) on every subsequent
// load, bricking the document.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Model membership (DOM <-> PathTree <-> JsonML, issue #117 audit)', function() {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;
	const pageErrors = [];

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageA.on('pageerror', error => pageErrors.push(String(error)));
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		pageB = await browser.newPage();
		pageB.on('pageerror', error => pageErrors.push(String(error)));
		await pageB.goto(url, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('empty comments are part of the model', async () => {
		await pageA.evaluate(() => {
			document.body.appendChild(document.createComment(''));
		});
		// An empty comment syncs as ["!", ""]. Before the audit's fix this was fine,
		// but it was indistinguishable in code from the DOCTYPE case below — locking
		// it in here so nobody "fixes" it the wrong way.
		assert.isTrue(await util.waitForFunction(pageB, () =>
			Array.from(document.body.childNodes).some(n =>
				n.nodeType === Node.COMMENT_NODE && n.data === ''),
		5), 'the empty comment should sync to client B');
	});

	it('a comment containing "DOCTYPE" does not corrupt the model (li: null brick)', async () => {
		// fromHTML cannot serialize comments whose text contains "DOCTYPE" (they are
		// indistinguishable from the doctype representation ["!", "DOCTYPE ..."]).
		// The old creator submitted that null as an li payload — a literal null in
		// the document, desyncing every other client and crashing the document on
		// every future load (toHTML: null.nodeType). Such comments are now
		// model-transient, like <transient> elements: the local DOM keeps them,
		// the model never sees them.
		await pageA.evaluate(() => {
			document.body.appendChild(document.createComment(' DOCTYPE html PUBLIC x '));
			const div = document.createElement('div');
			div.id = 'after-doctype-comment';
			div.appendChild(document.createTextNode('alive'));
			document.body.appendChild(div);
		});

		// The model must stay usable: the *modeled* content after the comment syncs.
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-doctype-comment');
			return div && div.textContent === 'alive';
		}, 5), 'content inserted after the unserializable comment should sync to client B');

		// And the document must still load (the pre-fix behavior here was a
		// TypeError: Cannot read properties of null (reading 'nodeType')).
		await pageB.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-doctype-comment');
			return div && div.textContent === 'alive';
		}, 5), 'the document should still load after a DOCTYPE-looking comment was inserted');
	});

	it('a processing instruction does not corrupt the model either', async () => {
		await pageA.evaluate(() => {
			document.body.appendChild(document.createProcessingInstruction('pit', 'pidata'));
			const div = document.createElement('div');
			div.id = 'after-pi';
			div.appendChild(document.createTextNode('still alive'));
			document.body.appendChild(div);
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-pi');
			return div && div.textContent === 'still alive';
		}, 5), 'content inserted after a processing instruction should sync to client B');

		await pageA.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageA, () => {
			const div = document.getElementById('after-pi');
			return div && div.textContent === 'still alive';
		}, 5), 'the document should still load after a processing instruction was inserted');
	});

	it('edits following the unserializable nodes keep syncing', async () => {
		// The whole point of the membership fix: nothing shifted, so the next edit
		// lands on the right node at the right index.
		await pageA.evaluate(() => {
			document.getElementById('after-pi').firstChild.data += '!';
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-pi');
			return div && div.textContent === 'still alive!';
		}, 5), 'the edit after the unserializable nodes should sync to client B');
	});

	it('a __proto__ attribute does not desync the model', async () => {
		// Storing an attribute named __proto__ in the JsonML attributes object is a
		// silent no-op (plain assignment sets the prototype), so the attribute used
		// to vanish from the model while the local DOM kept it. It is now a
		// transient attribute: the DOM keeps it locally, the model ignores it, and
		// the *other* attributes of the element still sync.
		await pageA.evaluate(() => {
			const div = document.createElement('div');
			div.id = 'proto-div';
			div.setAttribute('__proto__', 'evil');
			div.setAttribute('data-kept', 'yes');
			document.body.appendChild(div);
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('proto-div');
			return div && div.getAttribute('data-kept') === 'yes';
		}, 5), 'the other attributes should sync to client B');

		const protoOnB = await pageB.evaluate(() => {
			const div = document.getElementById('proto-div');
			return div ? div.hasAttribute('__proto__') : null;
		});
		assert.isFalse(protoOnB, 'the __proto__ attribute is transient and should not sync');

		// Attribute edits on the element still translate.
		await pageA.evaluate(() => {
			document.getElementById('proto-div').setAttribute('data-kept', 'edited');
		});
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('proto-div');
			return div && div.getAttribute('data-kept') === 'edited';
		}, 5), 'attribute edits on the element should still sync');
	});

	it('DOM children of an iframe do not desync the model', async () => {
		// fromHTML never serializes iframe/frame children (an iframe's content is its
		// nested browsing context), but the PathTree used to register them — a
		// PathTree-without-JsonML misalignment, the mirror image of the empty-text
		// hole. The PathTree now skips them too, so DOM-API children of an iframe
		// are model-transient and everything *after* the iframe stays aligned.
		await pageA.evaluate(() => {
			const iframe = document.createElement('iframe');
			iframe.appendChild(document.createTextNode('never modeled'));
			document.body.appendChild(iframe);
			const div = document.createElement('div');
			div.id = 'after-iframe';
			div.appendChild(document.createTextNode('aligned'));
			document.body.appendChild(div);
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-iframe');
			return div && div.textContent === 'aligned';
		}, 5), 'content after an iframe with DOM children should sync to client B');

		// Editing inside the following sibling must not be shifted by the iframe's
		// unmodeled children.
		await pageA.evaluate(() => {
			document.getElementById('after-iframe').firstChild.data += '!';
		});
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-iframe');
			return div && div.textContent === 'aligned!';
		}, 5), 'edits after an iframe with DOM children should sync to client B');

		await pageB.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const div = document.getElementById('after-iframe');
			return div && div.textContent === 'aligned!';
		}, 5), 'the document should load with aligned content after the iframe');
	});

	it('never threw a client error while doing all of this', async () => {
		assert.isEmpty(pageErrors, 'no page errors should have occurred');
	});
});
