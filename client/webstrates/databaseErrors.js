'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
const corePathTree = require('./corePathTree');

// Create events in userland.
globalObject.createEvent('editingError');

coreEvents.addEventListener('databaseError', error => {
	// Not every database error carries a payload: an error thrown while applying an op
	// locally (e.g. a TypeError from the OT library on a bad path) reaches us as the
	// bare error object with no .data at all. Reading error.data.a unconditionally
	// would crash here and mask the actual error.
	if (!error || !error.data || error.data.a !== 'op') return;
	if (!Array.isArray(error.data.op)) return;
	error.data.op.forEach(op => {
		const [,, parentElement] = corePathTree.elementAtPath(document.documentElement, op.p);
		let type = ['si', 'sd', 'oi', 'od', 'li', 'ld'].find(type => type in op);
		globalObject.triggerEvent('editingError', type, parentElement);
	});
});