'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
const nodeObjects = require('./nodeObjects');
const signaling = require('./signaling');

const signalStreamModule = {};

let clientId;
coreEvents.addEventListener('populated', (rootElement, _webstrateId) => {
	clientId = globalObject.publicObject.clientId;
});

// Intercept streaming signals, so they're not processed as regular signals by the signaling module.
signaling.addInterceptor(payload => {
	const message = payload.m;
	const senderClientId = payload.s;
	// Only handle internal webrtc messages and also ignore our own messages.
	if (typeof message.__internal_webrtc === 'undefined' || senderClientId === clientId) {
		return false;
	}

	// No reason to do this all now, so we use setImmdiate.
	setImmediate(handleSignal, payload.id, senderClientId, message);
	return true;
});

function handleSignal(wid, senderClientId, message) {
	const node = coreUtils.getElementByWid(wid);

	if (message.requestForStreams) {
		Array.from(wantToStreamCallbacks.get(wid).keys()).forEach(ownId => {
			node.webstrate.signal({
				__internal_webrtc: true,
				wantToStream: true,
				senderId: ownId,
				recipientId: message.senderId
			}, senderClientId);
		});
		return;
	}

	// If we get a message from somebody wanting to stream, we ask all the people listening for
	// streams. If they accept, we create the webrtcClient.
	if (message.wantToStream) {
		const listenerSendersForWid = listenerSenders.get(wid);
		Array.from(wantToListenCallbacks.get(wid).entries()).forEach(([listenerId, callback]) => {
			// One streamer registration can reach a listener more than once:
			// as the registration broadcast, as the direct reply to a
			// listener's own requestForStreams, and — whenever ANOTHER listener
			// on the same page registers — as a re-fire of every already-
			// connected listener callback, so accept
			// each (streamer, listener registration) pair only while it
			// doesn't already have a live client.
			const dedupKey = message.senderId + '\u0000' + listenerId;
			const knownOwnId = listenerSendersForWid.get(dedupKey);
			if (knownOwnId && webrtcClients.get(wid).has(knownOwnId)) {
				return;
			}

			const ownId = coreUtils.randomString();
			// Other clients may be responding to the same recipientId/stream. Therefore, the streamer
			// can't create a WebRTCClient with the original recipientId as these would override each
			// other in the webrtcClients map (the streamer would be creating two entries with the same
			// recipientId). Instead, the streamer needs to generate a new recipientId for each listener
			// to use, so the streamer can distinguish the clients from each other. However, it's
			// difficult to communicate this back to the listeners. Therefore, the listener instead
			// creates a new recipientId, telling the streamer "In the future, I'll address you with this
			// id instead".
			const newRecipientId = coreUtils.randomString();
			const webrtcClient = new WebRTCClient(ownId, newRecipientId, senderClientId,
				node, wid, { listener: true });
			webrtcClients.get(wid).set(ownId, webrtcClient);
			listenerSendersForWid.set(dedupKey, ownId);

			// If the client hasn't connected after 30 seconds, we conclude that it won't happen and clean
			// up the client we created.
			setTimeout(() => {
				if (!webrtcClient.stub.isConnected()) {
					webrtcClient.reap();
					if (listenerSendersForWid.get(dedupKey) === ownId) {
						listenerSendersForWid.delete(dedupKey);
					}
				}
			}, 30 * 1000);

			callback(senderClientId, 'META_DATA_IS_DEPRECATED', clientAcceptCallback => {

				webrtcClient.onRemoteStream(clientAcceptCallback);
				node.webstrate.signal({
					__internal_webrtc: true,
					wantToListen: true,
					recipientId: message.senderId,
					newRecipientId,
					senderId: ownId,
				}, senderClientId);
				return webrtcClient.stub;
			});
		});
		return;
	}

	if (message.wantToListen) {
		const callback = wantToStreamCallbacks.get(wid).get(message.recipientId);

		if (callback) {
			callback(senderClientId, (localStream, meta, onConnectCallback) => {
				const webrtcClient = new WebRTCClient(message.newRecipientId, message.senderId,
					senderClientId, node, wid, { streamer: true });
				webrtcClient.onConnect(onConnectCallback);
				webrtcClients.get(wid).set(message.newRecipientId, webrtcClient);
				webrtcClient.start(localStream);
				// If the listener never answers (e.g. it reloaded while our
				// offer was in flight and the frames were dropped), this peer
				// connection stays 'new' forever — gotStateChange never fires
				// for it. Mirror the listener-side 30 s unconnected cleanup.
				setTimeout(() => {
					if (!webrtcClient.stub.isConnected()) {
						webrtcClient.reap();
					}
				}, 30 * 1000);
				return webrtcClient.stub;
			});
		}
		return;
	}

	if (message.sdp || message.ice) {
		const webrtcClient = webrtcClients.get(wid).get(message.recipientId);
		if (webrtcClient) {
			webrtcClient.handleMessage(message);
		} else {
			console.error('Got message for unknown recipient', message, webrtcClients);
		}
		return;
	}
}

