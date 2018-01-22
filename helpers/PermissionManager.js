'use strict';

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
var timeToLive = authConfig && authConfig.permissionTimeout || 300;
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

	return { username, provider };
};

/**
 * Generate access token and save it.
 * @param {req} req Request object.
 * @param {res} res Request object.
 * @public
 */
module.exports.generateAccessToken = function(req, res) {
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
 */
module.exports.expireAccessToken = function(webstrateId, token, local) {
	if (accessTokens[webstrateId]) {
		accessTokens[webstrateId][token];
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
module.exports.getUserPermissions = function(username, provider, webstrateId, next) {
	if (!webstrateId) {
		return next(new Error('Missing webstrateId'), null);
	}

	var permissions = getCachedPermissions(username, provider, webstrateId);
	if (permissions) {
		return next(null, permissions);
	}

	documentManager.getDocument({ webstrateId }, function(err, snapshot) {
		if (err) {
			return next(err);
		}

		var permissions = module.exports.getUserPermissionsFromSnapshot(username, provider, snapshot);
		setCachedPermissions(username, provider, permissions, snapshot.id);
		next(null, permissions);
	});
};

/**
 * Get a user's permissions for a specific snapshot.
 * @param  {string} username Username.
 * @param  {string} provider Login provider (GitHub, Facebook, OAuth, ...).
 * @param  {JsonML} snapshot ShareDB document snapshot.
 * @return {string}          Document permissions (r, rw).
 * @public
 */
module.exports.getUserPermissionsFromSnapshot = function(username, provider, snapshot) {
	var permissionsList = module.exports.getPermissionsFromSnapshot(snapshot);

	// If there's also no default permissions, we pretend every user has read-write permissions
	// lest we lock everybody out. We append a question mark to let the system know that these are
	// last-resort permissions.
	if (!permissionsList) {
		return 'rw?';
	}

	return getUserPermissionsFromPermissionsList(username, provider, permissionsList);
};

/**
 * Get all permissions from a specific snapshot.
 * @param  {JsonML} snapshot              ShareDB document snapshot.
 * @param  {bool}   useDefaultPermissions Whether to return default permissions or not if no
 *                                        permissions were found. true uses defaultPermissions.
 * @return {array}                       Permissions list.
 * @public
 */
module.exports.getPermissionsFromSnapshot = function(snapshot, useDefaultPermissions = true) {
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

		// If we found permissions, return them.
		if (Array.isArray(permissionsList) && Object.keys(permissionsList).length > 0) {
			return permissionsList;
		}
	}

	if (useDefaultPermissions) {
		return defaultPermissionsList;
	}

	return undefined;
};

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
 */
module.exports.addPermissions = function(username, provider, permissions, webstrateId, source,
	next) {
	documentManager.getDocument({ webstrateId }, function(err, snapshot) {
		if (err) {
			return next(err);
		}

		if (!snapshot || !snapshot.data || !snapshot.data[0] || snapshot.data[0] !== 'html' ||
			typeof snapshot.data[1] !== 'object') {
			return next(new Error('Invalid document'));
		}

		var oldPermissions = snapshot.data[1]['data-auth'];
		snapshot = module.exports.addPermissionsToSnapshot(username, provider, permissions, snapshot);
		var newPermissions = snapshot.data[1]['data-auth'];

		var op = {
			p: [1, 'data-auth'],
			od: oldPermissions,
			oi: newPermissions
		};

		documentManager.submitOp(webstrateId, op, source, next);
	});
};

module.exports.addPermissionsToSnapshot = function(username, provider, permissions, snapshot) {
	var currentPermissions = module.exports.getUserPermissionsFromSnapshot(username, provider,
		snapshot);
	if (currentPermissions === permissions) {
		return snapshot;
	}

	var permissionsList = module.exports.getPermissionsFromSnapshot(snapshot, false) || [];

	// Find index of the user's current permissions
	var userIdx = permissionsList.findIndex(user =>
		user.username === username && user.provider === provider);

	var user = { username, provider, permissions };

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
 * Remove all permissions from snapshot
 * @param  {JsonML} snapshot ShareDB document snapshot.
 * @return {string}          ShareDB document snapshot without permissions.
 */
module.exports.clearPermissionsFromSnapshot = function(snapshot) {
	delete snapshot.data[1]['data-auth'];
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