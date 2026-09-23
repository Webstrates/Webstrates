// Boot debug: start the harness base server, load a fresh webstrate in
// chrome, and dump every console line + the client's state after 3 seconds.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import config from '../config.js';
import util from '../util.js';
import harness from './server-harness.mjs';

const t0 = Date.now();
const log = (...args) => fs.writeSync(1, `+${Date.now() - t0}ms ${args.join(' ')}\n`);
const heartbeat = setInterval(() => log('heartbeat'), 2000);

if (process.getuid && process.getuid() === 0 && !process.env.PUPPETEER_EXECUTABLE_PATH) {
	process.env.PUPPETEER_EXECUTABLE_PATH = path.join(
		path.dirname(fileURLToPath(import.meta.url)), 'chrome-wrapper');
}

log('starting server…');
const base = await harness.startServer({ label: 'base', port: 7007, config: {} });
log('server up:', base.address);
log('launching chrome…');

const webstrateId = 'test-' + util.randomString();
const url = config.server_address + webstrateId + '/';
const browser = await puppeteer.launch();
log('chrome up, goto', url);
const page = await browser.newPage();
page.on('console', (msg) => log('[console]', msg.type(), msg.text()));
page.on('pageerror', (err) => log('[pageerror]', err.message,
	(err.stack || '').split('\n').slice(0, 5).join('\n')));
page.on('requestfailed', (req) => log('[requestfailed]', req.url(),
	req.failure()?.errorText));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).then(
	() => log('goto resolved (domcontentloaded)'),
	(err) => log('goto REJECTED:', err.message));
await util.sleep(3);
log('slept, evaluating state…');
try {
	const state = await page.evaluate(() => ({
		hasWebstrate: !!window.webstrate,
		loaded: window.webstrate?.loaded,
		hasSidecar: !!document.getElementById('__webstrates_sidecar'),
		title: document.title,
		htmlSnippet: document.documentElement.outerHTML.slice(0, 400)
	}));
	log('[state]', JSON.stringify(state, null, 2));
} catch (err) {
	log('[state evaluate failed]', err.message);
}
log('done — closing');
await browser.close().catch((err) => log('browser.close failed:', err.message));
log('browser closed');
await harness.stopAll().catch((err) => log('stopAllServers failed:', err.message));
log('servers stopped');
process.exit(0);
