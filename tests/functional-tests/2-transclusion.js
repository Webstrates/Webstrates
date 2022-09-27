// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
const puppeteer = require('puppeteer');
const assert = require('chai').assert;
const config = require('../config.js');
const util = require('../util.js');

describe('Transclusion', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const webstrateIdInner = webstrateId + '-inner';
	const url = config.server_address + webstrateId;
	const urlInner = config.server_address + webstrateIdInner;
	// Remove HTTP basic auth credentials from URL when it's being used as an iframe src attribute.
	const cleanUrlInner = util.cleanServerAddress + webstrateIdInner;
	let browser, pageA, pageB;


	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		await pageB.goto(urlInner, { waitUntil: 'networkidle2' });
	});

	after(async () => {
		await Promise.all([
			pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' }),
			pageB.goto(urlInner + '?delete', { waitUntil: 'domcontentloaded' })
		]);

		await browser.close();
	});

	it('body should initially be empty', async () => {
		const bodyContents = await pageA.evaluate(() => document.body.innerHTML);
		assert.isEmpty(bodyContents.trim());
	});

	it('iframe transcluded event gets triggered', async () => {
		await util.waitForFunction(pageA, () => window.webstrate);

		await pageA.evaluate(cleanUrlInner => {
			const iframe = document.createElement('iframe');
			iframe.src = cleanUrlInner;

			iframe.webstrate.on('transcluded', (webstrateId, clientId) => {
				window.__test_transcluded = true;
				window.__test_transcluded_webstrateId = webstrateId;
				window.__test_transcluded_clientId = clientId;
			});
			document.body.appendChild(iframe);
		}, cleanUrlInner);

		const transcludedEventGetsTriggered = await util.waitForFunction(pageA,
			() => window.__test_transcluded);

		assert.isTrue(transcludedEventGetsTriggered);
	});

	it('webstrate object should exist on iframe\'s document object', async () => {
		const iframeWebstrateObjectExists = await util.waitForFunction(pageA,
			() => document.querySelector('iframe').contentWindow.webstrate);

		assert.isTrue(iframeWebstrateObjectExists);
	});

	it('webstrateId from transcluded event should match requested webstrateId', async () => {
		const webstrateIdFromTranscludedEvent = await pageA.evaluate(() =>
			window.__test_transcluded_webstrateId);

		assert.equal(webstrateIdInner, webstrateIdFromTranscludedEvent);
	});

	it('webstrateId on webstrate object should match actual webstrateId', async () => {
		const webstrateIdFromWebstrateObject = await pageA.evaluate(() =>
			document.querySelector('iframe').contentWindow.webstrate.webstrateId);

		assert.equal(webstrateIdInner, webstrateIdFromWebstrateObject);
	});

	it('clientId from transcluded event should match clientId on webstrate object', async () => {
		const clientIdFromTranscludedEvent = await pageA.evaluate(() =>
			window.__test_transcluded_clientId);

		const clientIdFromWebstrateObject = await pageA.evaluate(() =>
			document.querySelector('iframe').contentWindow.webstrate.clientId);

		assert.equal(clientIdFromTranscludedEvent, clientIdFromWebstrateObject);
	});

	it('changes made to iframe should be reflected on other client', async () => {
		const bodyContents = util.randomString();
		pageA.evaluate(bodyContents => {
			document.querySelector('iframe').contentDocument.body.innerHTML = bodyContents;
		}, bodyContents);

		const bodyMatchesSetBodyContents = await util.waitForFunction(pageB, bodyContents =>
			document.body.innerHTML === bodyContents,
		undefined, bodyContents);

		assert.isTrue(bodyMatchesSetBodyContents);
	});

	it('changes made on other client should be reflected in iframe', async () => {
		const bodyContents = util.randomString();
		pageB.evaluate(bodyContents => {
			document.body.innerHTML = bodyContents;
		}, bodyContents);

		await util.waitForFunction(pageA, bodyContents =>
			document.querySelector('iframe').contentDocument.body.innerHTML === bodyContents,
		undefined, bodyContents);

		const iframeBodyContents = await pageA.evaluate(() =>
			document.querySelector('iframe').contentDocument.body.innerHTML);

		assert.equal(bodyContents, iframeBodyContents);
	});

	it('new iframe\'s content should match initial iframe\'s contents', async () => {
		await pageA.evaluate(cleanUrlInner => {
			const iframe = document.createElement('iframe');
			iframe.src = cleanUrlInner;
			document.body.appendChild(iframe);
		}, cleanUrlInner);

		await util.waitForFunction(pageA, () => {
			const [iniIfrm, newIfrm] = Array.from(document.querySelectorAll('iframe'));
			return iniIfrm.contentDocument.body.innerHTML === newIfrm.contentDocument.body.innerHTML;
		}, 4 /* Higher timeout, it can take a little while for the iframe to load and everything. */);

		const [iniIframeBodyContents, newIframeBoddyContents] = await pageA.evaluate(() => {
			const [iniIfrm, newIfrm] = Array.from(document.querySelectorAll('iframe'));
			return [iniIfrm.contentDocument.body.innerHTML, newIfrm.contentDocument.body.innerHTML];
		});

		assert.equal(iniIframeBodyContents, newIframeBoddyContents);
	});

	it('changes made to one iframe should be reflected in other iframe', async () => {
		const bodyContents = util.randomString();

		pageA.evaluate(bodyContents => {
			document.querySelector('iframe').contentDocument.body.innerHTML = bodyContents;
		}, bodyContents);

		const bodyContentsMatch = await util.waitForFunction(pageA, () => {
			const [iniIfrm, newIfrm] = Array.from(document.querySelectorAll('iframe'));
			return iniIfrm.contentDocument.body.innerHTML === newIfrm.contentDocument.body.innerHTML;
		});

		assert.isTrue(bodyContentsMatch);
	});

});