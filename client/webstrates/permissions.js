'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');
const userObject = require('./userObject');
const loadedEvent = require('./loadedEvent');

const permissionsModule = {};
const webstrateId = coreUtils.getLocationObject().webstrateId;

// In static mode, the user does not receive the permissions. Since the webstrate doesn't change,
// it also doesn't make sense to listen for permission changes, so we don't do that either.
if (!coreUtils.getLocationObject().staticMode) {
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

	Object.defineProperty(userObject.publicObject, 'permissions', {
		get: () => userPermissions,
		set: (v) => { throw new Error('Permissions must be changed through the data-auth attribute'); },
		enumerable: true
	});

	Object.defineProperty(globalObject.publicObject, 'permissions', {
		get: () => permissionsList,
		set: (v) => { throw new Error('Permissions must be changed through the data-auth attribute'); },
		enumerable: true
	});

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

		const user = activePermissionList.find(user =>
			user.username === username && user.provider === provider);

		if (user) {
			return user.permissions;
		}

		const anonymous = activePermissionList.find(user =>
			user.username === 'anonymous' && user.provider === '');

		return anonymous ? anonymous.permissions : '';
	};

	permissionsModule.getPermissionsFromDocument = doc => {
		if (doc && doc.data && doc.data[0] && doc.data[0] === 'html' &&
		doc.data[1] && doc.data[1]['data-auth']) {
			try {
				const permissions = JSON.parse(doc.data[1]['data-auth'].replace(/'/g, '"')
					.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

				if (!Array.isArray(permissions)) {
					console.warn('Couldn\'t parse document permissions - expected an array.');
					return [];
				}
				return permissions;

			} catch (err) {
				console.warn('Couldn\'t parse document permission - malformed.');
			}
		}
		return [];
	};

	/*
 * We need both doc, username, provider, permissionsList and defaultPermissionsList to be set before
 * we can emit permission events, so we create two promises, and wait until both have been resolved.
 */
	let receivedDocumentPromise = new Promise((accept) => {
		coreEvents.addEventListener('receivedDocument', _doc => {
			doc = _doc;
			permissionsList = permissionsModule.getPermissionsFromDocument(doc);
			coreEvents.triggerEvent('globalPermissions', permissionsList);
			userPermissions = permissionsModule.getUserPermissions(username, provider);
			coreEvents.triggerEvent('userPermissions', userPermissions);
			accept();
		});
	});

	let helloMessageReceivedPromise = new Promise((accept) => {
		websocket.onjsonmessage = (message) => {
			if (message.wa === 'hello' && message.d === webstrateId) {
				username = message.user.username;
				provider = message.user.provider;
				defaultPermissionsList = message.defaultPermissions;
				accept();
			}
		};
	});

	/**
	 * Identifies whether a set operations modify the permissions of a webstrate.
	 * @param  {[ops]} ops   List of operations.
	 * @return {bool}     True if ops modify permissions, false otherwise.
	 * @private
	 */
	const permissionsChanged = (ops) =>
		ops.some(op => op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === 'data-auth');

	/**
	 * Recalculates permissions and trigger permission events if permissions have changed.
	 * @param  {[ops]} ops List of operations.
	 * @private
	 */
	const handleOps = (ops) => {
		if (!permissionsChanged(ops)) return;

		let oldPermissionsList = permissionsList;
		permissionsList = permissionsModule.getPermissionsFromDocument(doc);
		coreEvents.triggerEvent('globalPermissions', permissionsList);
		globalObject.triggerEvent('permissionsChanged', permissionsList, oldPermissionsList);
		const newUserPermissions = permissionsModule.getUserPermissions(username, provider);
		if (!coreUtils.objectEquals(userPermissions, newUserPermissions)) {
			userPermissions = newUserPermissions;
			coreEvents.triggerEvent('userPermissions', userPermissions);
		}
	};

	Promise.all([receivedDocumentPromise, helloMessageReceivedPromise]).then(() => {
		coreEvents.addEventListener('receivedOps', handleOps);
		coreEvents.addEventListener('createdOps', handleOps);
	});

}
module.exports = permissionsModule;