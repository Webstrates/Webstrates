"use strict";

/**
 * PermissionManager constructor.
 * @param {DocumentManager} documentManager DocumentManager instance.
 * @param {int}             authConfig      Auth configurations
 * @constructor
 */
module.exports = function(documentManager, authConfig) {
	var module = {};
	var permissionsCache = {};
	var timeToLive = authConfig ? authConfig.permissionTimeout : 300;
	var defaultPermissionsList = authConfig && authConfig.defaultPermissions;

	/**
	 * Get a user's permissions for a specific snapshot.
	 * @param  {string}   username    Username.
	 * @param  {string}   provider    Login provider (GitHub, Facebook, OAuth, ...).
	 * @param  {string}   webstrateId WebstrateId.
	 * @param  {Function} next        Callback.
	 * @return {mixed}                (async) Error, Document permissions (r, rw).
	 * @public
	 */
	module.getPermissions = function(username, provider, webstrateId, next) {
		var permissions = getCachedPermissions(username, provider, webstrateId);
		if (permissions) {
			return next(null, permissions);
		}

		documentManager.getDocument({ webstrateId }, function(err, snapshot) {
			if (err) {
				return next(err);
			}

			var permissions = getPermissionsFromSnapshot(username, provider, snapshot);
			setCachedPermissions(username, provider, permissions, snapshot.id);
			next(null, permissions);
		});
	}

	/**
	 * Get a user's default permission.
	 * @param  {string} username Username.
	 * @param  {string} provider Login provider (Github, Facebook, OAuth, ...).
	 * @return {string}          Permissions (r, rw).
	 * @public
	 */
	module.getDefaultPermissions = function(username, provider) {
		return getUserPermissionsFromPermissionsList(username, provider, defaultPermissionsList);
	}

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

			var currentPermissions = getPermissionsFromSnapshot(username, provider, snapshot);
			if (currentPermissions === permissions) {
				return next();
			}

			if (!snapshot || !snapshot.data || !snapshot.data[0] || snapshot.data[0] !== "html" ||
				typeof snapshot.data[1] !== "object") {
				return next(new Error("Invalid document"));
			}

			var permissionsList = snapshot.data[1]['data-auth'] ?
				JSON.parse(snapshot.data[1]['data-auth'].replace(/'/g, '"')) : [];

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

			var op = {
				p: [1, 'data-auth'],
				od: snapshot.data[1]['data-auth'],
				oi: JSON.stringify(permissionsList)
			};

			documentManager.submitOp(webstrateId, op, source, next);
		});
	};

	/**
	 * Get a user's permissions for a specific snapshot.
	 * @param  {string} username Username.
	 * @param  {string} provider Login provider (GitHub, Facebook, OAuth, ...).
	 * @param  {JsonML} snapshot ShareDB docuemnt snapshot.
	 * @return {string}          Document permissions (r, rw).
	 * @private
	 */
	function getPermissionsFromSnapshot(username, provider, snapshot) {
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
		}

		// If we found no permissions, resort to default permissions.
		if (!permissionsList) {
			// If there's also no default permissions, we pretend every user has read-write permissions
			// lest we lock everybody out. We append a question mark to let the system know that these are
			// last-resort permissions.
			if (!defaultPermissionsList) {
				return "rw?";
			}
			permissionsList = defaultPermissionsList;
		}

		return getUserPermissionsFromPermissionsList(username, provider, permissionsList);
	}

	/**
	 * Extract a user's permissions from a permissions list
	 * @param  {string} username        Username.
	 * @param  {string} provider        Login provider (Github, Facebook, OAuth, ...).
	 * @param  {list} permissionsList   Permissions List.
	 * @return {string}                 Docuemnt permissions (r, rw).
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