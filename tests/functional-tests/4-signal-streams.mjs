// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Streaming signals keep their callbacks in per-wid maps under a random ownId, and stopping
// or removing a callback has to find that ownId by comparing the 
//
// The streamer callbacks on one page fire when a listener on the other page accepts the
// stream, and the listener callbacks fire when the other page registers a streamer, so every
// step below is observable through the call logs the helpers record in the pages.
describe('Signal streams', function () {
	this.timeout(30000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	// Register a streamer under `label` on a page. The streamer callback fires — and records
	// the label — when a listener on another page accepts the stream.
	//
	// Streaming signals live on webstrate objects that have a wid. (The document-level
	// webstrate object's pseudo-wid 'document' resolves to no element, so registering there
	// throws — the body element is the lowest object the API actually works on.)
	const addStreamer = (page, label) => page.evaluate((label) => {
		window.__streamerCalls = window.__streamerCalls || [];
		window.__streamers = window.__streamers || {};
		const streamer = () => window.__streamerCalls.push(label);
		window.__streamers[label] = streamer;
		document.body.webstrate.signalStream(streamer);
	}, label);

	// Stop the streamer registered under `label`.
	const stopStreamer = (page, label) => page.evaluate((label) => {
		document.body.webstrate.stopStreamSignal(window.__streamers[label]);
		delete window.__streamers[label];
	}, label);

	// Register a stream listener under `label`. The listener callback fires — and records the
	// label — when another page registers a streamer; it auto-accepts so the streamer side
	// sees its callback fire, which is how the streamer tests tell streamers apart.
	const addListener = (page, label) => page.evaluate((label) => {
		window.__listenCalls = window.__listenCalls || [];
		window.__listeners = window.__listeners || {};
		const listener = (senderClientId, metaData, clientAcceptCallback) => {
			window.__listenCalls.push(label);
			// Accepting signals back at the streamer, whose callback then fires.
			clientAcceptCallback(() => {});
		};
		window.__listeners[label] = listener;
		document.body.webstrate.on('signalStream', listener);
	}, label);

	// Remove the listener registered under `label`.
	const removeListener = (page, label) => page.evaluate((label) => {
		document.body.webstrate.off('signalStream', window.__listeners[label]);
		delete window.__listeners[label];
	}, label);

	// Snapshot of a page's recorded calls.
	const getCalls = (page) => page.evaluate(() => ({
		listen: (window.__listenCalls || []).slice(),
		streamer: (window.__streamerCalls || []).slice()
	}));

	// Clear the call logs, so each test starts from its own baseline.
	const resetCalls = (page) => page.evaluate(() => {
		window.__listenCalls = [];
		window.__streamerCalls = [];
	});

	// Wait until a page's call logs satisfy `predicate`, which is evaluated in the page with
	// the logs as its argument. Poll on a fixed interval: requestAnimationFrame never fires
	// in background tabs, i.e. in every page that shares its browser with another page.
	const waitForCalls = (page, predicate, timeout = 10000) => page.waitForFunction(
		(predicateSource) => {
			const logs = {
				listen: (window.__listenCalls || []).slice(),
				streamer: (window.__streamerCalls || []).slice()
			};
			return eval(predicateSource)(logs);
		},
		{ polling: 100, timeout },
		predicate.toString()
	);

	before(async () => {
		browser = await puppeteer.launch();
		pageA = await browser.newPage();
		pageB = await browser.newPage();

		// Load the pages one at a time: two clients hitting a not-yet-existing webstrate at
		// the same instant race to create it, and the losing client keeps its locally seeded
		// document — with different element wids than the one that got committed. The pages
		// would then signal on disjoint wids and no stream handshake could ever complete.
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageA,
			() => window.webstrate && window.webstrate.loaded, 10),
			'page A never finished loading');
		await pageB.goto(url, { waitUntil: 'networkidle2' });
		assert.isTrue(await util.waitForFunction(pageB,
			() => window.webstrate && window.webstrate.loaded, 10),
			'page B never finished loading');
	});

	after(async () => {
		await pageA.setCacheEnabled(false);
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it("removing a 'signalStream' listener should remove that listener, not the first registered one", async () => {
		await Promise.all([resetCalls(pageA), resetCalls(pageB)]);

		// A gives the two listeners on B something to react to when they subscribe.
		await addStreamer(pageA, 'streamer');

		// Every listener registration broadcasts a request for streams, which A answers with
		// one wantToStream message per registered streamer; the listeners on B then fire (and
		// auto-accept, which fires A's streamer in turn — irrelevant here, but it is the
		// handshake that makes the counts below deterministic).
		await addListener(pageB, 'first');
		await waitForCalls(pageB, (logs) => logs.listen.includes('first'));

		await addListener(pageB, 'second');
		await waitForCalls(pageB, (logs) =>
			logs.listen.filter((l) => l === 'second').length >= 1);
		// 'first' fired for its own registration's handshake, 'second' for its own.
		// With connection dedup (one live client per streamer per listener
		// registration — see the multi-client spec) the reply to 'second's request
		// no longer re-fires the already-connected 'first': stock fired every
		// listener for every handshake delivery, duplicating connections.
		const before = await getCalls(pageB);
		assert.deepEqual(before.listen, ['first', 'second'],
			'unexpected listener handshake');

		// Remove the SECOND listener. With the shadowed-callback bug this removed the first
		// registered listener instead.
		await removeListener(pageB, 'second');

		// Listener bookkeeping only subscribes on the first listener (and unsubscribes on
		// every removal), so removing 'second' also dropped B's signal subscription. A
		// streamer registration always subscribes, so B registers a dummy streamer purely to
		// resubscribe — its callback has nothing to react to (A has no listeners).
		await addStreamer(pageB, 'resub');

		// A registers another streamer: the broadcast fires whatever listeners remain on B.
		// Exactly one listener must fire, and it must be the one that was NOT removed.
		await addStreamer(pageA, 'streamer2');
		await waitForCalls(pageB, (logs) => logs.listen.length === 3);

		const after = await getCalls(pageB);
		assert.equal(after.listen.length, 3, 'exactly the surviving listener should have fired');
		assert.equal(after.listen[2], 'first',
			'the surviving listener should fire; the removed one must stay silent');

		// Clean up for the next test.
		await removeListener(pageB, 'first');
		await stopStreamer(pageB, 'resub');
		await stopStreamer(pageA, 'streamer');
		await stopStreamer(pageA, 'streamer2');
	});

	it('stopStreamSignal should stop the requested streamer, not the first registered one', async () => {
		await Promise.all([resetCalls(pageA), resetCalls(pageB)]);

		// A registers two streamers. B has no listeners yet, so nothing fires.
		await addStreamer(pageA, 's1');
		await addStreamer(pageA, 's2');

		// Stop the SECOND streamer. With the shadowed-callback bug this stopped the first
		// registered streamer instead.
		await stopStreamer(pageA, 's2');

		// B subscribes: the request for streams makes every streamer still registered on A
		// introduce itself, and B's auto-accepting listener makes exactly the surviving
		// streamer's callback fire on A.
		await addListener(pageB, 'listener');
		await waitForCalls(pageA, (logs) => logs.streamer.length >= 1);

		const streamerCalls = await getCalls(pageA);
		assert.deepEqual(streamerCalls.streamer, ['s1'],
			'only the streamer that was not stopped should have fired');

		const listenCalls = await getCalls(pageB);
		assert.equal(listenCalls.listen.length, 1,
			'exactly one streamer should have introduced itself');

		// Clean up.
		await stopStreamer(pageA, 's1');
		await removeListener(pageB, 'listener');
	});

	it('a second listener registering should get its own connection without duplicating the first', async () => {
		await Promise.all([resetCalls(pageA), resetCalls(pageB)]);

		// A real streamer on A: a painted canvas gives captureStream() a live
		// video track from the first moment (a media element only exposes tracks
		// once its metadata has parsed, which is a race this suite doesn't want to
		// depend on — see the multi-client spec), and the streamer actually calls
		// connect(), so every acceptance negotiates a real peer connection.
		await pageA.evaluate(() => {
			window.__accepts = [];
			const canvas = document.createElement('canvas');
			canvas.width = 160;
			canvas.height = 120;
			const ctx = canvas.getContext('2d');
			let hue = 0;
			setInterval(() => {
				hue = (hue + 17) % 360;
				ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
				ctx.fillRect(0, 0, canvas.width, canvas.height);
			}, 100);
			window.__stream = canvas.captureStream(10);
			document.body.webstrate.signalStream((clientId, connect) => {
				const stub = connect(window.__stream, {}, () => {});
				window.__accepts.push({ peer: clientId, stub });
			});
		});

		// First listener on B: accepts, so a real connection forms.
		await pageB.evaluate(() => {
			window.__streams = [];
			document.body.webstrate.on('signalStream', (senderClientId, metaData, clientAcceptCallback) => {
				clientAcceptCallback((remoteStream) => {
					window.__streams.push(remoteStream.id);
				});
			});
		});
		await pageA.waitForFunction(() => window.__accepts.length >= 1,
			{ polling: 100, timeout: 10000 });

		// A second listener registers on B. Its requestForStreams is answered by
		// the streamer's direct wantToStream 
		await pageB.evaluate(() => {
			document.body.webstrate.on('signalStream', (senderClientId, metaData, clientAcceptCallback) => {
				clientAcceptCallback((remoteStream) => {
					window.__streams.push(remoteStream.id);
				});
			});
		});

		// Wait for both the count and the connections 
		await pageA.waitForFunction(() => window.__accepts.length >= 2 &&
			window.__accepts.every((accept) => accept.stub.isConnected()),
			{ polling: 100, timeout: 10000 });
		const accepts = await pageA.evaluate(() => window.__accepts.map((accept) => ({
			peer: accept.peer,
			connected: accept.stub.isConnected()
		})));
		assert.equal(accepts.length, 2,
			'one connection per listener registration (stock: three — the first listener connected twice)');
		assert.isTrue(accepts.every((accept) => accept.connected),
			'both connections should be live');

		const streams = await pageB.evaluate(() => window.__streams.slice());
		assert.equal(streams.length, 2, 'both listeners should have received the stream');
	});
});
