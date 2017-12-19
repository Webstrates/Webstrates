'use strict';
const coreUtils = require('./coreUtils');
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
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
	// Only handle our own internal webrtc messages and also ignore our own messages.
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
		Array.from(wantToListenCallbacks.get(wid).values()).forEach(callback => {
			const ownId = coreUtils.randomString();
			// TODO: If client on the other end doesn't establish a connection, this object may never
			// get used and should get deleted if still inactive after a timeout.
			const webrtcClient = new WebRTCClient(ownId, message.senderId, senderClientId,
				node, { listener: true });
			webrtcClients.get(wid).set(ownId, webrtcClient);
			callback(senderClientId, 'META_DATA_IS_DEPRECATED', clientAcceptCallback => {

				webrtcClient.onRemoteStream(clientAcceptCallback);
				node.webstrate.signal({
					__internal_webrtc: true,
					wantToListen: true,
					recipientId: message.senderId,
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
				const webrtcClient = new WebRTCClient(message.recipientId, message.senderId, senderClientId,
					node, { streamer: true });
				webrtcClient.onConnect(onConnectCallback);
				webrtcClients.get(wid).set(message.recipientId, webrtcClient);
				webrtcClient.start(localStream);
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
			console.error('Got message for invalid recipient', wid, message, webrtcClients);
		}
		return;
	}

}

const wantToStreamCallbacks = new Map();
const wantToListenCallbacks = new Map();
const webrtcClients = new Map();

function WebRTCClient(ownId, recipientId, clientRecipientId, node, { listener, streamer }) {
	let active = false, peerConnection, onRemoteStreamCallback, onConnectCallback, onCloseCallback;

	const start = (localStream) => {
		active = true;
		peerConnection = new RTCPeerConnection(config.peerConnectionConfig);
		peerConnection.onicecandidate = gotIceCandidate;
		peerConnection.oniceconnectionstatechange = gotStateChange;
		if (streamer) {
			peerConnection.addStream(localStream);
			peerConnection.createOffer().then(createdDescription).catch(errorHandler);
		}
		if (listener) {
			peerConnection.onaddstream = gotRemoteStream;
		}
	};

	const createdDescription = (description) => {
		peerConnection.setLocalDescription(description).then(function() {
			node.webstrate.signal({
				sdp: peerConnection.localDescription,
				__internal_webrtc: true,
				senderId: ownId,
				recipientId
			});
		}).catch(errorHandler);
	};

	const handleMessage = (message) => {
		if(!peerConnection) start();

		if(message.sdp) {
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
			});
		}
	};

	const gotStateChange = event => {
		switch (peerConnection.iceConnectionState) {
			case 'connected':
				onConnectCallback && onConnectCallback(event);
				break;
			case 'disconnected':
			case 'failed':
				onCloseCallback && onCloseCallback(event);
				// TODO: Possibly delete this WebRTCClient object as it won't be reused.
				break;
		}
	};

	const gotRemoteStream = (event) => {
		onRemoteStreamCallback(event.stream);
	};

	const errorHandler = (...error) => {
		console.error(...error);
	};

	return {
		id: ownId, active, listener, streamer,
		onRemoteStream: callback => onRemoteStreamCallback = callback,
		onConnect: callback => onConnectCallback = callback,
		stub: {
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

	webrtcClients.set(wid, new Map());
	wantToStreamCallbacks.set(wid, new Map());
	wantToListenCallbacks.set(wid, new Map());

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
			const [ownId, ] = streamers.find(([ownId, callback]) => callback === callback);

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
			const [ownId, ] = listeners.find(([ownId, callback]) => callback === callback);

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
	nodes.forEach((eventObject, node) => setupSignalStream(node.webstrate, eventObject));
}, coreEvents.PRIORITY.IMMEDIATE);

// Add signalStream events to all webstrate objects (with wid) after they're added continually.
coreEvents.addEventListener('webstrateObjectAdded', (node, eventObject) => {
	setupSignalStream(node.webstrate, eventObject);
}, coreEvents.PRIORITY.IMMEDIATE);

module.exports = signalStreamModule;