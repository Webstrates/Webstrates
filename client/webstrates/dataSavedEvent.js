'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');

let resolves = [];

// Defines the `dataSaved` event on the webstrate object. A call to this function retunrs a promise
// that will get resolved once all ops have been successfully been received by the server and
// submitted to the database.
Object.defineProperty(globalObject.publicObject, 'dataSaved', {
	get: () => () => new Promise((accept, reject) => resolves.push(accept)),
	set: () => { throw new Error('dataSaved cannot be overwritten'); },
	enumerable: true
});

// Listen for opsAcknowledged event (created by coreDatabase), then trigger all listeners and remove
// them. We don't want to trigger these promises multiple times.
coreEvents.addEventListener('opsAcknowledged', () => {
	resolves.forEach(accept => accept());
	resolves = [];
}, coreEvents.PRIORITY.LAST);