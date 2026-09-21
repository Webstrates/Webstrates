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
		&& (DOMNode.matches('transient, [transient]')
			// Element names that cannot survive HTML serialization (the tokenizer
			// requires an ASCII-letter start) could never ride the painted wire —
			// only DOM-API-created elements can carry them. (Foreign-content names
			// like 'linearGradient' or 'my-widget' all pass.)
			|| !/^[A-Za-z][A-Za-z0-9:_.-]*$/.test(DOMNode.tagName)),
	// Any attributeName starting with 'transient-' should be transient, and so should the
	// bare `transient` attribute itself: it is the element-transience marker, and letting
	// it synchronize onto persisted elements would desynchronize the JsonML from the path
	// tree on the next load (the element would arrive transient where the JsonML has it
	// persisted).
	//
	// The painted wire's transport-only names are transient for the same reason: `_`
	// carries the identity, data-webstrates-head marks the mirror <head_> element and
	// data-webstrates-type the un-neutered script type — a user attribute with one of
	// those names would collide with the transport and never survive a repaint. The
	// server rejects ops that set them (validOp); this keeps the client from ever
	// creating such an op in the first place. Attribute names with whitespace, quotes,
	// slashes, equals, control characters or no characters at all cannot be serialized
	// as HTML either.
	isTransientAttribute: (DOMNode, attributeName) => attributeName === 'transient'
		|| attributeName.startsWith('transient-')
		|| attributeName === '_'
		|| attributeName === 'data-webstrates-head'
		|| attributeName === 'data-webstrates-type'
		|| attributeName === ''
		|| /[\s"'=/>]/.test(attributeName)
		// Control characters cannot ride serialized HTML either. (The escape
		// sequence is exactly the point of this regex.)
		/* eslint-disable-next-line no-control-regex */
		|| /[\x00-\x1f]/.test(attributeName),
	// Peer Connection configuration used for the WebRTC-based signal streaming.
	peerConnectionConfig: {
		'iceServers': [
			{ urls: 'stun:stun.services.mozilla.com' },
			{ urls: 'stun:stun.l.google.com:19302' }
		]
	}
};