const wantToStreamCallbacks = new Map();
const wantToListenCallbacks = new Map();
const webrtcClients = new Map();
// Per wid: (streamer senderId, listener registration ownId) -> the listener-side
// ownId of the client created for that pair, used to dedup connections in the
// wantToStream branch above (one live client per streamer per listener
// registration).
const listenerSenders = new Map();

function WebRTCClient(ownId, recipientId, clientRecipientId, node, wid, { listener, streamer }) {
	let active = false, peerConnection, onRemoteStreamCallback, onConnectCallback, onCloseCallback;
	let reaped = false;

	const start = (localStream) => {
		active = true;
		peerConnection = new RTCPeerConnection(config.peerConnectionConfig);
		peerConnection.onicecandidate = gotIceCandidate;
		peerConnection.oniceconnectionstatechange = gotStateChange;
		if (streamer) {
			localStream.getTracks().forEach((track)=>{
				peerConnection.addTrack(track, localStream);
			});
			peerConnection.createOffer().then(createdDescription).catch(errorHandler);
		}
		if (listener) {
			peerConnection.ontrack = gotRemoteStream;
		}
	};

	const createdDescription = (description) => {
		peerConnection.setLocalDescription(description).then(function() {
			node.webstrate.signal({
				sdp: peerConnection.localDescription,
				__internal_webrtc: true,
				senderId: ownId,
				recipientId
			}, clientRecipientId);
		}).catch(errorHandler);
	};

	const handleMessage = (message) => {
		if(!peerConnection) start();

		if (message.sdp) {
			peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp)).then(function() {
				// Only create answers in response to offers
				if(message.sdp.type == 'offer') {
					peerConnection.createAnswer().then(createdDescription).catch(errorHandler);
				}
			}).catch(errorHandler);
		} else if(message.ice) {
			peerConnection.addIceCandidate(new RTCIceCandidate(message.ice)).catch(errorHandler);
		}
	};

	const gotIceCandidate = (event) => {
		if(event.candidate != null) {
			node.webstrate.signal({
				ice: event.candidate,
				__internal_webrtc: true,
				senderId: ownId,
				recipientId
			}, clientRecipientId);
		}
	};

	const gotStateChange = event => {
		switch (peerConnection.iceConnectionState) {
			case 'connected':
				onConnectCallback && onConnectCallback(event);
				break;
			case 'closed':
			case 'disconnected':
			case 'failed':
				onCloseCallback && onCloseCallback(event);
				reap();
				break;
		}
	};

	const gotRemoteStream = (event) => {
		onRemoteStreamCallback(event.streams[0]);
	};

	const errorHandler = (...error) => {
		console.error(...error);
	};

	const close = () => {
		if (peerConnection && peerConnection.connectionState !== 'closed') {
			peerConnection.close();
		}
	};

	// Remove this client from its wid's map and close the peer connection.
	// Idempotent, so it's safe to call from both gotStateChange and the 30 s
	// unconnected-listener timer. 
	const reap = () => {
		if (reaped) {
			return;
		}
		reaped = true;
		const clients = webrtcClients.get(wid);
		if (clients) {
			clients.delete(ownId);
		}
		close();
	};

	return {
		id: ownId, active, listener, streamer, peerConnection,
		onRemoteStream: callback => onRemoteStreamCallback = callback,
		onConnect: callback => onConnectCallback = callback,
		close, reap,
		stub: {
			isConnected: () => !!peerConnection &&
				['checking', 'connected', 'completed'].includes(peerConnection.iceConnectionState),
			close: () => peerConnection.close(),
			onclose: callback => onCloseCallback = callback
		},
		start, handleMessage
	};
}

