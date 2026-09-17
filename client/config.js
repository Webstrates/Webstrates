module.exports = {
	VERBOSE_MODE: false,
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
	// Supports selector syntax, i.e. 'div.not-persisted' to not persist all DIV elements with the
	// class 'not-persisted'. Only elements can match a selector, so any other node type (text
	// and comment nodes) is never transient here — protected mode relies on this to be able to
	// pass comment nodes through to this function without it throwing.
	isTransientElement: (DOMNode) => DOMNode.nodeType === Node.ELEMENT_NODE
		&& DOMNode.matches('transient'),
	// Any attributeName starting with 'transient-' should be transient.
	isTransientAttribute: (DOMNode, attributeName) => attributeName.startsWith('transient-'),
	// Peer Connection configuration used for the WebRTC-based signal streaming.
	peerConnectionConfig: {
		'iceServers': [
			{ urls: 'stun:stun.services.mozilla.com' },
			{ urls: 'stun:stun.l.google.com:19302' }
		]
	}
};
