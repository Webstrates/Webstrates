module.exports = {
	VERBOSE_MODE: false,
	modules: [
		'globalObject',
		'loadedEvent',
		'userObject',
		'cookies',
		'nodeObjects',
		'domEvents',
		'transclusionEvent',
		'connectionEvents',
		'permissions',
		'tagging',
		'clientManager',
		'signaling',
		'signalStream',
		'assets',
		'messages',
		'keepAlive'
	],
	// Reuse the parent's websocket when doing transclusion. Very experimental.
	reuseWebsocket: true,
	// Supports selector syntax, i.e. 'div.not-persisted' to not persist all DIV elements with the
	// class 'not-persisted'.
	isTransientElement: (DOMNode) => DOMNode.matches('transient'),
	// Any attributeName starting with 'transient-' should be transient.
	isTransientAttribute: (DOMNode, attributeName) => attributeName.startsWith('transient-'),
	// Keep alive message interval in seconds. A falsy value disabled the interval.
	keepAliveInterval: 55,
	// Peer Connection configuration used for the WebRTC-based signal streaming.
	peerConnectionConfig: {
		'iceServers': [
			{ url: 'stun:stun.services.mozilla.com' },
			{ url: 'stun:stun.l.google.com:19302' }
		]
	}
};