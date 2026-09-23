'use strict';
const coreEvents = require('./webstrates/coreEvents');
const coreDOM = require('./webstrates/coreDOM');
const coreDatabase = require('./webstrates/coreDatabase');
const coreMutation = require('./webstrates/coreMutation');
const coreOpApplier = require('./webstrates/coreOpApplier');
const coreOpCreator = require('./webstrates/coreOpCreator');
const corePopulator = require('./webstrates/corePopulator');
const coreUtils = require('./webstrates/coreUtils');
const coreWebsocket = require('./webstrates/coreWebsocket');

// Create an event that'll be triggered once all modules have been loaded.
coreEvents.createEvent('allModulesLoaded');

const request = coreUtils.getLocationObject();

const protocol = location.protocol === 'http:' ? 'ws:' : 'wss:';
coreWebsocket.setup(`${protocol}//${location.host}/${request.webstrateId}/${location.search}`);

// Load optional modules.
config.modules.forEach(module => require('./webstrates/' + module));

// Send out an event when all modules have been loaded.
coreEvents.triggerEvent('allModulesLoaded');

if (request.staticMode) {
	coreDatabase.fetch(request.webstrateId, request.tagOrVersion).then(doc => {
		corePopulator.populate(coreDOM.externalDocument, doc);
	}).catch(err => console.error('webstrates: static boot failed:', err));
}
else {
	coreDatabase.subscribe(request.webstrateId).then(doc => {

		//Start listening for ops, will get applied when setRootElement has been called
		coreOpApplier.listenForOps();

		corePopulator.populate(coreDOM.externalDocument, doc).then(() => {

			// Emits mutations from changes on the coreDOM.externalDocument.
			coreMutation.emitMutationsFrom(coreDOM.externalDocument);

			// Emits ops from the mutations emitted by coreMutation.
			coreOpCreator.emitOpsFromMutations();

			// Apply changes on <html>, not coreDOM.externalDocument. An adopted
			// (painted) page keeps the parsed doctype, so childNodes[0] would be
			// the doctype node — documentElement is the html element on every
			// population path.
			const targetElement = coreDOM.externalDocument.documentElement;
			coreOpApplier.setRootElement(targetElement);

			// Resync the adopted revision to the subscribed head (replaying
			// the commits in between), drain the frames buffered during
			// population, and let the commit queue pump.
			return coreDatabase.startLive();
		});
	}).catch(err => console.error('webstrates: boot failed:', err));
}