'use strict';

const util = require('util');
const shortId = require('shortid');
const redis = require('redis');
const documentManager = require(global.APP_PATH + '/helpers/DocumentManager.js');

const pubsub = global.config.pubsub && {
	publisher: redis.createClient(global.config.pubsub),
	subscriber: redis.createClient(global.config.pubsub)
};

var PUBSUB_CHANNEL = 'webstratesPermissions';
var authConfig = global.config.auth;

var accessTokens = {};
var permissionsCache = {};
var timeToLive = authConfig && authConfig.permissionTimeout || 120;
var defaultPermissionsList = authConfig && authConfig.defaultPermissions;

// Listen for events happening on other server instances. This is only used when using multi-
// threading and Redis.
if (pubsub) {
	pubsub.subscriber.subscribe(PUBSUB_CHANNEL);
	pubsub.subscriber.on('message', function(channel, message) {
		message = JSON.parse(message);

		// Ignore messages from ourselves.
		if (message.WORKER_ID === WORKER_ID) {
			return;
		}

		switch (message.action) {
			case 'invalidateCachedPermissions':
				module.exports.invalidateCachedPermissions(message.webstrateId);
				break;
			case 'saveAccessToken':
				saveAccessToken(message.webstrateId, message.token, message.username,
					message.provider, message.expiration, false);
				break;
			case 'expireAccessToken':
				module.exports.expireAccessToken(message.webstrateId, message.token, false);
				break;
			case 'expireAllAccessTokens':
				module.exports.expireAllAccessTokens(message.webstrateId, false);
				break;
			default:
				console.warn('Unknown action', message);
		}
	});
}

/**
 * Determines whether a user is allowed to create a webstrate.
 * @param  {Object} user User object (retrieved from the request object).
 * @return {boolean}     True if allowed to create a webstrate, false otherwise.
 * @public
 */
module.exports.userIsAllowedToCreateWebstrate = (user) => {
	// All users are allowed.
	if (!config.loggedInToCreateWebstrates) return true;

	// If not all users are allowed, and the user isn't logged in.
	if (user.provider === '') return false;

	// If loggedInToCreateWebstrates is set to an array, the provider must be in the array to be
	// allowed to create a webstrate.
	if (Array.isArray(config.loggedInToCreateWebstrates)
		&& !config.loggedInToCreateWebstrates.includes(user.provider))
		return false;

	// Otherwise, if loggedInToCreateWebstrates is just a boolean, any logged in user is allowed to
	// create a webstrate.
	return true;
};

/**
 * Get user object from access token.
 * @param  {string} webstrateId WebstrateId
 * @param  {string} token       Access token.
 * @return {mixed}              User object containing username and provider.
 * @public
 */
module.exports.getUserFromAccessToken = function(webstrateId, token) {
	if (!accessTokens[webstrateId] || !accessTokens[webstrateId][token]) {
		return;
	}

	var { username, provider, expiration } = accessTokens[webstrateId][token];

	if (expiration <= Date.now()/1000) {
		delete accessTokens[webstrateId][token];
		return;
	}

	return { username, provider, userId: username + ':' + provider };
};

/**
 * Generate access token and save it.
 * @param {req} req Request object.
 * @param {res} res Request object.
 * @public
 */
module.exports.generateAccessToken = function(req, res) {
	// Don't allow users accessing with a token to generate another token.
	if (req.user.token) {
		return res.status(403).send('Insufficient permission. Cannot generate access token from ' +
		'token-based access (cannot generate tokens using tokens).');
	}
	var duration = Number(req.body.token) > 0 ? Number(req.body.token) : 300;
	var webstrateId = req.webstrateId;
	var username = req.user.username;
	var provider = req.user.provider;

	var token = shortId.generate();
	var expiration = (Date.now()/1000|0) + duration;

	saveAccessToken(webstrateId, token, username, provider, expiration, true);

	res.json({ webstrateId, username, provider, token, expiration });
};

