// Stress repro: 6 pages typing into the same contenteditable body.
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
const url = base.address + webstrateId + '/';
const browserA = await puppeteer.launch();
const browserB = await puppeteer.launch();
const pages = await Promise.all([browserA.newPage(), browserA.newPage(),
	browserA.newPage(), browserB.newPage(), browserB.newPage(), browserB.newPage()]);
for (const page of pages) {
	page.on('pageerror', (err) => log('[pageerror]', err.message,
		(err.stack || '').split('\n').slice(0, 3).join(' | ')));
	await page.evaluateOnNewDocument(() => {
		window.__strDebugOn = true;
	});
	await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
}
await Promise.all(pages.map((page) =>
	util.waitForFunction(page, () => window.webstrate
		&& window.webstrate.loaded && document.body)));
log('6 pages loaded');

await pages[0].evaluate(() => document.body.setAttribute('contenteditable', ''));
await Promise.all(pages.map((page) =>
	util.waitForFunction(page, () => document.body.attributes.length > 0)));
log('contenteditable synced');

const N = 1000;
for (let i = 0; i < N; ++i) {
	(async () => {
		await util.sleep(Math.random() / 10);
		const page = pages[Math.random() * pages.length | 0];
		await page.type('body', util.randomString(1));
	})();
}
log(`queued ${N} type actions`);

let match = false;
let now = Date.now() / 1000;
while (!match && (Date.now() / 1000) - now < 20) {
	const innerHTMLs = await Promise.all(pages.map((page) =>
		page.evaluate(() => document.body.innerHTML)));
	match = innerHTMLs[0].length === N && util.allEquals(...innerHTMLs);
}
log('converged:', match);

const final = await Promise.all(pages.map((page) => page.evaluate(() => ({
	html: document.body.innerHTML,
	v: window.webstrate.version
}))));
final.forEach((f, i) => log(`page${i} len=${f.html.length} v=${f.v}`));
const sortedLens = final.map((f) => f.html.length).sort((a, b) => a - b);
log('len spread:', sortedLens.join(','), 'expected', N);
// First divergence between page0 and page1.
const [a, b] = [final[0].html, final[1].html];
let d = 0;
while (d < Math.min(a.length, b.length) && a[d] === b[d]) d++;
log(`first divergence p0/p1 at ${d}/${a.length}:`,
	JSON.stringify(a.slice(Math.max(0, d - 8), d + 8)), 'vs',
	JSON.stringify(b.slice(Math.max(0, d - 8), d + 8)));

// Pairwise divergence map.
for (let i = 0; i < final.length; i++) {
	for (let j = i + 1; j < final.length; j++) {
		if (final[i].html !== final[j].html) log(`DIFFER p${i} vs p${j}`);
	}
}

// Ground truth: a fresh page load renders the server's current state.
const serverPage = await browserA.newPage();
await serverPage.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await util.waitForFunction(serverPage, () => window.webstrate
	&& window.webstrate.loaded && document.body);
const serverHtml = await serverPage.evaluate(() => document.body.innerHTML);
log('server len:', serverHtml.length);
final.forEach((f, i) => log(`p${i} matchesServer:`, f.html === serverHtml));
let sd2 = 0;
while (sd2 < Math.min(serverHtml.length, final[0].html.length)
	&& serverHtml[sd2] === final[0].html[sd2]) sd2++;
log(`first divergence server/p0 at ${sd2}/${serverHtml.length}:`,
	JSON.stringify(serverHtml.slice(Math.max(0, sd2 - 8), sd2 + 8)), 'vs',
	JSON.stringify(final[0].html.slice(Math.max(0, sd2 - 8), sd2 + 8)));

await serverPage.close();
// Dump ALL string-log debug events + final state for offline reconstruction.
const dumpDir = '/tmp/stress-forensic';
fs.rmSync(dumpDir, { recursive: true, force: true });
fs.mkdirSync(dumpDir, { recursive: true });
for (let i = 0; i < pages.length; i++) {
	const evs = await pages[i].evaluate(() => window.__strDebug || []);
	fs.writeFileSync(`${dumpDir}/p${i}-events.json`, JSON.stringify(evs));
	fs.writeFileSync(`${dumpDir}/p${i}-final.html`,
		await pages[i].evaluate(() => document.body.innerHTML));
}
fs.writeFileSync(`${dumpDir}/server-final.html`, serverHtml);
// Copy the SQLite history before the harness stop removes the data dir.
for (const suffix of ['', '-wal', '-shm']) {
	try {
		fs.cpSync(`${base.dataDir}/${webstrateId}.history${suffix}`,
			`${dumpDir}/doc.history${suffix}`);
	} catch (e) { /* optional sidecar */ }
}
fs.writeFileSync(`${dumpDir}/meta.json`, JSON.stringify({
	webstrateId, n: N
}, null, 2));
log('forensic dumps written to', dumpDir);

log('done');
// Puppeteer/browser handles can keep the process alive after the run ends,
// hanging batch loops that wait on this script. Exit hard.
process.exit(0);
