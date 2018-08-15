'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
const corePathTree = require('./corePathTree');

// Create events in userland.
globalObject.createEvent('editingError');

coreEvents.addEventListener('databaseError', error => {
	if (error.data.a !== 'op') return;
	error.data.op.forEach(op => {
		const [,, parentElement] = corePathTree.elementAtPath(document.documentElement, op.p);
		let type = ['si', 'sd', 'oi', 'od', 'li', 'ld'].find(type => type in op);
		globalObject.triggerEvent('editingError', type, parentElement);
	});
});