/**
 * Save access token and broadcast through publish/subscribe.
 * @param {[type]} webstrateId WebstrateId.
 * @param {string} token       Access token.
 * @param {string} username    Username.
 * @param {string} provider    Provider.
 * @param {Date} expiration    Expiration date.
 * @param {bool}   local       Whether the invalidation happened locally (on this server instance)
 *                             or remotely (on another server instance). We should only forward
 *                             local cache invalidation requests, otherwise we end up in a
 *                             livelock where we continuously send the same request back and forth
 *                             between instances.
 * @private
 */
function saveAccessToken(webstrateId, token, username, provider, expiration, local) {
	if (!accessTokens[webstrateId]) {
		accessTokens[webstrateId] = {};
	}

	accessTokens[webstrateId][token] = { username, provider, expiration };

	if (local && pubsub) {
		pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
			action: 'saveAccessToken', webstrateId, token, username, provider, expiration, WORKER_ID
		}));
	}

	// Also clean up expired tokens. This happens async. No need to make the user wait.
	setImmediate(cleanUpExpiredTokens);
}

/**
 * Run through all tokens and remove expired ones.
 * @private
 */
function cleanUpExpiredTokens() {
	var now = Date.now()/1000;
	for (var webstrateId in accessTokens) {
		for (var token in accessTokens[webstrateId]) {
			if (accessTokens[webstrateId][token].expiration <= now) {
				delete accessTokens[webstrateId][token];
			}
		}
	}
}

/**
 * Return a list of access tokens for a specific webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @return {mixed}              List of access tokens.
 * @public
 */
module.exports.getAccessTokens = function(webstrateId) {
	cleanUpExpiredTokens();
	return accessTokens[webstrateId];
};

/**
 * Expire an access token.
 * @param {[type]} webstrateId WebstrateId.
 * @param {string} token       Access token.
 * @param {bool}   local       Whether the invalidation happened locally (on this server instance)
 *                             or remotely (on another server instance). We should only forward
 *                             local cache invalidation requests, otherwise we end up in a
 *                             livelock where we continuously send the same request back and forth
 *                             between instances.
 * @public
 */
module.exports.expireAccessToken = function(webstrateId, token, local) {
	if (accessTokens[webstrateId]) {
		delete accessTokens[webstrateId][token];
	}

	// Even if the access token doesn't exist locally, we still publish it to the other instances.
	// A clever timing attack could otherwise make it difficult to expire an access token.
	if (local && pubsub) {
		pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
			action: 'expireAccessToken', webstrateId, token, WORKER_ID
		}));
	}
};

/**
 * Expire all access token.
 * @param {[type]} webstrateId WebstrateId.
 * @param {bool}   local       Whether the invalidation happened locally (on this server instance)
 *                             or remotely (on another server instance). We should only forward
 *                             local cache invalidation requests, otherwise we end up in a
 *                             livelock where we continuously send the same request back and forth
 *                             between instances.
 * @public
 */
module.exports.expireAllAccessTokens = function(webstrateId, local) {
	delete accessTokens[webstrateId];

	if (local && pubsub) {
		pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
			action: 'expireAllAccessTokens', webstrateId, WORKER_ID
		}));
	}
};

/**
 * Get a user's permissions for a specific webstrateId.
 * @param  {string}   username    Username.
 * @param  {string}   provider    Login provider (GitHub, Facebook, OAuth, ...).
 * @param  {string}   webstrateId WebstrateId.
 * @param  {Function} next        Callback.
 * @return {mixed}                (async) Error, Document permissions (r, rw).
 * @public
 */
