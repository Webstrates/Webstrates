'use strict';
const coreEvents = require('./webstrates/coreEvents');
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
coreWebsocket.setup(`${protocol}//${location.host}/ws/${location.search}`);

// Load optional modules.
config.modules.forEach(module => require('./webstrates/' + module));

// Send out an event when all modules have been loaded.
coreEvents.triggerEvent('allModulesLoaded');

if (request.staticMode) {
	coreDatabase.fetch(request.webstrateId, request.tagOrVersion).then(doc => {
		corePopulator.populate(document, doc);
	});
}
else {
	coreDatabase.subscribe(request.webstrateId).then(doc => {
		corePopulator.populate(document, doc).then(() => {
			// Emits mutations from changes on the document.
			coreMutation.emitMutationsFrom(document);

			// Emits ops from the mutations emitted by coreMutation.
			coreOpCreator.emitOpsFromMutations();

			// Apply changes on <html>, not document.
			const targetElement = document.childNodes[0];
			coreOpApplier.listenForOpsAndApplyOn(targetElement);
		});
	});
}