// Instruction to ESLint that 'describe' and 'it' actually has been defined.
/* global describe it before after */
'use strict';
import {assert} from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DocumentStore reads global.config.sqliteDataDir (set below to a temp
// dir) and global.APP_PATH — which must stay the real application root:
// PaintNormalizer requires sibling helpers (mirrorDiff) through it, while
// DocumentStore itself only falls back to APP_PATH for the default data
// directory (unused while sqliteDataDir is configured).
const SQLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'document-store-test-'));
global.config = { sqliteDataDir: SQLITE_DIR };
global.APP_PATH = new URL('../../', import.meta.url).pathname;

const store = (await import('../../helpers/DocumentStore.js')).default;
const paintNormalizer = (await import('../../helpers/PaintNormalizer.js')).default;
const NODE_ELEMENT = 1, NODE_TEXT = 3;

// JsonML view of a mirror — the observation language these tests were
// written in. The store itself no longer serializes JsonML (the painted
// wire and the struct/state rows replaced it): this local walker performs
// the same escaped-canonical conversion the old handle.toJsonML did.
const NODE_COMMENT = 8;
const mirrorToJsonML = (nodes) => {
	const escapeValue = (v) => v && v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	const escapeName = (v) => v && v.replace(/\./g, '&dot;');
	const convert = (eid) => {
		const node = nodes.get(eid);
		if (!node) return null;
		if (node.t === NODE_TEXT) {
			const content = node.attrs[0];
			return content ? content.v : '';
		}
		if (node.t === NODE_COMMENT) {
			const content = node.attrs[0];
			return ['!', content ? content.v : ''];
		}
		const attrs = {};
		for (const attr of node.attrs) {
			if (attr.n === null) continue;
			attrs[escapeName(attr.n)] = escapeValue(attr.v);
		}
		const jml = [node.n, attrs];
		for (const child of node.kids) {
			const converted = convert(child);
			if (converted !== null) jml.push(converted);
		}
		return jml;
	};
	const root = nodes.get(0);
	if (!root || root.kids.length === 0) return [];
	return convert(root.kids[0]) || [];
};