module.exports.getUserPermissions = async function(username, provider, webstrateId) {
	if (!webstrateId) {
		throw new Error('Missing webstrateId');
	}

	let permissions = getCachedPermissions(username, provider, webstrateId);
	if (permissions) {
		return permissions;
	}

	const snapshot = await util.promisify(documentManager.getDocument)({ webstrateId });
	permissions = await module.exports.getUserPermissionsFromSnapshot(username, provider,
		snapshot);

	setCachedPermissions(username, provider, permissions, snapshot.id);
	return permissions;
};

/**
 * Get all permissions from a webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @return {[type]}             List of permissions from webstrate.
 * @private
 */
async function getPermissions(webstrateId) {
	const snapshot = await util.promisify(documentManager.getDocument)({ webstrateId });
	return await module.exports.getPermissionsFromSnapshot(snapshot, false);
}

/**
 * Whether a user in the permissions list has the 'a' (admin) flag set, in which case any changes
 * made to the permissions list (data-auth property on the HTML element) has to be made by an admin.
 * I.e. a user with the regular `w` write permission will be unable.
 * @param  {string} webstrateId WebstrateId.
 * @return {bool}               Whether a user with the `a` property exists.
 * @public
 */
module.exports.webstrateHasAdmin = async (webstrateId) => {
	const permissions = await getPermissions(webstrateId);
	if (!permissions) return false;

	return permissions.some(permissionObject =>
		permissionObject.permissions && permissionObject.permissions.includes('a'));
};

/**
 * Get a user's permissions for a specific snapshot.
 * @param  {string} username Username.
 * @param  {string} provider Login provider (GitHub, Facebook, OAuth, ...).
 * @param  {JsonML} snapshot ShareDB document snapshot.
 * @return {string}          Document permissions (r, rw).
 * @public
 */
module.exports.getUserPermissionsFromSnapshot = async (username, provider, snapshot) => {
	const permissionsList = await module.exports.getPermissionsFromSnapshot(snapshot);

	// If there's also no default permissions, we pretend every user has read-write permissions
	// lest we lock everybody out. We append a question mark to let the system know that these are
	// last-resort permissions.
	if (!permissionsList) {
		return 'rw?';
	}

	return getUserPermissionsFromPermissionsList(username, provider, permissionsList);
};

const ALLOWED_RECURSIVE_INHERITANCES = 3;
/**
 * Get all permissions from a specific snapshot.
 * @param  {JsonML} snapshot              ShareDB document snapshot.
 * @param  {bool}   useDefaultPermissions Whether to return default permissions or not if no
 *                                        permissions were found. true uses defaultPermissions.
 * @param {integer} recursionCount        If webstrate X inherits permissions from webstrate Y, and
 *                                        Y inherits from X, we'll end up in an infinite loop. So
 *                                        we set a limit of how many recursive inheritances we
 *                                        allow.
 * @return {array}                        Permissions list.
 * @public
 */
