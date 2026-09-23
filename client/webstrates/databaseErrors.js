'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
const corePathTree = require('./corePathTree');

// Create events in userland.
globalObject.createEvent('editingError');

coreEvents.addEventListener('databaseError', error => {
	if (error.data.a !== 'op') return;
	error.data.op.forEach(op => {
		// Wire-only ops (the leak-recovery sr markers) carry no json0 path,
		// and a path-less op would crash elementAtPath below — taking the
		// rest of the batch's editingError fan-out with it. They still get
		// an event (type only, no parent), like every other op.
		if (!op || !Array.isArray(op.p)) {
			const type = op && ['si', 'sd', 'oi', 'od', 'li', 'ld', '__wireOnly']
				.find(type => type in op);
			globalObject.triggerEvent('editingError', type, null);
			return;
		}
		const [,, parentElement] = corePathTree.elementAtPath(document.documentElement, op.p);
		let type = ['si', 'sd', 'oi', 'od', 'li', 'ld'].find(type => type in op);
		globalObject.triggerEvent('editingError', type, parentElement);
	});
});