function setupSignalStream(publicObject, eventObject) {
	const wid = publicObject.id;

	// Text nodes and transient elements won't have wids, meaning there's way for us to signal on
	// them, and thus it'd be pointless to add a signaling method and event.
	if (!wid) return;

	// Check if we already setup singal streaming
	if(publicObject.signalStream != null) {
		return;
	}

	webrtcClients.set(wid, new Map());
	wantToStreamCallbacks.set(wid, new Map());
	wantToListenCallbacks.set(wid, new Map());
	listenerSenders.set(wid, new Map());

	// A mapping from user callbacks to our internal callbacks: fn -> fn.
	//const callbacks = new Map();

	const node = coreUtils.getElementByWid(wid);

	Object.defineProperty(publicObject, 'signalStream', {
		value: (callback) => {
			signaling.subscribe(wid);
			const ownId = coreUtils.randomString();
			wantToStreamCallbacks.get(wid).set(ownId, callback);
			node.webstrate.signal({
				__internal_webrtc: true,
				wantToStream: true,
				senderId: ownId
			});
		},
		writable: false
	});

	Object.defineProperty(publicObject, 'stopStreamSignal', {
		value: (callback) => {
			// Find the ownId that was generated when adding this callback. 
			const streamers = Array.from(wantToStreamCallbacks.get(wid).entries());
			const streamer = streamers.find(([, registeredCallback]) => registeredCallback === callback);
			const ownId = streamer && streamer[0];

			if (ownId) {
				wantToStreamCallbacks.get(wid).delete(ownId);
			}

			// "But what if somebody else is still listening? Then we shouldn't unsubscribe". Worry not,
			// the signaling module keeps track of how many people are actually listening and doesn't
			// unsubcribe unless we're the last/only listener.
			signaling.unsubscribe(wid);
		},
		writable: false
	});

	eventObject.createEvent('signalStream', {
		addListener: (callback) => {
			if (wantToListenCallbacks.get(wid).size === 0) {
				signaling.subscribe(wid);
			}
			const ownId = coreUtils.randomString();
			wantToListenCallbacks.get(wid).set(ownId, callback);
			node.webstrate.signal({
				__internal_webrtc: true,
				requestForStreams: true,
				senderId: ownId
			});
		},
		removeListener: (callback) => {
			// Find the ownId that was generated when adding this callback.
			const listeners = Array.from(wantToListenCallbacks.get(wid).entries());
			const listener = listeners.find(([, registeredCallback]) => registeredCallback === callback);
			const ownId = listener && listener[0];

			if (ownId) {
				wantToListenCallbacks.get(wid).delete(ownId);
			}

			signaling.unsubscribe(wid);
		},
	});
}

setupSignalStream(globalObject.publicObject, globalObject);

// Add signalStream events to all webstrate objects (with a wid) after the document has been
// populated.
coreEvents.addEventListener('webstrateObjectsAdded', (nodes) => {
	coreUtils.recursiveForEach(nodes, (node) => {
		const eventObject = nodeObjects.getEventObject(node);
		setupSignalStream(node.webstrate, eventObject);
	});
}, coreEvents.PRIORITY.IMMEDIATE);

// Add signalStream events to all webstrate objects (with wid) after they're added continually.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	setupSignalStream(node.webstrate, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);

// Listen for when webstrate.id and wid is ready on webstrateObjects
coreEvents.addEventListener('webstrateObjectAddedId', (node, eventObject) => {
	setupSignalStream(node.webstrate, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = signalStreamModule;