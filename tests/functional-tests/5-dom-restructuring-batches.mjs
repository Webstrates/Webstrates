// Regression tests for translating a MutationObserver
// batch in which an editor restructures the DOM (moves nodes through detached
// intermediates, empties text nodes and inserts replacement ones) used to make
// the op creator drop or mis-path operations, silently desyncing the DOM from
// the JsonML document model — with the desync discovered only later, when the
// next edit crashed the local OT apply and the user's text was lost.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('DOM restructuring within one mutation batch (issue #117)', function() {
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

	it('sets up a list whose item contains a span with text', async () => {
		await pageA.evaluate(() => {
			const ul = document.createElement('ul'); ul.id = 'ulx';
			const li = document.createElement('li'); li.id = 'lix';
			const span = document.createElement('span'); span.id = 'spanx';
			span.appendChild(document.createTextNode('TEXT'));
			li.appendChild(span); ul.appendChild(li);
			document.body.appendChild(ul);
		});

		assert.isTrue(await util.waitForFunction(pageA, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXT';
		}, 5), 'span should exist on client A');

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXT';
		}, 5), 'span should sync to client B');
	});

	it('restructures the DOM in one batch the way editors do (issue #117 sequence)', async () => {
		// Same shape as CKEditor's list exit: all statements run in ONE synchronous
		// block => one MutationObserver batch, processed against the batch-final DOM:
		// the span is moved through a detached <p> (no insertion record for the move),
		// the <p> is inserted after the <ul>, the <li> is removed, the original text
		// node is emptied and a replacement text node with the same content is
		// appended.
		await pageA.evaluate(() => {
			const span = document.getElementById('spanx');
			const li = document.getElementById('lix');
			const ul = document.getElementById('ulx');
			const t = span.firstChild;
			const p = document.createElement('p');
			p.appendChild(span);                 // move via detached intermediate
			ul.after(p);                         // insert the restructured subtree
			li.remove();                         // leave the list
			t.data = '';                         // empty the original text node
			span.appendChild(document.createTextNode('TEXT')); // replace its content
		});

		// Client A: the DOM still has the text.
		assert.isTrue(await util.waitForFunction(pageA, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXT' && span.childNodes.length === 2;
		}, 5), 'client A should keep the text');

		// Client B: the document model must agree — the text has to survive the op
		// translation. This is the exact spot where the old code dropped the
		// insertion op and deleted the text with a phantom string-delete, leaving
		// an empty <span> on every other client (and after every reload).
		assert.isTrue(await util.waitForFunction(pageB, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXT' && span.childNodes.length === 2;
		}, 5), 'client B should still see the text (DOM and JsonML in sync)');

		// The empty text node must be part of the document model (first child, no
		// text content), so that later edits on it can be translated.
		const firstChildOnB = await pageB.evaluate(() =>
			document.getElementById('spanx').childNodes[0].data);
		assert.strictEqual(firstChildOnB, '', 'the emptied text node should be present, empty');
	});

	it('keeps editing the restructured text node in sync', async () => {
		// The next edit lands on the replacement text node — with the desync bug
		// present this op crashed the local OT apply (reading path through undefined)
		// and the edit was silently lost.
		await pageA.evaluate(() => {
			const span = document.getElementById('spanx');
			span.lastChild.data += 'a';
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXTa';
		}, 5), 'client B should see the edited text');

		const textOnA = await pageA.evaluate(() =>
			document.getElementById('spanx').textContent);
		assert.strictEqual(textOnA, 'TEXTa', 'client A should keep the edit');
	});

	it('survives a reload (server-side document state is consistent)', async () => {
		await pageA.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageA, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXTa';
		}, 5), 'the text should persist through a reload');
	});

	it('supports typing into a text node that was empty when inserted', async () => {
		// Empty text nodes are part of the model: editors create them all the time
		// (caret placeholders). An empty node must sync as an empty string, and a
		// later characterData edit on it must translate to a string insertion.
		await pageA.evaluate(() => {
			const span = document.getElementById('spanx');
			span.appendChild(document.createTextNode(''));
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const span = document.getElementById('spanx');
			return span && span.childNodes.length === 3;
		}, 5), 'the empty text node should sync as an empty string');

		await pageA.evaluate(() => {
			const span = document.getElementById('spanx');
			span.lastChild.data = 'b';
		});

		assert.isTrue(await util.waitForFunction(pageB, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXTab';
		}, 5), 'the edit on the previously empty node should sync');

		// The reload invariant again, now with an emptied first text node.
		await pageA.reload({ waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageA, () => {
			const span = document.getElementById('spanx');
			return span && span.textContent === 'TEXTab' && span.childNodes.length === 3;
		}, 5), 'the text nodes should persist through a reload');
	});

	it('never threw a client error while doing all of this', async () => {
		assert.isEmpty(pageErrors, 'no page errors should have occurred');
	});
});
