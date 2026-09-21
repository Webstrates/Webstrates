'use strict';

// Stub for sharedb/lib/client/presence/doc-presence.js.
//
// Mirrors the real class's shape (see client/shims/presence.js for why the
// presence subsystem is stubbed): same constructor signature, same
// `DocPresence.channel(collection, id)` channel format, same prototype chain
// off Presence — but the inherited public methods throw, so no doc-presence
// can ever be subscribed. Keeping the static channel() method matters: the
// real Connection.getDocPresence() uses it to derive the channel key before
// constructing the instance, and it must never be the source of a collision.
var Presence = require('./presence');

function DocPresence(connection, collection, id) {
	var channel = DocPresence.channel(collection, id);
	Presence.call(this, connection, channel);
	this.collection = collection;
	this.id = id;
}

module.exports = DocPresence;

DocPresence.prototype = Object.create(Presence.prototype);

DocPresence.channel = function(collection, id) {
	return collection + '.' + id;
};
