'use strict';

// Stub for sharedb/lib/client/presence/presence.js.
//
// Webstrates bundles sharedb's client, but never uses its real-time presence
// subsystem — there is no getPresence()/getDocPresence()/create() call
// anywhere in client/. The real implementation drags the entire `async`
// library plus a dozen presence modules into the bundle (~34 KiB minified),
// for a feature no Webstrates document can reach. webpack.config.js aliases
// the presence requires onto these stubs instead
//
// The stub satisfies everything Connection does with the class — construct it,
// read `.channel`, flip `_wantsDestroy`, and call back into the internal
// message handlers — so sharedb "thinks" it has presence. The public API
// throws instead of silently doing nothing, so any future use fails loudly.
function Presence(connection, channel) {
	this.connection = connection;
	this.channel = channel;
	this.localPresences = Object.create(null);
	this.remotePresences = Object.create(null);
}

module.exports = Presence;

Presence.prototype.subscribe = function() {
	throw new Error('ShareDB presence is stubbed out of the Webstrates client build ' +
		'(see client/shims/): this build does not ship the presence subsystem.');
};

Presence.prototype.unsubscribe = Presence.prototype.subscribe;
Presence.prototype.create = Presence.prototype.subscribe;
Presence.prototype.destroy = Presence.prototype.subscribe;

// Internal message/protocol handlers. They only ever run for presences
// registered on the connection, which cannot happen with the public API
// throwing above — so they exist merely to keep the class interface complete.
Presence.prototype._handleSubscribe = function() {};
Presence.prototype._handleUnsubscribe = function() {};
Presence.prototype._receiveUpdate = function() {};
Presence.prototype._broadcastAllLocalPresence = function() {};
Presence.prototype._onConnectionStateChanged = function() {};
