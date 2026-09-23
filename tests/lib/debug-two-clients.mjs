// Two-client repro: insert an element on pageA, watch it on pageB.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import config from '../config.js';
import util from '../util.js';
import harness from './server-harness.mjs';

const t0 = Date.now();
const log = (...args) => fs.writeSync(1, `+${Date.now() - t0}ms ${args.join(' ')}\n`);

if (process.getuid && process.getuid() === 0 && !process.env.PUPPETEER_EXECUTABLE_PATH) {
	process.env.PUPPETEER_EXECUTABLE_PATH = path.join(
		path.dirname(fileURLToPath(import.meta.url)), 'chrome-wrapper');
}

log('starting server…');
const base = await harness.startServer({ label: 'base', port: 7007, config: {} });
log('server up:', base.address);

const webstrateId = 'test-' + util.randomString();
const url = config.server_address + webstrateId + '/';
const browser = await puppeteer.launch();
const mkPage = async (name) => {
	const page = await browser.newPage();
	page.on('console', (msg) => log(`[${name} console]`, msg.type(), msg.text()));
	page.on('pageerror', (err) => log(`[${name} pageerror]`, err.message,
		(err.stack || '').split('\n').slice(0, 4).join(' | ')));
	await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
	return page;
};

const pageA = await mkPage('A');
log('pageA loaded');

// Dump the served HTML for the second client.
const probePage = await browser.newPage();
let servedHtml = '';
probePage.on('response', async (res) => {
	if (res.url().replace(/\?.*$/, '') === url && !servedHtml) {
		try { servedHtml = await res.text(); } catch (e) { servedHtml = `ERR ${e.message}`; }
	}
});
await probePage.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
await util.sleep(1);
log('served page bytes:', servedHtml.length,
	'has sidecar:', servedHtml.includes('__webstrates_sidecar'),
	'has __wid attr:', servedHtml.includes('__wid='),
	'first 200:', servedHtml.slice(0, 200).replace(/\n/g, '\\n'));
await probePage.close();
const pageB = await mkPage('B');
log('pageB loaded');

await util.sleep(1);
const insertRes = await pageA.evaluate(() => {
	const div = document.createElement('div');
	div.setAttribute('id', 'targetdiv');
	div.setAttribute('data-attr', 'v1');
	div.textContent = 'hello';
	document.body.appendChild(div);
	return document.getElementById('targetdiv') !== null;
});
log('pageA inserted div:', insertRes);
await util.sleep(1);

const attrRes = await pageA.evaluate(() => {
	document.body.setAttribute('data-body-attr', 'VTwEcJJQ');
	return document.body.getAttribute('data-body-attr');
});
log('pageA set body attr, immediate readback:', JSON.stringify(attrRes));
await util.sleep(1);
const attrA = await pageA.evaluate(() => document.body.getAttribute('data-body-attr'));
const attrB = await pageB.evaluate(() => document.body.getAttribute('data-body-attr'));
const versions2 = await Promise.all([
	pageA.evaluate(() => window.webstrate?.version),
	pageB.evaluate(() => window.webstrate?.version)
]);
log('attr after 1s — A:', JSON.stringify(attrA), 'B:', JSON.stringify(attrB),
	'versions A=' + versions2[0], 'B=' + versions2[1]);

// innerHTML replace (childList: remove all + add text).
const setRes = await pageA.evaluate(() => {
	document.body.innerHTML = 'Hello, world!';
	return document.body.innerHTML;
});
log('A set innerHTML:', JSON.stringify(setRes));
await util.sleep(1);
const htmlA = await pageA.evaluate(() => document.body.innerHTML);
const htmlB = await pageB.evaluate(() => document.body.innerHTML);
const versions3 = await Promise.all([
	pageA.evaluate(() => window.webstrate?.version),
	pageB.evaluate(() => window.webstrate?.version)
]);
log('innerHTML after 1s — A:', JSON.stringify(htmlA), 'B:', JSON.stringify(htmlB),
	'versions A=' + versions3[0], 'B=' + versions3[1]);

for (let i = 0; i < 12; i++) {
	await util.sleep(0.5);
	const onA = await pageA.evaluate(() => document.getElementById('targetdiv') !== null);
	const onB = await pageB.evaluate(() => {
		const div = document.getElementById('targetdiv');
		return div === null ? null : { text: div.textContent, attr: div.getAttribute('data-attr') };
	});
	const versions = await Promise.all([
		pageA.evaluate(() => window.webstrate?.version).catch(e => `ERR ${e.message}`),
		pageB.evaluate(() => window.webstrate?.version).catch(e => `ERR ${e.message}`)
	]);
	log(`t=${i * 0.5}s A: ${onA} B: ${JSON.stringify(onB)} versions A=${versions[0]} B=${versions[1]}`);
	if (onB === null) { log('>>> DIV LOST ON B'); break; }
}

log('done');
await browser.close().catch((e) => log('browser.close failed:', e.message));
await harness.stopAll();
process.exit(0);
