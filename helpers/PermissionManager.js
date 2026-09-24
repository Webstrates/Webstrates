'use strict';

const util = require('util');
const shortId = require('shortid');
const documentManager = require(global.APP_PATH + '/helpers/DocumentManager.js');
const userValidation = require(global.APP_PATH + '/helpers/UserValidation.js');

var authConfig = global.config.auth;

var accessTokens = {};
var permissionsCache = {};
var timeToLive = authConfig && authConfig.permissionTimeout || 120;
var defaultPermissionsList = authConfig && authConfig.defaultPermissions;

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

	if (!userValidation.canBeUsername(username)) {
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
	var webstrateId = req.params.webstrateId;
	var username = req.user.username;
	var provider = req.user.provider;

	var token = shortId.generate();
	var expiration = (Date.now()/1000|0) + duration;

	saveAccessToken(webstrateId, token, username, provider, expiration);

	res.json({ webstrateId, username, provider, token, expiration });
};

/**
 * Save access token.
 * @param {[type]} webstrateId WebstrateId.
 * @param {string} token       Access token.
 * @param {string} username    Username.
 * @param {string} provider    Provider.
 * @param {Date} expiration    Expiration date.
 * @private
 */
function saveAccessToken(webstrateId, token, username, provider, expiration) {
	if (!accessTokens[webstrateId]) {
		accessTokens[webstrateId] = {};
	}

	accessTokens[webstrateId][token] = { username, provider, expiration };

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
 * Expire all access token.
 * @param {[type]} webstrateId WebstrateId.
 * @public
 */
module.exports.expireAllAccessTokens = function(webstrateId) {
	delete accessTokens[webstrateId];
};

/**
 * Check if configuration option is set so users must be logged in to write in a webstrate
 * and the given user is anonymous
 * @param  {string}   username    Username.
 * @param  {string}   provider    Login provider (GitHub, Facebook, OAuth, ...).
 * @return {bool}                 The configuration option is set and the user is anonymous.
 * @private
 */
function userMustBeLoggedInToWriteAndUserIsAnonymous(username, provider) {
	return global.config.loggedInToWrite && username === 'anonymous' && provider === '';
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
module.exports.getUserPermissions = async function(username, provider, webstrateId) {
	if (!webstrateId) {
		throw new Error('Missing webstrateId');
	}

	let permissions = getCachedPermissions(username, provider, webstrateId);
	if (permissions) {
		return permissions;
	}

	const header = await documentManager.getDocumentHeader({ webstrateId });
	permissions = await module.exports.getUserPermissionsFromHeader(username, provider,
		header);

	if (userMustBeLoggedInToWriteAndUserIsAnonymous(username, provider)) {
		permissions = permissions.replace(/w/g, '');
	}

	// Never cache permissions for documents that do not exist yet.
	if (header.exists) {
		setCachedPermissions(username, provider, permissions, header.id);
	}
	return permissions;
};

/**
 * Get all permissions from a webstrate.
 * @param  {string} webstrateId WebstrateId.
 * @return {[type]}             List of permissions from webstrate.
 * @private
 */
async function getPermissions(webstrateId) {
	const header = await documentManager.getDocumentHeader({ webstrateId });
	return await module.exports.getPermissionsFromHeader(header, false);
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
 * Get a user's permissions for a document header (see
 * DocumentManager.getDocumentHeader) — the live-document and ingest path:
 * it reads the html element's data-auth straight off the mirror.
 * @param  {string} username Username.
 * @param  {string} provider Login provider (GitHub, Facebook, OAuth, ...).
 * @param  {Header} header   Document header.
 * @return {string}          Document permissions (r, rw).
 * @public
 */
module.exports.getUserPermissionsFromHeader = async (username, provider, header) => {
	const permissionsList = await module.exports.getPermissionsFromHeader(header);

	if (!permissionsList) {
		return 'rw?';
	}

	return getUserPermissionsFromPermissionsList(username, provider, permissionsList);
};

/**
 * Get all permissions from a document header. The header carries the html
 * element's data-auth attribute value as the mirror stores it (entity-
 * decoded, so unlike the JsonML form it never holds &quot;) — only the
 * single-quote JSON form some documents author needs unquoting.
 * Inheritance walks the inherited documents' headers (same recursion
 * bound as the snapshot variant).
 * @param  {Header}  header                Document header.
 * @param  {bool}    useDefaultPermissions Whether to return default permissions if none found.
 * @param  {integer} recursionCount        Inheritance recursion bound.
 * @return {array}                         Permissions list.
 * @public
 */
module.exports.getPermissionsFromHeader = async (header, useDefaultPermissions = true,
	recursionCount = 0) => {
	let permissionsList;

	try {
		if (header && header.dataAuth) {
			// The same tolerance chain the JsonML parse used: values may be
			// authored in single-quote JSON form, and a client-committed
			// value may still carry literal entities.
			permissionsList = JSON.parse(header.dataAuth
				.replace(/'/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

			if (recursionCount > ALLOWED_RECURSIVE_INHERITANCES) {
				console.warn('Too many recursive inheritances in', header.id);
				return permissionsList;
			}

			await getInheritedPermissionsFromHeaders(permissionsList, recursionCount + 1);

			return permissionsList;
		}
	} catch (err) {
		console.warn('Couldn\'t parse document permissions for', header && header.id);
	}

	if (useDefaultPermissions && (!Array.isArray(permissionsList)
		|| Object.keys(permissionsList).length === 0)) {
		return useDefaultPermissions ? defaultPermissionsList : undefined;
	}

	return undefined;
};

/**
 * Expand a permissions list with the permissions inherited from other
 * documents — the header-based variant of getInheritedPermissions (same
 * "the slow way" anti-DoS note applies).
 * @param {[Object]} permissionsList Permissions list (expanded in place).
 * @param {integer}  recursionCount  Inheritance recursion bound.
 * @return {[Object]}                The same list, for good measure.
 * @private
 */
async function getInheritedPermissionsFromHeaders(permissionsList, recursionCount) {
	for (let i = 0, l = permissionsList.length; i < l; ++i) {
		const webstrateId = permissionsList[i].webstrateId;
		if (webstrateId) {
			const header = await documentManager.getDocumentHeader({ webstrateId });
			const otherPermissionList = await module.exports.getPermissionsFromHeader(header,
				false, recursionCount);

			// We don't want admin permissions to be inherited, so we remove the 'a' flag.
			otherPermissionList.forEach(o => o.permissions = o.permissions.replace(/a/i, ''));

			permissionsList.push(...otherPermissionList);
		}
	}
	return permissionsList;
}

const ALLOWED_RECURSIVE_INHERITANCES = 3;

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
 * Update permissions for a username and provider for a webstrate with the given webstrateId. If the
 * user already has the permissions (either explicitly or through default permissions), nothing
 * is done.
 * @param {string}   username    Username.
 * @param {string}   provider    Login provider (Github, Facebook, OAuth, ...).
 * @param {string}   permissions Permissions (r, rw).
 * @param {string}   webstrateId WebstrateId.
 * @param {string}   source      An identifier for who made the op (added the permissions). source
 *                               is usually the client's websocket connection id, but since we
 *                               don't have a one here, it should just be a userId.
 * @public
 */
module.exports.setUserPermissions = async function(username, provider, permissions, webstrateId, source) {
	const header = await documentManager.getDocumentHeader({ webstrateId });
	if (!header.exists) throw new Error('Invalid document');

	// The user's permissions for this document (default 'rw?' when it
	// carries none): setting what they already have is a no-op.
	const currentPermissions = await module.exports.getUserPermissionsFromHeader(username,
		provider, header);
	if (currentPermissions === permissions) return;

	// Splice the user into the data-auth list (creating it when the document
	// has none) and commit the new value onto the html element.
	const permissionsList = (await module.exports.getPermissionsFromHeader(header, false)) || [];
	const userIdx = permissionsList.findIndex(user =>
		user.username === username && user.provider === provider);
	const user = { username, provider, permissions };
	if (userIdx === -1) permissionsList.push(user);
	else permissionsList[userIdx] = user;

	await util.promisify(documentManager.setHtmlAttribute)(webstrateId, 'data-auth',
		JSON.stringify(permissionsList), source);
	module.exports.invalidateCachedPermissions(webstrateId);
};

/**
 * Remove all permissions from a webstrate (deletes the html element's
 * data-auth attribute) — the copy path's anonymous-copier stamp.
 * @param {string} webstrateId WebstrateId.
 * @param {string} source      Op source identifier (usually a userId).
 * @public
 */
module.exports.clearPermissions = async function(webstrateId, source) {
	await util.promisify(documentManager.setHtmlAttribute)(webstrateId, 'data-auth', null,
		source);
	module.exports.invalidateCachedPermissions(webstrateId);
};

/**
 * Remove admin permissions from a webstrate — the copy path strips the 'a'
 * flag from every permissions entry (inherited entries included, matching
 * the old snapshot variant) so a copy can't hand out admin.
 * @param {string} webstrateId WebstrateId.
 * @param {string} source      Op source identifier (usually a userId).
 * @public
 */
module.exports.removeAdminPermissions = async function(webstrateId, source) {
	const header = await documentManager.getDocumentHeader({ webstrateId });
	const permissionsList = await module.exports.getPermissionsFromHeader(header, false);

	if (permissionsList && permissionsList.some(user => /a/i.test(user.permissions))) {
		permissionsList.forEach(user => user.permissions = user.permissions.replace(/a/gi, ''));
		await util.promisify(documentManager.setHtmlAttribute)(webstrateId, 'data-auth',
			JSON.stringify(permissionsList), source);
		module.exports.invalidateCachedPermissions(webstrateId);
	}
};

/**
 * Deletes all caches for a specific webstrate.
 * @param {string} webstrateId WebstrateId.
 * @public
 */
module.exports.invalidateCachedPermissions = function(webstrateId) {
	delete permissionsCache[webstrateId];
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