module.exports.getPermissionsFromSnapshot = async function(snapshot, useDefaultPermissions = true,
	recursionCount = 0) {
	var permissionsList;

	if (snapshot && snapshot.data && snapshot.data[0] && snapshot.data[0] === 'html' &&
		snapshot.data[1] && snapshot.data[1]['data-auth']) {
		try {
			permissionsList = JSON.parse(snapshot.data[1]['data-auth'].replace(/'/g, '"')
				.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
		} catch (err) {
			console.warn('Couldn\'t parse document permissions for', snapshot.id);
			// We don't have to do anything. No valid document permissions.
		}

		// We allow a certain number of recursive permission inheritances, i.e. webstrate X inheriting
		// permissions from Y, inheriting from Z, and so forth. If this is exceeded, we ignore the
		// "deeper" permissions (and also log a warning on the server).
		if (recursionCount > ALLOWED_RECURSIVE_INHERITANCES) {
			console.warn('Too many recursive inheritances in', snapshot.id);
			return permissionsList;
		}

		// Add all permissions to permissionsList by side effect. This is faster than creating new
		// arrays and copying stuff around.
		await getInheritedPermissions(permissionsList, recursionCount + 1);

		return permissionsList;
	}

	// If we found no permissions, return default permissions, unless specified otherwise.
	if (useDefaultPermissions && (!Array.isArray(permissionsList) || Object.keys(permissionsList).length === 0)) {
		return useDefaultPermissions ? defaultPermissionsList : undefined;
	}

	return undefined;
};

async function getInheritedPermissions(permissionsList, recursionCount) {

	const inheritWebstrateIds = permissionsList.filter(o => o.webstrateId !== undefined);

	// We do this "the slow way", i.e. not async/parallel, because somebody could otherwise easily
	// DoS the server by forcing the server to fill up the memory with huge webstrate documents all
	// at the same time.
	// We expand the permissionsList in the loop, but we only iterate to the initial length, so we
	// don't end up in a potential infinite loop if there are mutual recursions between webstrates.
	for (let i = 0, l = permissionsList.length; i < l; ++i) {
		const webstrateId = permissionsList[i].webstrateId;
		if (webstrateId) {
			const snapshot = await util.promisify(documentManager.getDocument)({ webstrateId });
			const otherPermissionList = await module.exports.getPermissionsFromSnapshot(snapshot,
				false, recursionCount);

			// We don't want admin permissions to be inherited, so we remove the 'a' flag.
			otherPermissionList.forEach(o => o.permissions = o.permissions.replace(/a/i, ''));

			// Add all inherited permissions to the passed-in permissions list.
			permissionsList.push(...otherPermissionList);
		}
	}
	// We update permisisonsList above by side effects, but we return it anyway for good measure.
	return permissionsList;
}

/**
 * Get a user's default permission.
 * @param  {string} username Username.
 * @param  {string} provider Login provider (Github, Facebook, OAuth, ...).
 * @return {string}          Permissions (r, rw).
 * @public
 */
module.exports.getDefaultPermissions = function(username, provider) {
	return getUserPermissionsFromPermissionsList(username, provider, defaultPermissionsList);
};

/**
 * Add permissions for a username and provider to a webstrate with the given webstrateId. If the
 * user already has the permissions (either explicitly or through default permissions), nothing
 * is done.
 * @param {string}   username    Username.
 * @param {string}   provider    Login provider (Github, Facebook, OAuth, ...).
 * @param {string}   permissions Permissions (r, rw).
 * @param {string}   webstrateId WebstrateId.
 * @param {string}   source      An identifier for who made the op (added the permissions). source
 *                               is usually the client's websocket connection id, but since we
 *                               don't have a one here, it should just be a userId.
 * @param {Function} next        Callback.
 * @public
 * TODO: THIS SEEMS UNUSED, DELETE?
 */
module.exports.addPermissions = async function(username, provider, permissions, webstrateId, source,
	next) {
	let snapshot = await util.promisify(documentManager.getDocument)({ webstrateId });

	if (!snapshot || !snapshot.data || !snapshot.data[0] || snapshot.data[0] !== 'html' ||
		typeof snapshot.data[1] !== 'object') {
		return next(new Error('Invalid document'));
	}

	var oldPermissions = snapshot.data[1]['data-auth'];
	snapshot = await module.exports.addPermissionsToSnapshot(username, provider, permissions,
		snapshot);
	var newPermissions = snapshot.data[1]['data-auth'];

	var op = {
		p: [1, 'data-auth'],
		od: oldPermissions,
		oi: newPermissions
	};

	documentManager.submitOp(webstrateId, op, source, next);
};

module.exports.addPermissionsToSnapshot = async function(username, provider, permissions,
	snapshot) {
	const currentPermissions = await module.exports.getUserPermissionsFromSnapshot(username, provider,
		snapshot);
	if (currentPermissions === permissions) {
		return snapshot;
	}

	const permissionsList = await module.exports.getPermissionsFromSnapshot(snapshot, false) || [];

	// Find index of the user's current permissions
	const userIdx = permissionsList.findIndex(user =>
		user.username === username && user.provider === provider);

	const user = { username, provider, permissions };

	// If the user currently has no permissions, we add the new permissions, or otherwise modifies
	// the existing permissions.
	if (userIdx === -1) {
		permissionsList.push(user);
	} else {
		permissionsList[userIdx] = user;
	}

	snapshot.data[1]['data-auth'] = JSON.stringify(permissionsList);
	return snapshot;
};

/**
 * Remove all permissions from snapshot.
 * @param  {JsonML} snapshot ShareDB document snapshot.
 * @return {string}          ShareDB document snapshot without permissions.
 */
module.exports.clearPermissionsFromSnapshot = function(snapshot) {
	delete snapshot.data[1]['data-auth'];
	return snapshot;
};

/**
 * Remove admin permissions from snapshot.
 * @param  {JsonML} snapshot ShareDB document snapshot.
 * @return {string}          ShareDB document snapshot without admin permissions.
 */
module.exports.removeAdminPermissionsFromSnapshot = async function(snapshot) {
	const permissionsList = await module.exports.getPermissionsFromSnapshot(snapshot, false);

	if (permissionsList) {
		permissionsList.forEach(user => user.permissions = user.permissions.replace(/a/gi, ''));
		snapshot.data[1]['data-auth'] = JSON.stringify(permissionsList);
	}

	return snapshot;
};

/**
 * Deletes all caches for a specific webstrate.
 * @param {string} webstrateId WebstrateId.
 * @param {bool}   local       Whether the invalidation happened locally (on this server instance)
 *                             or remotely (on another server instance). We should only forward
 *                             local cache invalidation requests, otherwise we end up in a
 *                             livelock where we continuously send the same request back and forth
 *                             between instances.
 * @public
 */
module.exports.invalidateCachedPermissions = function(webstrateId, local) {
	delete permissionsCache[webstrateId];

	if (local && pubsub) {
		pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
			action: 'invalidateCachedPermissions', webstrateId, WORKER_ID
		}));
	}
};

