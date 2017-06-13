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

// Mapping from wids to callbacks: string -> callback
const readyToStream = new Map();
const listeningForStreams = new Map();

const peerConnectionsOut = new Map();
const peerConnectionsIn = new Map();

// Intercept streaming signals, so they're not processed as regular signals by the signaling module.
signaling.addInterceptor(payload => {
	const message = payload.m;
	if (typeof message.__internal_webrtc === 'undefined') {
		return false;
	}

	// No reason to do this all now, so we use setImmdiate.
	setImmediate(handleSignal, payload);
	return true;
});

function handleSignal(payload) {
	const senderId = payload.s;
	const message = payload.m;

	// Ignore our own messages.
	if (senderId === clientId) {
		return;
	}

	const wid = payload.id;
	const node = coreUtils.getElementByWid(wid);
	if (!node && wid !== 'document') {
		return;
	}

	const webstrateObject = node ? node.webstrate : globalObject.publicObject;

	// An offerRequestRequest if when somebody comes in wanting to stream, they can send out an
	// offerRequestRequest. That is, a request for an offerRequest. The clients that may want to
	// receive the stream can then send back and offerRequest and get an offer in return.
	// It's like a guy walking into a bar, saying "hey, if anybody wants a beer, just as for it"
	// (offerRequestRequest). Another guy then responds with "Yea, I want a bear" (offerRequest),
	// and the first guy then says "Okay, you can have a beer" (offer). The offer is the stream.
	// So when a client receives this and they're listening for a stream, they can send out an
	// offerRequst as a reply.
	if (message.__internal_webrtc === 'offerRequestRequest' && listeningForStreams.has(wid)) {
		node.webstrate.signal({
			__internal_webrtc: 'offerRequest'
		});
		return;
	}

	// Somebody wants to listen to our stream, so they send out an offer request (as described above),
	// to which we reply with an offer.
	if (message.__internal_webrtc === 'offerRequest' && readyToStream.has(wid)) {
		const callback = readyToStream.get(wid);

		callback(senderId, function(stream, meta, onConnectCallback) {
			const peerConnection = new RTCPeerConnection(config.peerConnectionConfig);
			const streamId = coreUtils.randomString();
			peerConnectionsOut.set(streamId, peerConnection);

			const onCloseCallbacks = [];

			// Also send out any ICE candidates we might have.
			peerConnection.onicecandidate = function(event) {
				if (!event.candidate) {
					return;
				}
				webstrateObject.signal({
					__internal_webrtc: 'iceCandidate',
					streamId: streamId,
					iceCandidate: event.candidate
				}, senderId);
			};

			peerConnection.oniceconnectionstatechange = function(event) {
				switch (peerConnection.iceConnectionState) {
					case 'connected':
						onConnectCallback && onConnectCallback();
						break;
					case 'disconnected':
						onCloseCallbacks.forEach(function(callback) {
							callback();
						});
						break;
				}
			};

			// Add the actual stream.
			peerConnection.addStream(stream);

			// Send offer to the client requesting to get our stream.
			peerConnection.createOffer().then(function(description) {
				peerConnection.setLocalDescription(description).then(function() {
					webstrateObject.signal({
						__internal_webrtc: 'offer',
						streamId: streamId,
						description: description,
						meta: meta
					}, senderId);
				}).catch(function(err) {
					console.error(err);
				});
			}).catch(function(err) {
				console.error(err);
			});

			return {
				close: function() {
					return peerConnection.close();
				},
				onclose: function(callback) {
					onCloseCallbacks.push(callback);
				}
			};
		});
		return;
	}

	// Client listening for stream receives an offer.
	if (message.__internal_webrtc === 'offer' && listeningForStreams.has(wid)) {
		const callback = listeningForStreams.get(wid);
		callback(senderId, message.meta, function approveOffer(streamCallback) {
			var peerConnection = new RTCPeerConnection(config.peerConnectionConfig);
			peerConnectionsIn[message.streamId] = peerConnection;
			peerConnection.setRemoteDescription(new RTCSessionDescription(message.description))
			.then(function() {
				peerConnection.createAnswer().then(function(description) {
					peerConnection.setLocalDescription(description).then(function() {
						webstrateObject.signal({
							__internal_webrtc: 'answer',
							streamId: message.streamId,
							description: description
						}, senderId);
					}).catch(function(err) {
						console.error(err);
					});
				}).catch(function(err) {
					console.error(err);
				});
			}).catch(function(err) {
				console.error(err);
			});

			peerConnection.onicecandidate = function(event) {
				if (!event.candidate) {
					return;
				}
				webstrateObject.signal({
					__internal_webrtc: 'iceCandidate',
					streamId: message.streamId,
					iceCandidate: event.candidate
				}, senderId);
			};

			// `onaddstream` is deprecated, but the replacement `ontrack` isn't implemented.
			var stream;
			peerConnection.onaddstream = function(event) {
				stream = event.stream;
			};

			peerConnection.oniceconnectionstatechange = function(event) {
				switch (peerConnection.iceConnectionState) {
					case 'connected':
						webstrateObject.off('signalStream', callback);
						streamCallback(stream);
						break;
					case 'disconnected':
						onCloseCallbacks.forEach(function(callback) {
							callback();
						});
						break;
				}
			};

			var onCloseCallbacks = [];
			return {
				close: function() {
					return peerConnection.close();
				},
				onclose: function(callback) {
					onCloseCallbacks.push(callback);
				}
			};
		});
		return;
	}

	if (message.__internal_webrtc === 'iceCandidate' && peerConnectionsOut.has(message.streamId)) {
		const peerConnection = peerConnectionsOut.get(message.streamId);
		peerConnection.addIceCandidate(new RTCIceCandidate(message.iceCandidate));
		return;
	}

	if (message.__internal_webrtc === 'answer' && peerConnectionsOut.has(message.streamId)) {
		const peerConnection = peerConnectionsOut.get(message.streamId);
		peerConnection.setRemoteDescription(new RTCSessionDescription(message.description))
		.then(function() {
		}).catch(function(err) {
			console.error(err);
		});
		return;

	}
}

