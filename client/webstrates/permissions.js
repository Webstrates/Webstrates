'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const userObject = require('./userObject');
const loadedEvent = require('./loadedEvent');

const permissionsModule = {};

// Create internal events.
coreEvents.createEvent('globalPermissions');
coreEvents.createEvent('userPermissions');

// Create events for userland.
globalObject.createEvent('permissionsChanged');

// Delay the loaded event, until the 'globalPermissions' and 'userPermissions' events have been
// triggered.
loadedEvent.delayUntil('globalPermissions', 'userPermissions');

const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));
let doc, username, provider, userPermissions, defaultPermissionsList, permissionsList;

function detectPermissionChanges(ops) {
	const permissionsChanged = ops.some(op =>
		op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === 'data-auth');

	// If permissions have changed, we need to recalculate the user's permissions.
	if (permissionsChanged) {
		permissionsList = permissionsModule.getPermissionsFromDocument(doc);
		coreEvents.triggerEvent('globalPermissions', permissionsList);
		const newUserPermissions = permissionsModule.getUserPermissions(username, provider);
		if (!coreUtils.objectEquals(userPermissions, newUserPermissions)) {
			userPermissions = newUserPermissions;
			coreEvents.triggerevent('userPermissions', userPermissions);
		}
	}
}

permissionsModule.getUserPermissions = (username, provider) => {
	let activePermissionList = permissionsList;
	// If we found no permissions, resort to default permissions.
	if (!permissionsList || Object.keys(permissionsList).length === 0) {
		// If there's also no default permissions, we pretend every user has read-write permissions
		// lest we lock everybody out. We append a question mark to let the system know that these are
		// last-resort permissions.
		if (!defaultPermissionsList) {
			return 'rw?';
		}
		activePermissionList = defaultPermissionsList;
	}

	var user = activePermissionList.find(user =>
		user.username === username && user.provider === provider);

	if (user) {
		return user.permissions;
	}

	var anonymous = activePermissionList.find(user =>
		user.username === 'anonymous' && user.provider === '');

	return anonymous ? anonymous.permissions : '';
};

permissionsModule.getPermissionsFromDocument = (doc) => {
	if (doc && doc.data && doc.data[0] && doc.data[0] === 'html' &&
		doc.data[1] && doc.data[1]['data-auth']) {
		try {
			return JSON.parse(doc.data[1]['data-auth'].replace(/'/g, '"')
				.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
		} catch (err) {
			console.warn('Couldn\'t parse document permission');
		}
	}
	return [];
};

/*
 * We need both doc, username, provider, permissionsList and defaultPermissionsList to be set before
 * we can emit permission events, so we create two promises, and wait until both have been resolved.
 */
let receivedDocumentPromise = new Promise((accept) => {
	coreEvents.addEventListener('receivedDocument', (doc) => {
		permissionsList = permissionsModule.getPermissionsFromDocument(doc);
		if (!globalObject.publicObject) {
			throw new Error('Permissions loaded, but global webstrate object doesn\'t exist.');
		}
		globalObject.publicObject.permissions = permissionsList;
		coreEvents.triggerEvent('globalPermissions', permissionsList);
		accept();
	});
});

let helloMessageReceivedPromise = new Promise((accept) => {
	websocket.onjsonmessage = (message) => {
		if (message.wa === 'hello') {
			username = message.user.username;
			provider = message.user.provider;
			defaultPermissionsList = message.defaultPermissions;
			userPermissions = permissionsModule.getUserPermissions(username, provider);
			if (!globalObject.publicObject || !userObject.publicObject) {
				throw new Error('Permissions loaded, but global webstrate user object doesn\'t exist.');
			}
			userObject.publicObject.permissions = userPermissions;
			coreEvents.triggerEvent('userPermissions', userPermissions);
			accept();
		}
	};
});

Promise.all([receivedDocumentPromise, helloMessageReceivedPromise]).then(() => {
	coreEvents.addEventListener('receivedOps', detectPermissionChanges);
	coreEvents.addEventListener('createdOps', detectPermissionChanges);
});

module.exports = permissionsModule;