/**
 * Extract a user's permissions from a permissions list.
 * @param  {string} username        Username.
 * @param  {string} provider        Login provider (Github, Facebook, OAuth, ...).
 * @param  {list} permissionsList   Permissions List.
 * @return {string}                 Document permissions (r, rw).
 * @private
 */
function getUserPermissionsFromPermissionsList(username, provider, permissionsList) {
	const user = permissionsList.find(user =>
		user.username === username && user.provider === provider);

	if (user) {
		return user.permissions;
	}

	const anonymous = permissionsList.find(user =>
		user.username === 'anonymous' && user.provider === '');

	return anonymous ? anonymous.permissions : '';
}

/**
 * Get cached permissions.
 * @param  {string} username Username.
 * @param  {string} provider Provider.
 * @return {string}          WebstrateId.
 * @private
 */
function getCachedPermissions(username, provider, webstrateId) {
	if (!permissionsCache[webstrateId]) {
		return null;
	}

	var cacheEntry = permissionsCache[webstrateId][username + ':' + provider];
	if (!cacheEntry) {
		return null;
	}

	var [permissions, cacheTime] = cacheEntry;
	var currentTime = Date.now() / 1000 | 0;
	if (currentTime - cacheTime > timeToLive) {
		return null;
	}

	return permissions;
}

/**
 * Set cached permissions.
 * @param  {string} username    Username.
 * @param  {string} provider    Provider.
 * @param  {string} permissions Permissions.
 * @return {string}             WebstrateId.
 * @private
 */
function setCachedPermissions(username, provider, permissions, webstrateId) {
	if (!permissionsCache[webstrateId]) {
		permissionsCache[webstrateId] = {};
	}

	var currentTime = Date.now() / 1000 | 0;
	permissionsCache[webstrateId][username + ':' + provider] = [permissions, currentTime];
}