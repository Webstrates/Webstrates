'use strict';

// Stub for sharedb/lib/client/presence/doc-presence-emitter.js.
//
// Connection constructs one of these in its constructor and never touches it
// again — it is the event hub through which doc-presences would observe each
// other. With doc-presence stubbed (see client/shims/presence.js), nothing
// can ever register, so both methods are no-ops. Kept as a class only so the
// `new DocPresenceEmitter()` call in sharedb's connection.js keeps working.
function DocPresenceEmitter() {}

module.exports = DocPresenceEmitter;

DocPresenceEmitter.prototype.addEventListener = function() {};
DocPresenceEmitter.prototype.removeEventListener = function() {};
