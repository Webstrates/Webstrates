// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

// Four pages form a full signal-stream
// mesh of real peer connections (12 directions: every page streams to and accepts
// streams from every other page), and a departing page must not disturb the
// connections and registrations between the survivors.
//
// The stream source is a painted canvas rather than a media element: captureStream()
// on a canvas has its video track from the very first moment, while a <video> element
// only exposes tracks once its metadata has parsed (~100-500 ms even from cache). A
// connect() landing in that window streams an empty MediaStream and produces an offer
// with zero m-lines — a completed SDP exchange over a connection that can never carry
// media (the example-side race behind #61's present-day symptoms). The canvas keeps
// this spec about the signaling and connection machinery, not about media timing.
describe('Signal streams with more than two clients (#61)', function () {
	this.timeout(60000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser;
	const pages = [];

	// Set up one mesh participant: a streamer publishing a canvas stream and a listener
	// auto-accepting everybody else's. Everything the assertions need is recorded in
	// window.__mesh: which peers accepted our stream (streamerFor), whose streams we
	// accepted (listenerFor), which remote streams actually arrived (remoteStreams), the
	// connection stubs with their side and peer (conns), and the clientPart broadcasts
	// (parts). The stubs are live objects, so predicates evaluated inside the page can
	// ask them whether their connection is up.
	const setupPage = (page) => page.evaluate(() => {
		window.__mesh = {
			clientId: webstrate.clientId,
			streamerFor: [],
			listenerFor: [],
			remoteStreams: [],
			conns: [],
			parts: []
		};

		webstrate.on('clientPart', (partingClientId) => {
			window.__mesh.parts.push(partingClientId);
		});

		// Source stream: a canvas that keeps repainting, so the captured track
		// continuously produces frames (a stream that never paints can make Chromium
		// drop the track, and a static one leaves nothing to observe).
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

		const registerStreamer = () => {
			document.body.webstrate.signalStream((clientId, connect) => {
				const stub = connect(window.__stream, {}, () => {});
				window.__mesh.streamerFor.push(clientId);
				window.__mesh.conns.push({ side: 'streamer', peer: clientId, stub });
			});
		};

		// Streamer side: accept every request. connect() creates the streamer-side
		// WebRTCClient and its RTCPeerConnection with our (track-carrying) stream.
		registerStreamer();

		// Listener side: auto-accept every offer. clientAcceptCallback() creates the
		// listener-side WebRTCClient; its argument receives the remote stream once
		// tracks arrive (fired once per track of the stream — a video-only stream
		// fires it exactly once per connection).
		document.body.webstrate.on('signalStream', (senderClientId, metaData, clientAcceptCallback) => {
			const stub = clientAcceptCallback((remoteStream) => {
				window.__mesh.remoteStreams.push({
					peer: senderClientId,
					streamId: remoteStream.id,
					tracks: remoteStream.getTracks().map((track) => track.kind)
				});
			});
			window.__mesh.listenerFor.push(senderClientId);
			window.__mesh.conns.push({ side: 'listener', peer: senderClientId, stub });
		});
	});

	// JSON-safe snapshot of a page's mesh, with the live stubs resolved to booleans.
	const getMesh = (page) => page.evaluate(() => ({
		clientId: window.__mesh.clientId,
		streamerFor: window.__mesh.streamerFor.slice(),
		listenerFor: window.__mesh.listenerFor.slice(),
		remoteStreams: window.__mesh.remoteStreams.slice(),
		parts: window.__mesh.parts.slice(),
		conns: window.__mesh.conns.map((conn) => ({
			side: conn.side,
			peer: conn.peer,
			connected: conn.stub.isConnected()
		}))
	}));

	// Wait until a page's mesh satisfies `predicate`, which is evaluated in the page
	// with the extra serializable `args` as its parameters (functions don't survive the
	// evaluate boundary, so the predicate ships as source and must close over nothing,
	// like in the two-client spec above). Poll on a fixed interval: requestAnimationFrame
	// never fires in background tabs, i.e. in every page that shares its browser with
	// another page.
	const waitForMesh = (page, predicate, timeout = 20000, ...args) => page.waitForFunction(
		(predicateSource, predicateArgs) => eval(predicateSource)(...predicateArgs),
		{ polling: 100, timeout },
		predicate.toString(), args
	);

	// Mesh-complete on a page: its stream was accepted by every other page exactly
	// once, it accepted every other page's stream exactly once, every one of those
	// connections reports connected, and every accepted stream arrived with its own
	// MediaStream. A duplicate handshake for any direction (the synchronized-reload
	// bug class) pushes a second entry for that peer and fails the counts.
	const meshComplete = (peerCount) => {
		const mesh = window.__mesh;
		const distinct = (list) => new Set(list).size;
		return mesh.streamerFor.length === peerCount && distinct(mesh.streamerFor) === peerCount &&
			mesh.listenerFor.length === peerCount && distinct(mesh.listenerFor) === peerCount &&
			mesh.remoteStreams.length === peerCount &&
			distinct(mesh.remoteStreams.map((remote) => remote.streamId)) === peerCount &&
			mesh.conns.length === 2 * peerCount &&
			mesh.conns.every((conn) => conn.stub.isConnected());
	};

	// Every connection to anybody but the departed client is live. (Connections to the
	// departed client are deliberately excluded: their transport is gone, and when
	// they are noticed as disconnected is Chromium's business, not the protocol's.)
	const connectionsToSurvivorsLive = (departedId) =>
		window.__mesh.conns.every((conn) => conn.peer === departedId || conn.stub.isConnected());

	before(async () => {
		browser = await puppeteer.launch();

		// Load the pages one at a time, like the two-client spec: clients hitting a
		// not-yet-existing webstrate at the same instant race to create it, and the
		// losing client keeps its locally seeded document — with different element
		// wids than the committed one, so no handshake could ever complete. The
		// staggered load also keeps one connection per direction deterministic: with
		// synchronized registrations a client's broadcast wantToStream and its direct
		// reply to another client's requestForStreams can coincide, which the stock
		// client answers with two connections for the same direction (issue #61's
		// duplicate-connection storm).
		for (let i = 0; i < 4; i++) {
			const page = await browser.newPage();
			pages.push(page);
			await page.goto(url, { waitUntil: 'networkidle2' });
			assert.isTrue(await util.waitForFunction(page,
				() => window.webstrate && window.webstrate.loaded, 10),
			`page ${i} never finished loading`);
		}

		for (const page of pages) {
			await setupPage(page);
		}
	});

	after(async () => {
		await pages[0].setCacheEnabled(false);
		await util.deleteWebstrate(pages[0], url);
		await browser.close();
	});

	it('every client should hold exactly one live stream connection to each of the other clients',
		async () => {
		// The fourth page's registration completes the mesh: its listeners answer the
		// three earlier streamers' direct wantToStream, and its own streamer broadcast
		// is accepted by the three earlier listeners. All 12 directions form here.
			await Promise.all(pages.map((page) => waitForMesh(page, meshComplete, 20000, 3)));

			const meshes = await Promise.all(pages.map(getMesh));
			const clientIds = meshes.map((mesh) => mesh.clientId);
			assert.equal(new Set(clientIds).size, 4, 'every page must have its own clientId');

			meshes.forEach((mesh, i) => {
				const others = clientIds.filter((id) => id !== mesh.clientId).sort();
				assert.deepEqual([...mesh.streamerFor].sort(), others,
					`page ${i}'s stream should have been accepted by each other client exactly once`);
				assert.deepEqual([...mesh.listenerFor].sort(), others,
					`page ${i} should have accepted each other client's stream exactly once`);

				// Exactly one connection per direction (no duplicate handshakes): 3
				// streamer-side + 3 listener-side, all connected.
				assert.lengthOf(mesh.conns, 6,
					`page ${i} should hold exactly two connections per other client (one per direction)`);
				assert.isTrue(mesh.conns.every((conn) => conn.connected),
					`page ${i}: every connection should be up`);

				// Media actually flowed: one remote stream per peer, each with the
				// source's video track (the canvas stream), each a distinct stream.
				assert.deepEqual([...mesh.remoteStreams.map((remote) => remote.peer)].sort(), others,
					`page ${i} should have received a stream from each other client`);
				mesh.remoteStreams.forEach((remote) =>
					assert.deepEqual(remote.tracks, ['video'],
						`page ${i}: stream from ${remote.peer} should carry the canvas video track`));
				assert.equal(new Set(mesh.remoteStreams.map((remote) => remote.streamId)).size, 3,
					`page ${i}: every peer's stream should be its own MediaStream`);
			});
		});

	it('a client leaving should not disturb the streams between the remaining clients', async () => {
		const meshes = await Promise.all(pages.map(getMesh));
		const clientIds = meshes.map((mesh) => mesh.clientId);
		const departed = clientIds[3];
		const survivors = pages.slice(0, 3);

		// Close the fourth page: its socket drops, the server broadcasts its
		// clientPart, and its peer connections lose their transport.
		await pages[3].close();

		// The survivors see the departure...
		await Promise.all(survivors.map((page) => waitForMesh(page,
			(departedId) => window.__mesh.parts.includes(departedId), 15000, departed)));
		// ...but every connection between the survivors must still be live.
		await Promise.all(survivors.map((page) => waitForMesh(page,
			connectionsToSurvivorsLive, 15000, departed)));

		// A streamer registered after the departure must still reach exactly the two
		// remaining peers: the departed client cannot accept anything anymore, and
		// the departure must not have deafened the survivors to new registrations
		// (the part also unsubscribes the departed client on the server — that
		// cleanup must not touch anyone else's subscriptions).
		await pages[2].evaluate(() => {
			document.body.webstrate.signalStream((clientId, connect) => {
				const stub = connect(window.__stream, {}, () => {});
				window.__mesh.streamerFor.push(clientId);
				window.__mesh.conns.push({ side: 'streamer', peer: clientId, stub });
			});
		});

		// On the registering page the two survivors accept again (5 acceptances
		// total: 3 from the mesh above + 2 new, over 3 distinct peers) and every
		// connection to a surviving peer is live; on the other survivors the new
		// listener-side connections to the fresh streamer must come up alongside
		// the old ones.
		const renewed = pages[2];
		const renewAcceptedAndLive = (departedId) => {
			const mesh = window.__mesh;
			const liveForSurvivors = mesh.conns.every((conn) =>
				conn.peer === departedId || conn.stub.isConnected());
			return mesh.streamerFor.length === 5 &&
				new Set(mesh.streamerFor).size === 3 && liveForSurvivors;
		};
		await waitForMesh(renewed, renewAcceptedAndLive, 20000, departed);
		await Promise.all(survivors.filter((page) => page !== renewed).map((page) =>
			waitForMesh(page, connectionsToSurvivorsLive, 20000, departed)));

		// The renewed stream was accepted by exactly the surviving clients: two
		// acceptances per survivor (one from the original mesh above, one from the
		// renewed registration). The departed client's single acceptance predates
		// its departure — after the filter only the survivors' acceptances remain,
		// and nobody else could have accepted in its name.
		const renewedMesh = await getMesh(renewed);
		const renewedAccepts = renewedMesh.streamerFor
			.filter((peer) => peer !== departed);
		assert.equal(renewedAccepts.length, 4,
			'each surviving client should have accepted twice (original mesh + renewed stream)');
		assert.deepEqual([...new Set(renewedAccepts)].sort(),
			clientIds.filter((id) => id !== departed && id !== renewedMesh.clientId).sort(),
			'the renewed stream should have been accepted by exactly the surviving clients');

		// And the survivors' mutual connections from the original mesh are still up.
		for (const page of survivors) {
			const mesh = await getMesh(page);
			assert.isTrue(mesh.conns.every((conn) =>
				conn.peer === departed || conn.connected),
			'connections between the survivors should have survived the departure');
		}
	});
});
