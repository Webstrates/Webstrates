'use strict';
const coreEvents = require('./coreEvents');
const globalObject = require('./globalObject');
const coreDatabase = require('./coreDatabase');

let resolves = [];

// Defines the `dataSaved` event on the webstrate object. A call to this function retunrs a promise
// that will get resolved once all ops have been successfully been received by the server and
// submitted to the database.
Object.defineProperty(globalObject.publicObject, 'dataSaved', {
	get: () => () => new Promise((accept, reject) => {
		//Make sure that any mutations are actually picked up by mutation observers.
		//As dataSaved() might be called in same Task as the mutation introducing code.
		setTimeout(()=>{
			// If there are no pending operations (i.e. ops the server is yet to acknowledge), resolve
			// immediately.
			if (!coreDatabase.getDocument().hasPending()) accept();
			// Otherwise, add the promise's accept resolver to a list, so we can resolve it once the
			// pending operations have been acknowledged.
			else resolves.push(accept);
		},0);
	}),
	set: () => { throw new Error('dataSaved cannot be overwritten'); },
	enumerable: true
});

// Listen for opsAcknowledged event (created by coreDatabase), then trigger all listeners and remove
// them. We don't want to trigger these promises multiple times.
coreEvents.addEventListener('opsAcknowledged', () => {
	resolves.forEach(accept => accept());
	resolves = [];
}, coreEvents.PRIORITY.LAST);