function setupSignalStream(publicObject, eventObject) {
	const wid = publicObject.id;

	// Text nodes and transient elements won't have wids, meaning there's way for us to signal on
	// them, and thus it'd be pointless to add a signaling method and event.
	if (!wid) return;

	// A mapping from user callbacks to our internal callbacks: fn -> fn.
	//const callbacks = new Map();

	Object.defineProperty(publicObject, 'signalStream', {
		value: (callback, recipients) => {
			readyToStream.set(wid, callback);
			// Manually subscribe to signals on the node. We don't use the regular public on handler here,
			// because we intercept all the signals ourselves anyway, so the callback would never get
			// triggered.
			signaling.subscribe(wid);
			publicObject.signal({
				__internal_webrtc: 'offerRequestRequest'
			});
		},
		writable: false
	});

	Object.defineProperty(publicObject, 'stopStreamSignal', {
		value: (callback) => {
			publicObject.off('signal', callback);
			readyToStream.delete(wid);
		},
		writable: false
	});

	eventObject.createEvent('signalStream', {
		// TODO Should be possible to add multiple callbacks to each wid, so the structure should be
		// Map<<wid>, Set<callback>>.
		// TODO: Also note that since we don't trigger the signalStream event at all through the
		// nodeObjects module, we could add some optmization here, so the callbacks aren't actually
		// added to nodeObjects.
		addListener: (callback) => {
			listeningForStreams.set(wid, callback);
			signaling.subscribe(wid);
			publicObject.signal({
				__internal_webrtc: 'offerRequest'
			});
		},
		removeListener: (callback) => {
			signaling.unsubscribe(wid);
			listeningForStreams.delete(wid);
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