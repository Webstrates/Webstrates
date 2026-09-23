// Protected-mode repro: approved div with a capital-letter attribute.
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
const pageB = await mkPage('B');
log('pages loaded');

await pageA.evaluate(() =>
	document.documentElement.setAttribute('data-protected', 'all'));
const synced = await util.waitForFunction(pageB, () =>
	document.documentElement.getAttribute('data-protected') === 'all', 5);
log('data-protected synced to B:', synced);

await Promise.all([pageA.reload({ waitUntil: 'networkidle2' }),
	pageB.reload({ waitUntil: 'networkidle2' })]);
await pageA.bringToFront();
await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 5);
await pageB.bringToFront();
await util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded, 5);
log('both reloaded in protected mode');

await pageA.evaluate(() => {
	const div = document.createElement('div', { approved: true });
	div.setAttribute('myAttr', 'value');
	document.body.appendChild(div);
	return true;
});
log('A inserted approved div with myAttr');

for (let i = 0; i < 10; i++) {
	await util.sleep(0.5);
	const state = await Promise.all([
		pageA.evaluate(() => ({
			html: document.body.innerHTML,
			attrs: document.body.firstElementChild
				? document.body.firstElementChild.getAttribute('myAttr') : null
		})).catch(e => `ERR ${e.message}`),
		pageB.evaluate(() => ({
			html: document.body.innerHTML,
			attrs: document.body.firstElementChild
				? document.body.firstElementChild.getAttribute('myAttr') : null
		})).catch(e => `ERR ${e.message}`)
	]);
	log(`t=${i * 0.5}s A:`, JSON.stringify(state[0]), 'B:', JSON.stringify(state[1]));
	if (state[1] && state[1].attrs === 'value') break;
}

log('done');
await browser.close().catch((e) => log('browser.close failed:', e.message));
await harness.stopAll();
process.exit(0);
