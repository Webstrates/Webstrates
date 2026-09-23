// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// The v2 painted transport end-to-end: initial loads serve the pre-rendered
// page on the native wire (temp real <head> + sync bundle, <head_> mirror
// head, <eid>_ identity prefixes, <!--wsh--> region marker, trailing
// unquoted _=<eid> on every element) and the client adopts it in place —
// with ZERO fetchStructure ws actions and ZERO ?json requests. Covers the
// feature matrix (text/comment nodes, whitespace-only text, entity/quote
// attributes, neutered scripts, templates with text, head attributes,
// html-level nodes), the edit-and-repaint round-trip through the adopted
// DOM attribute order (positions are local per element now), and the
// server-side stability normalization: a DOM-API-created table>tr (a shape
// no parser would reproduce) is normalized in one commit on its first load
// and served byte-stable afterwards.
describe('Painted transport v2', function() {
	this.timeout(60000);

	const featureId = 'test-' + util.randomString();
	const unstableId = 'test-' + util.randomString();
	let browser;

	// Wire + request surveillance for the zero-fallback assertions.
	const framesLog = [];
	const jsonRequests = [];
	const watchPage = async (page) => {
		const cdp = await page.createCDPSession();
		await cdp.send('Network.enable');
		cdp.on('Network.webSocketFrameSent', (p) => {
			try { framesLog.push(String(p.response.payloadData)); } catch (err) { /* gone */ }
		});
		cdp.on('Network.requestWillBeSent', (p) => {
			if (String(p.request.url).includes('?json')) jsonRequests.push(p.request.url);
		});
	};

	const openPage = async (webstrateId) => {
		const page = await browser.newPage();
		await watchPage(page);
		const errors = [];
		page.on('pageerror', (err) => errors.push(String(err)));
		await page.goto(config.server_address + webstrateId + '/',
			{ waitUntil: 'load', timeout: 45000 });
		await page.waitForFunction(
			() => window.webstrate && window.webstrate.loaded === true,
			{ timeout: 45000, polling: 50 });
		return { page, errors };
	};

	before(async () => {
		browser = await puppeteer.launch();
	});

	after(async () => {
		if (browser) await browser.close();
		// The test documents are deleted best-effort; the harness drops the
		// whole test database anyway.
		for (const id of [featureId, unstableId]) {
			try {
				await fetch(config.server_address + id + '/?delete',
					{ redirect: 'manual', signal: AbortSignal.timeout(5000) });
			} catch (err) { /* already gone */ }
		}
	});

	it('builds a feature document through the client API', async () => {
		const { page, errors } = await openPage(featureId);
		assert.equal(errors.length, 0, errors.join(' ; '));
		await page.evaluate(() => {
			const w = window.webstrate;
			const b = document.body;
			b.innerHTML = '<div id="zoo" class="first" data-odd=\'He said "hi" &amp; bye\'><!-- start --></div>'
				+ '<p id="para">Some <b>bold</b> text</p>'
				+ '<div id="emptytext"></div>'
				+ '<script>window.__scriptRan = true;</' + 'script>'
				+ '<template id="tpl">tpl <i>inner</i> text</template>'
				+ '<div id="trail"> </div>';
			const e = document.getElementById('emptytext');
			e.appendChild(document.createTextNode(''));
			e.appendChild(document.createComment(' invisible '));
			document.head.setAttribute('data-head-attr', 'head-value');
			document.documentElement.insertBefore(
				document.createTextNode(' html-level '), document.body);
			w.dataSaved();
		});
		await page.evaluate(() => window.webstrate.dataSaved());
		await util.sleep(2.5);
		const version = await page.evaluate(() => window.webstrate.version);
		assert.isAbove(version, 0);
		await page.close();
	});

	it('adopts the painted page natively (zero fallbacks)', async () => {
		framesLog.length = 0;
		jsonRequests.length = 0;
		const { page, errors } = await openPage(featureId);
		const s = await page.evaluate(() => {
			const tpl = document.getElementById('tpl');
			const htmlLevel = [...document.documentElement.childNodes].filter(
				(n) => n.nodeType === 3).map((n) => n.data).join('|');
			return {
				version: window.webstrate.version,
				scriptRan: !!window.__scriptRan,
				odd: document.getElementById('zoo').getAttribute('data-odd'),
				zooClass: document.getElementById('zoo').className,
				comment1: !!(document.getElementById('zoo').childNodes[0]
					&& document.getElementById('zoo').childNodes[0].nodeType === 8
					&& document.getElementById('zoo').childNodes[0].data === ' start '),
				comment2: [...document.getElementById('emptytext').childNodes].some(
					(n) => n.nodeType === 8 && n.data === ' invisible '),
				trailWs: !!(document.getElementById('trail').childNodes[0]
					&& document.getElementById('trail').childNodes[0].nodeType === 3
					&& document.getElementById('trail').childNodes[0].data === ' '),
				paraText: document.getElementById('para').textContent,
				paraBold: document.getElementById('para').querySelector('b').textContent,
				htmlEid: document.documentElement.__wid,
				headAttr: document.head.getAttribute('data-head-attr'),
				htmlLevel,
				tplContent: tpl && tpl.content && tpl.content.textContent,
				tplIEid: !!(tpl && tpl.content && tpl.content.querySelector('i')
					&& Number.isInteger(tpl.content.querySelector('i').__wid)),
				underscoreAttrs: document.querySelectorAll('[_]').length,
				headUnderscoreEl: !!document.querySelector('head_'),
				wshComments: [...document.querySelectorAll('body, body *')]
					.concat([...document.documentElement.childNodes])
					.some((n) => n.nodeType === 8 && n.data === 'wsh'),
				bundleInHead: !!document.getElementById('__webstrates_client'),
				preloadLinks: document.querySelectorAll('link[rel=preload][as=script]').length,
				scriptsNeutered: document.querySelectorAll('script[type="webstrates/x"]').length,
				errorBanner: [...document.body.children].some((n) => n.textContent
					&& n.textContent.includes('could not adopt this document'))
			};
		});
		// Doc script executed (populator ran it after adoption).
		assert.equal(s.scriptRan, true, 'the document script did not execute');
		assert.equal(s.odd, 'He said "hi" & bye', 'entity/quote attribute broken: ' + s.odd);
		assert.equal(s.zooClass, 'first');
		assert.equal(s.comment1, true, 'inline comment node not adopted');
		assert.equal(s.comment2, true, 'appended comment node not adopted');
		assert.equal(s.trailWs, true, 'whitespace-only text node lost');
		assert.equal(s.paraText, 'Some bold text');
		assert.equal(s.paraBold, 'bold');
		assert.equal(s.htmlEid, 1, 'html element not registered with eid 1');
		assert.equal(s.headAttr, 'head-value',
			'mirror head attribute not copied onto the real head');
		// Adjacent html-level texts merge on the wire (one prefixed run); the
		// first-paint normalization commits the merge.
		assert.equal(s.htmlLevel, '\n html-level ',
			'html-level region not moved back: ' + JSON.stringify(s.htmlLevel));
		assert.equal(s.tplContent, 'tpl inner text', 'template content lost');
		assert.equal(s.tplIEid, true, 'template content nodes not registered');
		assert.equal(s.underscoreAttrs, 0, '_ attributes left in the DOM');
		assert.equal(s.headUnderscoreEl, false, 'head_ element left behind');
		assert.equal(s.wshComments, false, 'wsh marker comment left behind');
		assert.equal(s.bundleInHead, false, 'bundle script left in head');
		assert.equal(s.preloadLinks, 0, 'preload links left in head');
		assert.equal(s.scriptsNeutered, 0, 'scripts left neutered');
		assert.equal(s.errorBanner, false, 'adoption reported an error');
		const fetchStructures = framesLog.filter((f) => f.includes('fetchStructure')).length;
		assert.equal(fetchStructures, 0,
			'fetchStructure on the painted load: ' + framesLog.slice(0, 3).join(' | '));
		assert.equal(jsonRequests.length, 0,
			'?json requested on the painted load: ' + jsonRequests.join(', '));
		assert.equal(errors.length, 0, errors.join(' ; '));

		// Edit through the adopted indexes and reload: the next paint serves it.
		await page.evaluate(() => {
			const w = window.webstrate;
			const zoo = document.getElementById('zoo');
			zoo.setAttribute('class', 'second');           // replace existing attr
			zoo.removeAttribute('data-odd');              // remove existing attr
			zoo.setAttribute('data-new', 'n1');            // add attr
			document.getElementById('para').querySelector('b').textContent = 'BOLD';
			const extra = document.createElement('div');
			extra.id = 'added'; extra.textContent = 'added text';
			document.body.appendChild(extra);
			w.dataSaved();
		});
		const v1 = s.version;
		await page.evaluate(() => window.webstrate.dataSaved());
		await util.sleep(2);
		const v2 = await page.evaluate(() => window.webstrate.version);
		assert.isAbove(v2, v1, 'edits did not commit');
		await page.close();

		framesLog.length = 0;
		jsonRequests.length = 0;
		const reloaded = await openPage(featureId);
		const r2 = await reloaded.page.evaluate(() => ({
			zooClass: document.getElementById('zoo').className,
			odd: document.getElementById('zoo').getAttribute('data-odd'),
			newAttr: document.getElementById('zoo').getAttribute('data-new'),
			bold: document.getElementById('para').querySelector('b').textContent,
			added: document.getElementById('added')
				&& document.getElementById('added').textContent,
			headAttr: document.head.getAttribute('data-head-attr'),
			htmlLevel: [...document.documentElement.childNodes].filter(
				(n) => n.nodeType === 3).map((n) => n.data).join('|'),
			underscoreAttrs: document.querySelectorAll('[_]').length
		}));
		assert.equal(r2.zooClass, 'second', 'attr replace not served');
		assert.equal(r2.odd, null, 'removed attr resurrected');
		assert.equal(r2.newAttr, 'n1', 'added attr not served');
		assert.equal(r2.bold, 'BOLD', 'text edit not served');
		assert.equal(r2.added, 'added text', 'structural edit not served');
		assert.equal(r2.headAttr, 'head-value', 'head attr lost');
		assert.equal(r2.htmlLevel, '\n html-level ', 'html-level region lost');
		assert.equal(r2.underscoreAttrs, 0, '_ attributes left on reload');
		assert.equal(framesLog.filter((f) => f.includes('fetchStructure')).length, 0,
			'fetchStructure after edits');
		assert.equal(jsonRequests.length, 0, '?json after edits');
		await reloaded.page.close();
	});

	it('normalizes a DOM-API table>tr on first load and stays byte-stable', async () => {
		// Build the unstable shape through the DOM API (no parser involved):
		// the mirror holds table>tr — impossible to re-parse back.
		const { page } = await openPage(unstableId);
		await page.evaluate(() => {
			const w = window.webstrate;
			const tbl = document.createElement('table');
			tbl.id = 'tbl';
			const tr = document.createElement('tr');
			const td = document.createElement('td');
			td.textContent = 'cell-one';
			tr.appendChild(td);
			tbl.appendChild(tr);
			document.body.appendChild(tbl);
			w.dataSaved();
		});
		await page.evaluate(() => window.webstrate.dataSaved());
		await util.sleep(2.5);
		const builtVersion = await page.evaluate(() => window.webstrate.version);
		await page.close();

		// First load: the served paint is the parser-canonical shape (tbody
		// synthesized by the browser would have been the "first ops").
		framesLog.length = 0;
		jsonRequests.length = 0;
		const first = await openPage(unstableId);
		const s1 = await first.page.evaluate(() => ({
			v: window.webstrate.version,
			tbodies: document.querySelectorAll('#tbl tbody').length,
			td: (document.querySelector('#tbl td') || {}).textContent,
			directTrs: document.querySelectorAll('#tbl > tr').length,
			errorBanner: [...document.body.children].some((n) => n.textContent
				&& n.textContent.includes('could not adopt this document'))
		}));
		assert.isAbove(s1.v, builtVersion,
			`normalization did not commit (${builtVersion} -> ${s1.v})`);
		assert.equal(s1.tbodies, 1, 'tbody not synthesized');
		assert.equal(s1.directTrs, 0, 'tr still a direct table child');
		assert.equal(s1.td, 'cell-one', 'cell content lost in normalization');
		assert.equal(s1.errorBanner, false, 'unstable doc reported an error');
		assert.equal(framesLog.filter((f) => f.includes('fetchStructure')).length, 0,
			'fetchStructure while normalizing');
		assert.equal(jsonRequests.length, 0, '?json while normalizing');
		assert.equal(first.errors.length, 0, first.errors.join(' ; '));
		await first.page.close();

		// Second load: stable — no further commits, same shape.
		const second = await openPage(unstableId);
		const s2 = await second.page.evaluate(() => ({
			v: window.webstrate.version,
			tbodies: document.querySelectorAll('#tbl tbody').length,
			td: (document.querySelector('#tbl td') || {}).textContent
		}));
		assert.equal(s2.v, s1.v, `second load committed again (${s1.v} -> ${s2.v})`);
		assert.equal(s2.tbodies, 1, 'tbody lost on second load');
		assert.equal(s2.td, 'cell-one', 'cell content lost on second load');
		await second.page.close();
	});
});
