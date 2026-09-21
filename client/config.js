module.exports = {
	modules: [
		'globalObject',
		'loadedEvent',
		'userObject',
		'cookies',
		'nodeObjects',
		'protectedMode',
		'databaseErrors',
		'dataSavedEvent',
		'domEvents',
		'transclusionEvent',
		'connectionEvents',
		'permissions',
		'tagging',
		'clientManager',
		'newWebstrates',
		'signaling',
		'signalStream',
		'userObjectSignaling',
		'userHistory',
		'assets',
		'messages',
		'keepAlive'
	],
	// Reuse the parent's websocket when doing transclusion. Very experimental.
	reuseWebsocket: false,
	// Keep alive message interval in seconds. A falsy value disables keep alive.
	keepAliveInterval: 25,
	// An element is transient when it is a <transient> element or carries the `transient`
	// attribute (e.g. <div transient>), marking the entire element — and everything inside
	// it — as not persisted. Transience is evaluated when the element is inserted into the
	// document and when the document is populated: adding the `transient` attribute to an
	// already persisted element does not remove it from the snapshot (re-insert the element
	// to make it transient), which mirrors how <transient> elements always worked.
	// The document element itself can never be transient: it has to persist for the
	// document to exist at all, and a transient root would leave nothing to synchronize.
	//
	// The function also supports selector syntax, i.e. 'div.not-persisted' to not persist
	// all DIV elements with the class 'not-persisted'. Only elements can match a selector,
	// so any other node type (text and comment nodes) is never transient here — protected
	// mode relies on this to be able to pass comment nodes through to this function without
	// it throwing.
	isTransientElement: (DOMNode) => DOMNode.nodeType === Node.ELEMENT_NODE
		&& DOMNode !== document.documentElement
		&& DOMNode.matches('transient, [transient]'),
	// Any attributeName starting with 'transient-' should be transient, and so should the
	// bare `transient` attribute itself: it is the element-transience marker, and letting
	// it synchronize onto persisted elements would desynchronize the JsonML from the path
	// tree on the next load (the element would arrive transient where the JsonML has it
	// persisted).
	isTransientAttribute: (DOMNode, attributeName) => attributeName === 'transient'
		|| attributeName.startsWith('transient-'),
	// Peer Connection configuration used for the WebRTC-based signal streaming.
	peerConnectionConfig: {
		'iceServers': [
			{ urls: 'stun:stun.services.mozilla.com' },
			{ urls: 'stun:stun.l.google.com:19302' }
		]
	}
};