const wid = () => `doc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// A canonical empty shell — the shape the browser client bootstraps.
const SHELL_HTML = '<html><head></head><body></body></html>';

// Seed a mirror from a JsonML tree through wire ops (sa/aa) — the way the
// unstable, parser-impossible documents of the normalizer corpus actually
// arise in production: a client commits structure the HTML parser could
// never produce. Canonical documents seed through fromHtml instead (which
// always yields the browser-canonical mirror, because parse5 runs first).
const jmlToOps = (jml) => {
	let nextId = 1;
	const ops = [];
	const kidCount = new Map([[0, 0]]);
	const nextIndex = (parent) => {
		const i = kidCount.get(parent) || 0;
		kidCount.set(parent, i + 1);
		return i;
	};
	const walk = (node, parent) => {
		if (typeof node === 'string') {
			const e = nextId++;
			ops.push({ k: 'sa', p: parent, i: nextIndex(parent), e, t: NODE_TEXT, n: null });
			ops.push({ k: 'aa', e, n: null, v: node });
			return;
		}
		if (node[0] === '!') {
			const e = nextId++;
			ops.push({ k: 'sa', p: parent, i: nextIndex(parent), e, t: NODE_COMMENT, n: null });
			ops.push({ k: 'aa', e, n: null, v: node[1] });
			return;
		}
		const e = nextId++;
		ops.push({ k: 'sa', p: parent, i: nextIndex(parent), e, t: NODE_ELEMENT, n: node[0] });
		const attrs = node[1] && !Array.isArray(node[1]) ? node[1] : null;
		let attrPos = 0;
		for (const [name, value] of Object.entries(attrs || {})) {
			ops.push({ k: 'aa', e, i: attrPos++, n: name, v: value });
		}
		const kids = attrs ? node.slice(2) : node.slice(1);
		for (const kid of kids) walk(kid, e);
	};
	walk(jml, 0);
	return ops;
};
const seedJml = (handle, jml) => handle.applyCommit({ base: handle.revision,
	ops: jmlToOps(jml), userId: 'test-user', source: 'test' });

describe('DocumentStore (SQLite document engine)', function() {
	this.timeout(20000);

	describe('empty document', function() {
		it('revision 0 for a fresh webstrate', function() {
			const h = store.getHandle(wid());
			assert.equal(h.revision, 0);
			assert.deepEqual(mirrorToJsonML(h.nodes), []);
			store.releaseHandle(h.id);
		});

		it('exists() is false for a fresh webstrate, true after a commit', function() {
			const id = wid();
			assert.isFalse(store.exists(id));
			const h = store.getHandle(id);
			h.fromHtml(SHELL_HTML, 'test-user', 'test');
			assert.isTrue(store.exists(id));
			store.releaseHandle(id);
		});
	});

	describe('bootstrap from HTML (the ingest path)', function() {
		// The REST ingest path: zip import and remote prototypes hand raw
		// HTML to fromHtml, which parses it with parse5 and commits the
		// browser-canonical mirror. This source round-trips to the same
		// JsonML the old snapshots carried (entities decode on ingest;
		// mirrorToJsonML re-escapes attributes on the way out).
		const source = '<html lang="en" data-protected="all">'
			+ '<head><title>Hello &amp; "world"</title></head>'
			+ '<body class="wide">'
			+ '<p id="p1">Some <b>bold</b> text</p>'
			+ '<!-- a comment -->'
			+ '<script type="text/javascript">console.log(1);</script>'
			+ '</body></html>';
		const jml = ['html', {lang: 'en', 'data-protected': 'all'},
			['head', {}, ['title', {}, 'Hello & "world"']],
			['body', {class: 'wide'},
				['p', {id: 'p1'}, 'Some ', ['b', {}, 'bold'], ' text'],
				['!', ' a comment '],
				['script', {type: 'text/javascript'}, 'console.log(1);']
			]
		];
		let h;
		before(function() {
			h = store.getHandle(wid());
			h.fromHtml(source, 'test-user', 'test');
		});
		after(function() {
			store.releaseHandle(h.id);
		});

		it('ingests to the canonical JsonML mirror', function() {
			assert.deepEqual(mirrorToJsonML(h.nodes), jml);
		});

		it('stores sa/aa ops in the log', function() {
			const commits = h.allCommits();
			assert.equal(commits.length, 1);
			const ops = commits[0].ops;
			// One sa per node: html, head, title, text, body, p, text, b, text,
			// text, comment, script, script-text = 13 nodes.
			assert.equal(ops.filter((op) => op.k === 'sa').length, 13);
			assert.isAbove(ops.filter((op) => op.k === 'aa').length, 0);
		});

		it('allocates ids above the minted range', function() {
			const block = h.allocIds(10);
			// The block must not overlap any id minted during the bootstrap.
			// (Only eids are minted now — attribute positions are per-element
			// locals and never consume ids.)
			const minted = h.allCommits()[0].ops.reduce((max, op) => Math.max(
				max, op.e || 0), 0);
			assert.isAbove(block.start, minted);
			assert.equal(block.end - block.start + 1, 10);
		});

		it('renders the v2 painted wire: temp head, <head_>, native prefixes', function() {
			const html = h.toHTML();
			assert.include(html, '<!doctype html>');
			// Temporary real <head> (empty without the injected bundle).
			assert.include(html, '<head></head>');
			// The mirror head rides as <head_>, marked for adoption.
			assert.include(html, '<head_ _=');
			assert.include(html, 'data-webstrates-head="1"');
			assert.include(html, '</head_>');
			// Region boundary before body.
			assert.include(html, '<!--wsh-->');
			// The body's modeled attrs come first (mirror order), the
			// transport _ rides last: unquoted, so nothing after it needs
			// renumbering when adoption strips it.
			assert.include(html, '<body class="wide" _=');
			// Text and comment nodes ride natively, identity-prefixed with
			// the bare eid (their single "attribute", the content, needs no
			// index — position 0 is the node's only entry).
			assert.match(html, />\d+_Some <b _=/);          // body text
			assert.match(html, /<!--\d+_ a comment -->/);    // comment
			assert.match(html, />\d+_Hello &amp; "world"</); // RCDATA title
			// Scripts stay neutered with the real type alongside.
			assert.include(html, 'type="webstrates/x"');
			assert.include(html, 'data-webstrates-type="text/javascript"');
			assert.include(html, 'console.log(1);'); // raw script text
			assert.notInclude(html, '&amp;console');
			// No v1 transport artifacts.
			assert.notInclude(html, '<w ');
			assert.notInclude(html, '__webstrates_sidecar');
			// The html element carries a bare, unquoted, TRAILING _=<eid>:
			// modeled attributes come first (mirror order = DOM order), so
			// stripping the transport names renumbers nothing.
			assert.match(html, /^<!doctype html><html lang="en" data-protected="all" _=1>/);
		});

		it('renders the temp head with the sync bundle and preloads', function() {
			const html = h.toHTML(h.nodes, {
				bundle: '<script id="__webstrates_client" src="/webstrates.js#42" data-d="d0"></script>',
				preloads: ['<link rel="preload" as="script" href="/x.js">']
			});
			// Bundle first, preloads after — both stripped at adoption.
			assert.include(html, '<head><script id="__webstrates_client"'
				+ ' src="/webstrates.js#42" data-d="d0"></script>'
				+ '<link rel="preload" as="script" href="/x.js"></head>');
		});

		it('paintDigest is a stable 64-hex content digest of the mirror', function() {
			const d = h.paintDigest();
			assert.match(d, /^[0-9a-f]{64}$/);
			assert.equal(h.paintDigest(), d); // same mirror, same digest
			// A content change must change the digest: rewrite the first
			// text node's content (find its eid in the bootstrap ops).
			const textAa = h.allCommits()[0].ops.find((op) => op.k === 'aa'
				&& typeof op.v === 'string' && op.v === 'Some ');
			assert.isOk(textAa, 'bootstrap logged the text content write');
			h.applyCommit({ base: h.revision,
				ops: [{ k: 'aa', e: textAa.e, n: null, v: 'Changed ' }],
				userId: 'test', source: 'test' });
			assert.notEqual(h.paintDigest(), d);
		});
	});

	describe('PaintNormalizer (parse5 stability check)', function() {
		// The injected committer applies ops through the store only —
		// the production path (DocumentManager) broadcasts over MongoDB,
		// which must stay out of unit tests.
		const stubCommit = (handle, ops) => handle.applyCommit({
			base: handle.revision, ops, userId: 'server', source: 'test-normalize' });

		it('a stable document produces no ops and sets the stable flag', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['p', {}, 'plain ', ['b', {}, 'text']]]]);
			const before = h.revision;
			const { ops } = paintNormalizer.diffOps(h);
			assert.equal(ops.length, 0, JSON.stringify(ops));
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			assert.equal(h.revision, before); // no commit happened
			assert.equal(h.getMeta('paintStableV'), h.revision);
			store.releaseHandle(h.id);
		});

		it('table>tr normalizes to tbody, preserving eids and minting the tbody', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['table', {id: 't'},
					['tr', {}, ['td', {}, 'cell']]]]]);
			// The td's eid must survive the move into the synthesized tbody.
			const tdSa = h.allCommits()[0].ops.find((op) => op.k === 'sa'
				&& op.n === 'td');
			const { ops } = paintNormalizer.diffOps(h);
			assert.isAbove(ops.length, 0); // tbody synthesis + moves
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			// Converged: a second check finds nothing.
			assert.equal(paintNormalizer.diffOps(h).ops.length, 0);
			const jml = JSON.stringify(mirrorToJsonML(h.nodes));
			assert.include(jml, '"tbody"');
			assert.include(jml, '"td"');
			assert.include(jml, 'cell');
			// The extracted, normalized mirror still knows the td under its
			// original eid, and the tbody's minted id is above it.
			const mirror = paintNormalizer.extractMirror(h, h.toHTML());
			assert.equal(mirror.get(tdSa.e).n, 'td');
			const maxEid = Math.max(...[...mirror.keys()]);
			assert.isAbove(mirror.get(maxEid).n === 'tbody' ? maxEid : 0, tdSa.e);
			// Idempotent: re-running on the same revision commits nothing.
			const rev = h.revision;
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			assert.equal(h.revision, rev);
			store.releaseHandle(h.id);
		});

		it('adjacent text nodes merge into one (one commit, converges)', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['p', {}, 'a', 'b']]]); // two adjacent texts
			assert.isAbove(paintNormalizer.diffOps(h).ops.length, 0);
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			assert.equal(paintNormalizer.diffOps(h).ops.length, 0);
			const jml = JSON.stringify(mirrorToJsonML(h.nodes));
			assert.include(jml, '"ab"'); // merged into one text node
			store.releaseHandle(h.id);
		});

		it('template-with-text is natively stable (no v1 fetchStructure case)', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['template', {id: 'tpl'}, 'tpl ', ['i', {}, 'inner'], ' text']]]);
			const { ops } = paintNormalizer.diffOps(h);
			assert.equal(ops.length, 0, JSON.stringify(ops));
			store.releaseHandle(h.id);
		});

		it('a comment carrying --> normalizes (content truncates like the browser)', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['p', {}, 'x'], ['!', 'a-->b'], ['p', {}, 'y']]]);
			// The wire carries the comment verbatim; the parser terminates
			// it at --> — exactly what a browser would do.
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			assert.equal(paintNormalizer.diffOps(h).ops.length, 0);
			const jml = JSON.stringify(mirrorToJsonML(h.nodes));
			assert.notInclude(jml, 'a-->b'); // the breakout is gone
			assert.include(jml, '"x"');    // the surrounding structure holds
			assert.include(jml, '"y"');
			store.releaseHandle(h.id);
		});

		it('text inside a table is fostered before it (browser-canonical move)', function() {
			const h = store.getHandle(wid());
			seedJml(h, ['html', {}, ['head', {}],
				['body', {}, ['table', {}, 'fostered',
					['tbody', {}, ['tr', {}, ['td', {}, 'c']]]]]]);
			const { ops } = paintNormalizer.diffOps(h);
			assert.isAbove(ops.length, 0); // the text must move out
			paintNormalizer.ensureStable(h, { commit: stubCommit });
			assert.equal(paintNormalizer.diffOps(h).ops.length, 0);
			const jml = JSON.stringify(mirrorToJsonML(h.nodes));
			// The fostered text ends up a body child BEFORE the table.
			assert.isBelow(jml.indexOf('"fostered"'), jml.indexOf('"table"'));
			store.releaseHandle(h.id);
		});
	});

	describe('commits, transforms and idempotency', function() {
		let h;
		before(function() {
			h = store.getHandle(wid());
			h.fromHtml('<html><head></head><body><p>hi</p></body></html>', 'u1', 's1');
		});
		after(function() {
			store.releaseHandle(h.id);
		});

		const eidOf = (name) => h.allCommits()[0].ops
			.find((op) => op.k === 'sa' && op.n === name).e;
		const pAttrs = () => mirrorToJsonML(h.nodes)[3][2][1]; // body → p → attrs

		it('applies a commit and bumps the revision by ops+1', function() {
			const v0 = h.revision;
			const res = h.applyCommit({base: v0, ops: [
				{k: 'aa', e: eidOf('p'), i: 0, n: 'class', v: 'greeting'}
			], userId: 'u2', source: 's2'});
			assert.equal(res.v, v0 + 2); // 1 op + 1 commit row
			assert.equal(h.revision, res.v);
			assert.deepEqual(res.ops.map((op) => op.k), ['aa']);
			assert.include(pAttrs(), {class: 'greeting'});
		});

		it('updates an existing name in place (single aa, position kept)', function() {
			const v0 = h.revision;
			const res = h.applyCommit({base: v0, ops: [
				{k: 'aa', e: eidOf('p'), i: 0, n: 'class', v: 'renamed'}
			], userId: 'u3', source: 's3'});
			// setAttribute semantics: the value changes at the SAME position
			// — one effective op, the history row is an 'au' (old value kept).
			assert.deepEqual(res.ops.map((op) => op.k), ['aa']);
			assert.include(pAttrs(), {class: 'renamed'});
			// The position never moved: the mirror's ordered list is what
			// position-addressed ops resolve against.
			const pEid = eidOf('p');
			assert.equal(h.nodes.get(pEid).attrs[0].n, 'class');
			assert.equal(h.nodes.get(pEid).attrs[0].v, 'renamed');
		});

		it('is idempotent on replayed ops', function() {
			const res = h.applyCommit({base: h.revision, ops: [
				{k: 'aa', e: eidOf('p'), i: 0, n: 'class', v: 'renamed'}
			], userId: 'u3', source: 's3'});
			assert.lengthOf(res.ops, 0);
			assert.equal(h.revision, res.v);
			assert.include(pAttrs(), {class: 'renamed'});
		});

		it('transforms a concurrent insert at the same index', function() {
			const base = h.revision;
			const bodyEid = eidOf('body');
			// Client A commits first at index 1 (after the p).
			h.applyCommit({base, ops: [
				{k: 'sa', p: bodyEid, i: 1, e: 2001, t: NODE_ELEMENT, n: 'span'}
			], userId: 'a', source: 'sa'});
			// Client B's op based on the same (now stale) revision.
			const b = h.applyCommit({base, ops: [
				{k: 'sa', p: bodyEid, i: 1, e: 2002, t: NODE_ELEMENT, n: 'div'}
			], userId: 'b', source: 'sb'});
			assert.isTrue(b.xformed);
			// Committed-first wins the earlier slot.
			const kids = h.nodes.get(bodyEid).kids;
			assert.isAbove(kids.indexOf(2002), kids.indexOf(2001));
		});

		it('transforms overlapping text deletes', function() {
			const bodyEid = eidOf('body');
			h.applyCommit({base: h.revision, ops: [
				{k: 'sa', p: bodyEid, i: h.nodes.get(bodyEid).kids.length, e: 3001,
					t: NODE_TEXT, n: null},
				{k: 'aa', e: 3001, n: null, v: 'abcdefgh'}
			], userId: 'u', source: 's'});

			// Two concurrent deletes based on 'abcdefgh': 'cd' and 'cdef'.
			// The text ops carry no position — the eid alone addresses the
			// node's single content entry.
			const base = h.revision;
			const first = h.applyCommit({base, ops: [
				{k: 'sd', e: 3001, q: 2, v: 'cd'}
			], userId: 'a', source: 'sa'});
			assert.lengthOf(first.ops, 1);
			const second = h.applyCommit({base, ops: [
				{k: 'sd', e: 3001, q: 2, v: 'cdef'}
			], userId: 'b', source: 'sb'});
			// The covered range shrank to 'ef'.
			const sd = second.ops.filter((op) => op.k === 'sd');
			assert.lengthOf(sd, 1);
			assert.equal(sd[0].v, 'ef');
			const text = mirrorToJsonML(h.nodes)[3].slice(2).find((x) => typeof x === 'string');
			assert.equal(text, 'abgh');
		});

		it('resolves a position-form sr to the child holding the slot', function() {
			const bodyEid = eidOf('body');
			// Three text children appended to whatever body already holds.
			for (const e of [3501, 3502, 3503]) {
				h.applyCommit({base: h.revision, ops: [
					{k: 'sa', p: bodyEid, i: h.nodes.get(bodyEid).kids.length,
						e, t: NODE_TEXT, n: null},
					{k: 'aa', e, n: null, v: `t${e}`}
				], userId: 'u', source: 's'});
			}
			const before = h.nodes.get(bodyEid).kids.slice();
			assert.deepEqual(before.slice(-3), [3501, 3502, 3503]);
			// No e: the slot alone names the victim (the lost-id fallback).
			const res = h.applyCommit({base: h.revision, ops: [
				{k: 'sr', p: bodyEid, i: 1}
			], userId: 'u', source: 's'});
			// The effective op is eid-addressed like every other removal, with
			// the resolved index — so the inverse (a forward sa) is exact and
			// the history can walk the removal back.
			assert.include(res.ops.find((op) => op.k === 'sr') || {},
				{k: 'sr', p: bodyEid, e: before[1], i: 1});
			assert.deepEqual(h.nodes.get(bodyEid).kids,
				[before[0], ...before.slice(2)]);
		});

		it('clamps an out-of-range position-form sr to the last child', function() {
			const bodyEid = eidOf('body');
			const before = h.nodes.get(bodyEid).kids.slice();
			const res = h.applyCommit({base: h.revision, ops: [
				{k: 'sr', p: bodyEid, i: 99}
			], userId: 'u', source: 's'});
			assert.equal(res.ops.find((op) => op.k === 'sr').e,
				before[before.length - 1]);
			assert.deepEqual(h.nodes.get(bodyEid).kids,
				before.slice(0, before.length - 1));
		});

		it('warn-skips a position-form sr on an empty parent', function() {
			const bodyEid = eidOf('body');
			// Empty the parent first (eid form).
			for (const kid of h.nodes.get(bodyEid).kids.slice()) {
				h.applyCommit({base: h.revision, ops: [
					{k: 'sr', p: bodyEid, e: kid}
				], userId: 'u', source: 's'});
			}
			const rev = h.revision;
			const res = h.applyCommit({base: rev, ops: [
				{k: 'sr', p: bodyEid, i: 0}
			], userId: 'u', source: 's'});
			assert.lengthOf(res.ops, 0);
			// Nothing applied — but the commit row still bumps the revision
			// by one (every commit records, even a fully void one).
			assert.equal(h.revision, rev + 1);
		});

		it('shifts a position-form sr under a concurrent insert, voids on the same slot', function() {
			const hh = store.getHandle(wid());
			hh.fromHtml(SHELL_HTML, 'u', 's');
			const bodyEid = hh.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;
			hh.applyCommit({base: hh.revision, ops: [
				{k: 'sa', p: bodyEid, i: 0, e: 4101, t: NODE_TEXT, n: null},
				{k: 'sa', p: bodyEid, i: 1, e: 4102, t: NODE_TEXT, n: null}
			], userId: 'u', source: 's'});
			const base = hh.revision;
			// A inserts at slot 0, based on the same revision.
			hh.applyCommit({base, ops: [
				{k: 'sa', p: bodyEid, i: 0, e: 4103, t: NODE_TEXT, n: null}
			], userId: 'a', source: 'sa'});
			// B removes slot 1 positionally: 4102 at the base state, which A's
			// insert pushed to slot 2.
			const b = hh.applyCommit({base, ops: [
				{k: 'sr', p: bodyEid, i: 1}
			], userId: 'b', source: 'sb'});
			assert.isTrue(b.xformed);
			assert.include(b.ops.find((op) => op.k === 'sr') || {},
				{k: 'sr', p: bodyEid, e: 4102, i: 2});
			assert.deepEqual(hh.nodes.get(bodyEid).kids, [4103, 4101]);
			// C targets the same slot B concurrently removed: the op voids
			// (no orphan removal of the node that slid into the slot).
			const c = hh.applyCommit({base, ops: [
				{k: 'sr', p: bodyEid, i: 1}
			], userId: 'c', source: 'sc'});
			assert.isFalse(c.ops.some((op) => op.k === 'sr'));
			assert.deepEqual(hh.nodes.get(bodyEid).kids, [4103, 4101]);
			store.releaseHandle(hh.id);
		});

		it('rejects a base ahead of head and invalid ops', function() {
			assert.throws(() => h.applyCommit({base: h.revision + 5, ops: [],
				userId: 'x', source: 'x'}));
			assert.throws(() => h.applyCommit({base: h.revision, ops: [{k: 'zz'}],
				userId: 'x', source: 'x'}));
		});

		it('moves a subtree with sr+sa, preserving all descendants', function() {
			// Build: body > p > span > "text", plus a second container div.
			const bodyEid = eidOf('body');
			h.applyCommit({base: h.revision, ops: [
				{k: 'sa', p: bodyEid, i: h.nodes.get(bodyEid).kids.length, e: 5001,
					t: NODE_ELEMENT, n: 'p'},
				{k: 'aa', e: 5001, i: 0, n: 'data-x', v: '1'},
				{k: 'sa', p: 5001, i: 0, e: 5003, t: NODE_ELEMENT, n: 'span'},
				{k: 'sa', p: 5003, i: 0, e: 5005, t: NODE_TEXT, n: null},
				{k: 'aa', e: 5005, n: null, v: 'text'},
				{k: 'sa', p: bodyEid, i: h.nodes.get(bodyEid).kids.length, e: 5007,
					t: NODE_ELEMENT, n: 'div'}
			], userId: 'u', source: 's'});
			const before = mirrorToJsonML(h.nodes);

			// Move the whole p under the div: sr + sa, nothing else.
			const res = h.applyCommit({base: h.revision, ops: [
				{k: 'sr', p: bodyEid, e: 5001},
				{k: 'sa', p: 5007, i: 0, e: 5001, t: NODE_ELEMENT, n: 'p'}
			], userId: 'u', source: 's'});
			assert.deepEqual(res.ops.map((op) => op.k), ['sr', 'sa']);
			const moved = mirrorToJsonML(h.nodes);
			// Descendants (attr, span, text) all survived untouched: the moved
			// p sits under the div with its span and text intact.
			const container = moved[3].slice(2).find((x) => Array.isArray(x)
				&& x[0] === 'div' && Array.isArray(x[2]) && x[2][0] === 'p');
			assert.isDefined(container);
			assert.equal(container[2][2][2], 'text');
			assert.equal(container[2][1]['data-x'], '1');

			// Restart consistency: reload everything from SQL — the re-attached
			// subtree rows must have been rewritten correctly.
			h.nodes = store.emptyMirror();
			h._load();
			assert.deepEqual(mirrorToJsonML(h.nodes), moved);

			// And the move undoes to a move: reconstruct the version before it.
			h.tag('before-move', res.v - 3); // res.v-3 = the build commit's opid
			assert.deepEqual(mirrorToJsonML(h.snapshotAt(res.v - 3)), before);
		});

		it('emits synthetic re-attach ops for cross-commit moves only', function() {
			// Self-contained document: body > p(span>"text", data-x) + div.
			const id = wid();
			const hh = store.getHandle(id);
			hh.fromHtml(SHELL_HTML, 'u', 's');
			const bodyEid = hh.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;
			hh.applyCommit({base: hh.revision, ops: [
				{k: 'sa', p: bodyEid, i: 0, e: 5001, t: NODE_ELEMENT, n: 'p'},
				{k: 'aa', e: 5001, i: 0, n: 'data-x', v: '1'},
				{k: 'sa', p: 5001, i: 0, e: 5003, t: NODE_ELEMENT, n: 'span'},
				{k: 'sa', p: 5003, i: 0, e: 5005, t: NODE_TEXT, n: null},
				{k: 'aa', e: 5005, n: null, v: 'text'},
				{k: 'sa', p: bodyEid, i: 1, e: 5007, t: NODE_ELEMENT, n: 'div'}
			], userId: 'u', source: 's'});

			// Cross-commit move: detach in one commit...
			const vDetach = hh.applyCommit({base: hh.revision, ops: [
				{k: 'sr', p: bodyEid, e: 5001}
			], userId: 'u', source: 's'}).v;
			assert.isUndefined(mirrorToJsonML(hh.nodes)[3].slice(2).find((x) =>
				Array.isArray(x) && x[0] === 'p'));

			// ...re-attach in a LATER commit: the broadcast must carry the
			// whole subtree as synthetic ops, so clients that processed the
			// detach can rebuild it (marked z:true, sharing the root sa's
			// opid — never persisted).
			const res = hh.applyCommit({base: vDetach, ops: [
				{k: 'sa', p: 5007, i: 0, e: 5001, t: NODE_ELEMENT, n: 'p'}
			], userId: 'u', source: 's'});
			const kinds = res.ops.map((op) => op.k).join(',');
			assert.equal(kinds, 'sa,aa,sa,sa,aa',
				`expected root sa + synthetic subtree ops, got ${kinds}`);
			const synthetics = res.ops.slice(1);
			assert.isTrue(synthetics.every((op) => op.z === true));
			assert.isTrue(synthetics.every((op) => op.opid === res.ops[0].opid));
			const saSyn = synthetics.filter((op) => op.k === 'sa');
			assert.sameDeepMembers(saSyn.map((op) => [op.e, op.n]),
				[[5003, 'span'], [5005, null]]);
			const aaSyn = synthetics.filter((op) => op.k === 'aa');
			assert.sameDeepMembers(aaSyn.map((op) => [op.e, op.n, op.v]),
				[[5001, 'data-x', '1'], [5005, null, 'text']]);
			const moved = mirrorToJsonML(hh.nodes);
			const container = moved[3].slice(2).find((x) => Array.isArray(x)
				&& x[0] === 'div' && Array.isArray(x[2]) && x[2][0] === 'p');
			assert.equal(container[2][2][2], 'text');

			// And the synthetic ops are NOT persisted: undoing to the detach
			// version still reconstructs the pre-move state, and the opid of
			// the re-attach commit is exactly detach + 1 + 1 (root sa +
			// commit row — the synthetics consumed no opids).
			assert.equal(res.v, vDetach + 2);
			assert.isUndefined(mirrorToJsonML(hh.snapshotAt(vDetach))[3].slice(2)
				.find((x) => Array.isArray(x) && x[0] === 'div'
					&& Array.isArray(x[2]) && x[2][0] === 'p'));

			// Applying the whole op stream from scratch rebuilds the move —
			// the getOps resync path a late subscriber takes. Clearing the
			// move stash before the final commit's ops simulates a CLIENT
			// (clients hold no stash: for them the sa creates an empty node
			// and the synthetic ops build the subtree).
			const replay = store.emptyMirror();
			const ctx = { warn: { count: 0 }, detached: new Map() };
			const entries = hh.allCommits();
			for (let i = 0; i < entries.length; i++) {
				if (i === entries.length - 1) ctx.detached.clear();
				for (const op of entries[i].ops) {
					store.applyOpToMirror(replay, op, ctx);
				}
			}
			assert.deepEqual(mirrorToJsonML(replay), moved);

			// A cold start must rebuild the same log — the synthetic ops are
			// re-derived from the history simulation, not persisted. Drop the
			// in-memory log and ask again.
			hh.log = [];
			hh.logFirstV = null;
			const cold = hh.allCommits().find((entry) => entry.v === res.v);
			assert.equal(cold.ops.map((op) => op.k).join(','), 'sa,aa,sa,sa,aa',
				'cold-rebuilt log must carry the synthetic re-attach ops');
			assert.isTrue(cold.ops.slice(1).every((op) => op.z === true));
			store.releaseHandle(id);
		});

		it('appends 1000 siblings in one commit without blowing up', function() {
			this.timeout(30000);
			const id = wid();
			const hh = store.getHandle(id);
			hh.fromHtml(SHELL_HTML, 'u', 's');
			const bodyEid = hh.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;
			const ops = [];
			for (let i = 0; i < 1000; i++) {
				ops.push({k: 'sa', p: bodyEid, i, e: 10000 + i, t: NODE_ELEMENT, n: 'p'});
				ops.push({k: 'aa', e: 10000 + i, n: null, v: 'x'});
				ops.push({k: 'aa', e: 10000 + i, i: 0, n: 'data-n',
					v: String(i)});
			}
			const t0 = Date.now();
			hh.applyCommit({base: hh.revision, ops, userId: 'u', source: 's'});
			const elapsed = Date.now() - t0;
			assert.equal(hh.nodes.get(bodyEid).kids.length, 1000);
			// Restart consistency for the batched parent rebuild.
			hh.nodes = store.emptyMirror();
			hh._load();
			assert.equal(hh.nodes.get(bodyEid).kids.length, 1000);
			const jml = mirrorToJsonML(hh.nodes);
			assert.equal(jml[3].length, 1002);
			// Loose upper bound: catches O(n²) regressions (this run should be
			// well under a second; a quadratic path takes tens of seconds).
			assert.isBelow(elapsed, 5000, `1000-append commit took ${elapsed}ms`);
			store.releaseHandle(id);
		});
	});

	describe('history: reverse diff and version reconstruction', function() {
		let h;
		before(function() {
			h = store.getHandle(wid());
			h.fromHtml('<html><head></head><body><p>one</p></body></html>',
				'u1', 's1');
		});
		after(function() {
			store.releaseHandle(h.id);
		});

		it('reconstructs any tagged revision from the reverse diff', function() {
			const bodyEid = h.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;
			const v1 = h.revision;

			// Commit 2: append a paragraph with its own text node.
			const v2 = h.applyCommit({base: v1, ops: [
				{k: 'sa', p: bodyEid, i: 1, e: 4001, t: NODE_ELEMENT, n: 'p'},
				{k: 'sa', p: 4001, i: 0, e: 4003, t: NODE_TEXT, n: null},
				{k: 'aa', e: 4003, n: null, v: 'two'}
			], userId: 'u', source: 's'}).v;

			// Commit 3: empty the first paragraph's text.
			const textEid = h.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.t === NODE_TEXT).e;
			h.applyCommit({base: v2, ops: [
				{k: 'sd', e: textEid, q: 0, v: 'one'}
			], userId: 'u', source: 's'});

			h.tag('v2-tag', v2);
			const atV2 = mirrorToJsonML(h.snapshotAt(v2));
			assert.deepEqual(atV2[3][2], ['p', {}, 'one']);
			assert.deepEqual(atV2[3][3], ['p', {}, 'two']);
			const atV1 = mirrorToJsonML(h.snapshotAt(v1));
			assert.deepEqual(atV1[3][2], ['p', {}, 'one']);
			assert.isUndefined(atV1[3][3]);
			// Head still has the edits.
			assert.equal(mirrorToJsonML(h.nodes)[3][2][2], '');
			assert.deepEqual(mirrorToJsonML(h.nodes)[3][3], ['p', {}, 'two']);
		});

		it('resurrects a removed subtree from its payload on the walk back', function() {
			const bodyEid = h.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;

			// Commit 4: a nested subtree (div > span > text) with attributes.
			const v4 = h.applyCommit({base: h.revision, ops: [
				{k: 'sa', p: bodyEid, i: 2, e: 4101, t: NODE_ELEMENT, n: 'div'},
				{k: 'aa', e: 4101, i: 0, n: 'class', v: 'box'},
				{k: 'sa', p: 4101, i: 0, e: 4103, t: NODE_ELEMENT, n: 'span'},
				{k: 'sa', p: 4103, i: 0, e: 4104, t: NODE_TEXT, n: null},
				{k: 'aa', e: 4104, n: null, v: 'deep'}
			], userId: 'u', source: 's'}).v;

			// Commit 5: remove the whole subtree (a pure removal — the root's
			// sr is the only forward op; the descendants never get own rows).
			h.applyCommit({base: v4, ops: [
				{k: 'sr', p: bodyEid, e: 4101}
			], userId: 'u', source: 's'});

			// At head the subtree is gone...
			const headJml = mirrorToJsonML(h.nodes);
			assert.equal(JSON.stringify(headJml).includes('deep'), false);
			// ...but walking back to v4 resurrects ALL of it, attrs included.
			const atV4 = mirrorToJsonML(h.snapshotAt(v4));
			const div = JSON.stringify(atV4);
			assert.include(div, 'box');
			assert.include(div, 'deep');
			const jmlAtV4 = atV4[3].slice(2).find((el) => Array.isArray(el) && el[0] === 'div');
			assert.deepEqual(jmlAtV4,
				['div', {class: 'box'}, ['span', {}, 'deep']]);
		});

		it('reconstructs all the way back to the empty document', function() {
			assert.deepEqual(mirrorToJsonML(h.snapshotAt(0)), []);
		});

		it('resurrects a single-node removal with its content attr', function() {
			const bodyEid = h.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;

			// A text node with content — a size-1 subtree when removed.
			const vText = h.applyCommit({base: h.revision, ops: [
				{k: 'sa', p: bodyEid, i: 2, e: 4301, t: NODE_TEXT, n: null},
				{k: 'aa', e: 4301, n: null, v: 'Row 0 text'}
			], userId: 'u', source: 's'}).v;

			// Remove just that node (no re-add — a pure size-1 removal).
			h.applyCommit({base: h.revision, ops: [
				{k: 'sr', p: bodyEid, e: 4301}
			], userId: 'u', source: 's'});

			// The walk back must resurrect the node WITH its content: the sr
			// writes no state-inverse rows of its own, so the payload row is
			// the only place the nameless text attr survives.
			const atVText = mirrorToJsonML(h.snapshotAt(vText));
			assert.include(JSON.stringify(atVText), 'Row 0 text');
		});

		it('prefers the removal payload over gutted walk-stash fragments', function() {
			const bodyEid = h.allCommits()[0].ops
				.find((op) => op.k === 'sa' && op.n === 'body').e;

			// Commit: a subtree (div > span > text), parent-first.
			const vFull = h.applyCommit({base: h.revision, ops: [
				{k: 'sa', p: bodyEid, i: 2, e: 4201, t: NODE_ELEMENT, n: 'div'},
				{k: 'aa', e: 4201, i: 0, n: 'class', v: 'row'},
				{k: 'sa', p: 4201, i: 0, e: 4203, t: NODE_ELEMENT, n: 'span'},
				{k: 'sa', p: 4203, i: 0, e: 4204, t: NODE_TEXT, n: null},
				{k: 'aa', e: 4204, n: null, v: 'Row 0 text'}
			], userId: 'u', source: 's'}).v;

			// Commit: remove the whole subtree (payload gets written).
			h.applyCommit({base: h.revision, ops: [
				{k: 'sr', p: bodyEid, e: 4201}
			], userId: 'u', source: 's'});

			// Commit: re-add the SAME eids pre-order — exactly what a restore
			// diff does (diffMirrors emits parent-first sa's for target nodes
			// it rebuilds, eids preserved from the snapshot). The stash swap is
			// restoreDocument's: without it the root sa would RE-ATTACH the
			// stashed subtree in one op and the walk below could not go wrong.
			{
				const stash = h.detached;
				h.detached = new Map();
				try {
					h.applyCommit({base: h.revision, ops: [
						{k: 'sa', p: bodyEid, i: 2, e: 4201, t: NODE_ELEMENT, n: 'div'},
						{k: 'aa', e: 4201, i: 0, n: 'class', v: 'row'},
						{k: 'sa', p: 4201, i: 0, e: 4203, t: NODE_ELEMENT, n: 'span'},
						{k: 'sa', p: 4203, i: 0, e: 4204, t: NODE_TEXT, n: null},
						{k: 'aa', e: 4204, n: null, v: 'Row 0 text'}
					], userId: 'u', source: 's'});
				} finally {
					h.detached = stash;
				}
			}

			// Walking back past the removal undoes the re-add LEAF-FIRST (the
			// inverse sr rows run children before parents), leaving gutted
			// fragments in the walk stash. The removal's sa row must then use
			// the PAYLOAD (the full capture), not the gutted stash entry —
			// otherwise the div resurrects without descendants.
			const atVFull = mirrorToJsonML(h.snapshotAt(vFull));
			const div = atVFull[3].slice(2).find((el) => Array.isArray(el) && el[0] === 'div');
			assert.deepEqual(div,
				['div', {class: 'row'}, ['span', {}, 'Row 0 text']]);
		});

		it('keeps the op log across a cold start (log rebuilt from history)', function() {
			const commits = h.allCommits().map((c) => ({v: c.v, base: c.base, ops: c.ops}));
			// Drop the in-memory log: the next read takes the SQL path, exactly
			// like a process restart would.
			h.log = [];
			h.logFirstV = null;
			const commits2 = h.allCommits().map((c) => ({v: c.v, base: c.base, ops: c.ops}));
			assert.deepEqual(commits2, commits);
		});
	});

	describe('local attribute positions (the (e,i)-addressed protocol)', function() {
		let h;
		before(function() {
			h = store.getHandle(wid());
			h.fromHtml('<html><head></head><body><p>hi</p></body></html>', 'u1', 's1');
		});
		after(function() {
			store.releaseHandle(h.id);
		});

		const eidOf = (name) => h.allCommits()[0].ops
			.find((op) => op.k === 'sa' && op.n === name).e;
		const attrsOf = (eid) => h.nodes.get(eid).attrs;

		it('builds an ordered list from local positions', function() {
			const pEid = eidOf('p');
			h.applyCommit({base: h.revision, ops: [
				{k: 'aa', e: pEid, i: 0, n: 'a', v: '1'},
				{k: 'aa', e: pEid, i: 1, n: 'b', v: '2'},
				{k: 'aa', e: pEid, i: 2, n: 'c', v: '3'}
			], userId: 'u', source: 's'});
			assert.deepEqual(attrsOf(pEid).map((x) => [x.n, x.v]),
				[['a', '1'], ['b', '2'], ['c', '3']]);
		});

		it('shifts position-addressed edits past concurrent inserts', function() {
			const pEid = eidOf('p');
			const base = h.revision; // attrs are [a,b,c]
			// A raw client inserts at position 0 (hostile to the append-only
			// invariant, but the protocol must still converge): [Z,a,b,c].
			h.applyCommit({base, ops: [
				{k: 'aa', e: pEid, i: 0, n: 'Z', v: '0'}
			], userId: 'a', source: 'sa'});
			// C, based on the pre-insert revision, writes into the attr it
			// knew as position 2 ('c'): the transform must move it to 3.
			const res = h.applyCommit({base, ops: [
				{k: 'si', e: pEid, i: 2, q: 0, v: 'X'}
			], userId: 'c', source: 'sc'});
			assert.isTrue(res.xformed);
			assert.deepEqual(attrsOf(pEid).map((x) => x.v),
				['0', '1', '2', 'X3']);
		});

		it('voids a position-addressed edit whose slot a concurrent removal took', function() {
			const pEid = eidOf('p');
			const base = h.revision; // [Z,a,b,c]
			// A removes 'b' (position 2) by name.
			h.applyCommit({base, ops: [
				{k: 'ar', e: pEid, n: 'b'}
			], userId: 'a', source: 'sa'});
			// C, based on the pre-removal revision, targets position 2 — the
			// exact removed slot: the edit voids (a shifted index would have
			// hit the innocent 'c' that slid into it).
			const res = h.applyCommit({base, ops: [
				{k: 'si', e: pEid, i: 2, q: 0, v: 'X'}
			], userId: 'c', source: 'sc'});
			assert.deepEqual(res.ops, []);
			assert.deepEqual(attrsOf(pEid).map((x) => x.n), ['Z', 'a', 'c']);
		});

		it('removes by name and by position', function() {
			const pEid = eidOf('p');
			h.applyCommit({base: h.revision, ops: [
				{k: 'ar', e: pEid, n: 'a'},
				{k: 'ar', e: pEid, i: 0} // position form: removes 'Z'
			], userId: 'u', source: 's'});
			assert.deepEqual(attrsOf(pEid).map((x) => x.n), ['c']);
		});

		it('updates in place, and undo restores the OLD value at the SAME position', function() {
			const pEid = eidOf('p');
			h.applyCommit({base: h.revision, ops: [
				{k: 'aa', e: pEid, i: 0, n: 'q', v: 'Q'},
				{k: 'aa', e: pEid, i: 1, n: 'r', v: 'R'}
			], userId: 'u', source: 's'});
			const before = h.revision;
			// Update BOTH existing names — 'au' history rows, positions kept.
			h.applyCommit({base: h.revision, ops: [
				{k: 'aa', e: pEid, i: 0, n: 'q', v: 'QQ'},
				{k: 'aa', e: pEid, i: 1, n: 'r', v: 'RR'}
			], userId: 'u', source: 's'});
			assert.deepEqual(attrsOf(pEid).map((x) => [x.n, x.v]),
				[['q', 'QQ'], ['r', 'RR'], ['c', 'X3']]);
			// Walk back to before the update: old values, SAME ORDER (a
			// remove+re-add decomposition would have moved them to the end).
			const atV = mirrorToJsonML(h.snapshotAt(before));
			const p = atV[3][2];
			assert.deepEqual(p[1], {q: 'Q', r: 'R', c: 'X3'});
			assert.deepEqual(Object.keys(p[1]), ['q', 'r', 'c']);
		});
	});

	describe('tags', function() {
		let h;
		before(function() {
			h = store.getHandle(wid());
			h.fromHtml(SHELL_HTML, 'u1', 's1');
		});
		after(function() {
			store.releaseHandle(h.id);
		});

		it('tags, reads and untags by label and by version', function() {
			const v = h.revision;
			h.tag('first', v);
			assert.equal(h.getTag('first').v, v);
			h.tag('second', v);
			// One version per label: re-tagging the version moves the old label.
			assert.isNull(h.getTag('first'));
			assert.deepEqual(h.getTags().map((t) => t.label), ['second']);
			h.untag({label: 'second'});
			assert.deepEqual(h.getTags(), []);
		});

		it('rejects labels with dots and versions out of range', function() {
			assert.throws(() => h.tag('bad.label', 0));
			assert.throws(() => h.tag('future', h.revision + 1));
		});
	});

	after(function() {
		fs.rmSync(SQLITE_DIR, {recursive: true, force: true});
	});
});
