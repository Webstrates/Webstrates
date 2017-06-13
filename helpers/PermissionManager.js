"use strict";

/**
 * PermissionManager constructor.
 * @param {DocumentManager} documentManager DocumentManager instance.
 * @constructor
 */
module.exports = function(documentManager, pubsub) {
	var PUBSUB_CHANNEL = "webstratesPermissions";
	var module = {};
	var authConfig = global.config.auth;

	var permissionsCache = {};
	var timeToLive = authConfig ? authConfig.permissionTimeout : 300;
	var defaultPermissionsList = authConfig && authConfig.defaultPermissions;

	// Listen for events happening on other server instances. This is only used when using multi-
	// threading and Redis.
	if (pubsub) {
		pubsub.subscriber.subscribe(PUBSUB_CHANNEL);
		pubsub.subscriber.on("message", function(channel, message) {
			// Ignore messages on other channels.
			if (channel !== PUBSUB_CHANNEL) {
				return;
			}

			message = JSON.parse(message);

			// Ignore messages from ourselves.
			if (message.WORKER_ID === WORKER_ID) {
				return;
			}

			switch (message.action) {
				case "invalidateCachedPermissions":
					module.invalidateCachedPermissions(message.webstrateId);
					break;
				default:
					console.warn("Unknown action", message);
			}
		});
	}

	/**
	 * Get a user's permissions for a specific webstrateId.
	 * @param  {string}   username    Username.
	 * @param  {string}   provider    Login provider (GitHub, Facebook, OAuth, ...).
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback.
	 * @return {mixed}                (async) Error, Document permissions (r, rw).
	 * @public
	 */
	module.getUserPermissions = function(username, provider, webstrateId, next) {
		var permissions = getCachedPermissions(username, provider, webstrateId);
		if (permissions) {
			return next(null, permissions);
		}

		documentManager.getDocument({ webstrateId }, function(err, snapshot) {
			if (err) {
				return next(err);
			}

			var permissions = module.getUserPermissionsFromSnapshot(username, provider, snapshot);
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
	module.getUserPermissionsFromSnapshot = function(username, provider, snapshot) {
		var permissionsList = module.getPermissionsFromSnapshot(snapshot);

		// If there's also no default permissions, we pretend every user has read-write permissions
		// lest we lock everybody out. We append a question mark to let the system know that these are
		// last-resort permissions.
		if (!permissionsList) {
				return "rw?";
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
	module.getPermissionsFromSnapshot = function(snapshot, useDefaultPermissions = true) {
		var permissionsList;

		if (snapshot && snapshot.data && snapshot.data[0] && snapshot.data[0] === "html" &&
			snapshot.data[1] && snapshot.data[1]['data-auth']) {
			try {
				permissionsList = JSON.parse(snapshot.data[1]['data-auth'].replace(/'/g, '"')
					.replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
			} catch (err) {
				console.warn("Couldn't parse document permissions for", snapshot.id);
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
	module.getDefaultPermissions = function(username, provider) {
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
	module.addPermissions = function(username, provider, permissions, webstrateId, source, next) {
		documentManager.getDocument({ webstrateId }, function(err, snapshot) {
			if (err) {
				return next(err);
			}

			if (!snapshot || !snapshot.data || !snapshot.data[0] || snapshot.data[0] !== "html" ||
				typeof snapshot.data[1] !== "object") {
				return next(new Error("Invalid document"));
			}

			var oldPermissions = snapshot.data[1]['data-auth'];
			snapshot = addPermissionsToSnapshot(username, provider, permissions, snapshot);
			var newermissions = snapshot.data[1]['data-auth'];

			var op = {
				p: [1, 'data-auth'],
				od: oldPermissions,
				oi: newPermissions
			};

			documentManager.submitOp(webstrateId, op, source, next);
		});
	};

	module.addPermissionsToSnapshot = function(username, provider, permissions, snapshot) {
		var currentPermissions = module.getUserPermissionsFromSnapshot(username, provider, snapshot);
		if (currentPermissions === permissions) {
			return snapshot;
		}

		var permissionsList = module.getPermissionsFromSnapshot(snapshot, false) || [];

		// Find index of the user's current permissions
		var userIdx = permissionsList.findIndex(function(user) {
			return user.username === username
			    && user.provider === provider;
		});

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
	module.clearPermissionsFromSnapshot = function(snapshot) {
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
	module.invalidateCachedPermissions = function(webstrateId, local) {
		delete permissionsCache[webstrateId];

		if (local && pubsub) {
			pubsub.publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
				action: "invalidateCachedPermissions", webstrateId, WORKER_ID
			}));
		}
	}

	/**
	 * Extract a user's permissions from a permissions list.
	 * @param  {string} username        Username.
	 * @param  {string} provider        Login provider (Github, Facebook, OAuth, ...).
	 * @param  {list} permissionsList   Permissions List.
	 * @return {string}                 Document permissions (r, rw).
	 * @private
	 */
	function getUserPermissionsFromPermissionsList(username, provider, permissionsList) {
		var user = permissionsList.find(function(user) {
			return user.username === username
			    && user.provider === provider;
		});

		if (user) {
			return user.permissions;
		}

		var anonymous = permissionsList.find(function(user) {
			return user.username === "anonymous"
			    && user.provider === "";
		});

		return anonymous ? anonymous.permissions : "";
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

		var cacheEntry = permissionsCache[webstrateId][username + ":" + provider];
		if (!cacheEntry) {
			return null;
		}

		var [permissions, cacheTime] = cacheEntry;
		var currentTime = Date.now() / 1000 | 0;
		if (currentTime - cacheTime > timeToLive) {
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

		var currentTime = Date.now() / 1000 | 0;
		permissionsCache[webstrateId][username + ":" + provider] = [permissions, currentTime];
	}

	return module;
};