'use strict';

const bson = require('bson');
const v8 = require('v8');
const redis = require('redis');
const sharedb = require('sharedb');
const sharedbMongo = require('sharedb-mongo');
const sharedbRedisPubSub = require('sharedb-redis-pubsub');
const db = require(APP_PATH + '/helpers/database.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');

const COLLECTION_NAME = 'webstrates';

const share = sharedb({
	db: sharedbMongo(global.config.db),
	pubsub: global.config.pubsub && sharedbRedisPubSub({
		client: redis.createClient(global.config.pubsub),
		observer: redis.createClient(global.config.pubsub)
	})
});

const agent = share.connect();

const insertSessionLog = (log, attempts = 10) => {
	if (attempts === 0) throw new Error('Unable to insert session log');
	if (!db.sessionLog) return insertSessionLog(log, attempts - 1);
	db.sessionLog.insert(log, (err, db) => {
		if (err) return setTimeout(() => insertSessionLog(log, attempts - 1), 50);
	});
};

share.use('connect', (req, next) => {
	// req is the sharedb request, req.req is the HTTP request that we've attached ourselves
	// when we did share.listen(stream, req). We copy useful user data from the HTTP request to the
	// agent, because the agent always is available in the sharedb trigger callbacks (like  'op' and
	// 'submit'), while the HTTP request object is not.
	req.agent.user = req.req.user;
	req.agent.remoteAddress = req.req.remoteAddress;
	req.agent.socketId = req.req.socketId;
	req.agent.req = req.req;

	next();
});

/**
 * Check if the update changes the permissions of the document.
 * @param  {Array} ops List of ops.
 * @return {bool}      Whether any of the ops modify the permission property on the HTML element.
 * @private
 */
const changesPermissions = (ops) => ops.some(op =>
	op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === 'data-auth');

if (global.config.tagging) {
	const webstrateActivites = {};

	share.use('op', (req, next) => {
		// req is the sharedb request, req.req is the HTTP request that we've attached ourselves
		// when we did share.listen(stream, req).

		// If the user object doesn't exist, that's because the 'connect' handler above hasn't been
		// triggered, which will only be the case for the server's own agent, which we don't care
		// about for this.
		if (!req.agent.user) return next();

		const webstrateId = req.id;
		const timestamp = Date.now();

		if (!webstrateActivites[webstrateId] || webstrateActivites[webstrateId] +
			global.global.config.tagging * 1000 < timestamp) {
			const version = req.op.v;
			documentManager.getTag(webstrateId, version, function(err, tag) {
				// If a tag already exists at this version, we don't want to overwrite it with our generic,
				// auto-tagging one.
				if (tag) return next();

				var label = global.config.tagging.tagPrefix + new Date(timestamp);
				documentManager.tagDocument(webstrateId, version, label, function(err) {
					// We ignore error 11000 (duplicate key), because they're fairly inconsequential.
					// Prior to MongoDB 4.1.6 (see https://jira.mongodb.org/browse/SERVER-14322), MongoDB
					// would throw this error when trying to create the same entry multiple times (due to
					// race conditions), even though it should have resorted to upserting. In other words,
					// this is a fix for people running MongoDB older than 4.1.6.
					if (err && err.code !== 11000) console.error('Auto-tagging failed', err);
				});
			});
		}

		webstrateActivites[webstrateId] = timestamp;
		next();
	});
}

// Invalidate permissions cache after a permission-changing op has been applied.
share.use(['after submit'], (req, next) => {
	if (req.op && req.op.create) {
		return next();
	}

	// If the permissions have changed, invalidate the permissions cache and expire all access tokens.
	if (changesPermissions(req.op.op)) {
		const webstrateId = req.op.d;
		permissionManager.invalidateCachedPermissions(webstrateId, true);
		permissionManager.expireAllAccessTokens(webstrateId, true);
	}

	next();
});

share.use(['fetch', 'getOps', 'query', 'submit', 'receive', 'bulk fetch', 'delete'],
	async function(req, next) {
	// Same as above: If req.agent.user hasn't been set, it's the server acting, which we don't care
	// about (in the sense that we don't want to check for permissions or anything).
		if (!req.agent.user) return next();

		const socketId = req.agent.socketId;
		let user = req.agent.user;
		const webstrateId = req.id || (req.data && req.data.d) || req.op.d;

		// We have already resolved the user from the token in the sessionMiddleware, but we have to do it here as well,
		// because the webstrateId here may differ from the original req.webstrateId, and so may the permissions.
		if (req.agent.req.webstrateId !== webstrateId) {
			const token = req.agent.req.query.token;
			user = permissionManager.getUserFromAccessToken(webstrateId, token);
		}

		if (!config.disableSessionLog && !req.agent.sessionLogged) {
			insertSessionLog({
				sessionId: req.agent.clientId,
				userId: user.userId,
				connectTime: req.agent.connectTime,
				remoteAddress: req.agent.remoteAddress
			});
			req.agent.sessionLogged = true;
		}

		// If the user is creating a new document, it makes no sense to verify whether he has access to
		// said document.
		if (req.op && req.op.create) {
		// But we should check whether the user has access to create documents.
			if (!permissionManager.userIsAllowedToCreateWebstrate(user)) {
				let err = 'Must be logged in to create a webstrate.';
				if (Array.isArray(config.loggedInToCreateWebstrates)) {
					const allowedProviders = config.loggedInToCreateWebstrates.join(' or ');
					err =  `Must be logged in with ${allowedProviders} to create a webstrate.`;
				}
				return next(err);
			}
			return next();
		}

		const permissions = await permissionManager.getUserPermissions(user.username, user.provider,
			webstrateId);

		// If the user doesn't have any permissions.
		if (!permissions) {
			return next('Forbidden');
		}

		switch (req.action) {
			case 'fetch':
			case 'getOps': // Operations request.
			case 'query': // Document request.
				if (permissions.includes('r')) {
					return next();
				}
				break;
			case 'submit': // Operation submission.
				if (permissions.includes('w')) {
					return next();
				}
				break;
			case 'receive':
			// u = unsubscribe.
				if (req.data.a === 'u') {
					clientManager.removeClientFromWebstrate(socketId, webstrateId, true);
					return;
				}

				// Check if the incoming update is an op (and not a create op).
				if (req.data.a === 'op' && Array.isArray(req.data.op)) {
				// If the permissions have changed, invalidate the permissions cache and expire
				// all access tokens.
					if (changesPermissions(req.data.op)) {
					// If a non-admin attempts to modify the permissions in a document with an admin, we throw
					// an error.
						if (!permissions.includes('a') &&
							await permissionManager.webstrateHasAdmin(webstrateId)) {
							return next('Forbidden, admin permission required');
						}

						permissionManager.invalidateCachedPermissions(webstrateId, true);
						permissionManager.expireAllAccessTokens(webstrateId, true);
					}
				}

				// Anything but a subscribe request.
				if (req.data.a !== 's') {
					return next();
				}

				// Initial document request (s = subscribe).
				if (req.data.a === 's' && permissions.includes('r')) {
				// Add client and send "hello" message including client list.
					clientManager.addClientToWebstrate(socketId, user.userId, webstrateId, true);

					// Send list of tags to clients if any.
					documentManager.getTags(webstrateId, function(err, tags) {
						if (err) console.error(err);
						if (tags) {
							clientManager.sendToClient(socketId, {
								wa: 'tags', d: webstrateId, tags
							});
						}
					});

					// Send list of assets to clients if any.
					assetManager.getAssets(webstrateId, function(err, assets) {
						if (err) console.error(err);
						if (assets) {
							clientManager.sendToClient(socketId, {
								wa: 'assets', d: webstrateId, assets
							});
						}
					});

					// No reason to lock up the execution by waiting for the tags and assets to be loaded;
					// they will be sent when they arrive, so we just return now.
					return next();
				}
				break;
			case 'bulk fetch':
				console.log('req.action bulk fetch');
				break;
			case 'delete':
				console.log('req.action delete');
				break;
		}

		return next('Forbidden, write permissions required');
	});

module.exports.submit = (webstrateId, op, next) => {
	share.submit(agent, COLLECTION_NAME, webstrateId, op, null, next);
};

module.exports.getOps = (webstrateId, versionFrom, versionTo, next) => {
	share.getOps(agent, COLLECTION_NAME, webstrateId, versionFrom, versionTo, (err, ops) => {
		if (err || ops.length < 1000) return next(err, ops);

		const heapStats = v8.getHeapStatistics();
		const opsInMB = bson.calculateObjectSize(ops) / (1024 * 1024);
		const availMemInMB = (heapStats.heap_size_limit - heapStats.used_heap_size) / (1024 * 1024);
		const estimatedRequiredMemInMB = 8 * opsInMB;

		// When stringifying ops, they'll take up about 7 times as much memory as they do right now,
		// so we throw an error if we're at risk of approaching this memory limit. We'd rather ask the
		// user to request fewer ops than to risk the server crashing, because it runs out of memory.
		if (estimatedRequiredMemInMB < availMemInMB) return next(err, ops);

		// Calculate (and round) an amount of ops the server will likely be able to serve.
		// This is 80% of what the server appears to be able to handle with current memory consumption.
		let suggestedOps = .8 * ops.length * (availMemInMB / estimatedRequiredMemInMB);
		suggestedOps = Math.floor((suggestedOps / 1000)) * 1000;

		err = new Error('Memory consumption of requested ops too high. Try requesting only ' +
			`${suggestedOps} ops at a time instead of the requested ${ops.length} ops.`);
		next(err, null);
	});
};

module.exports.fetch = (webstrateId, next) => {
	share.fetch(agent, COLLECTION_NAME, webstrateId, next);
};

module.exports.submitOp = (webstrateId, op, next) => {
	// https://github.com/share/sharedb/blob/master/lib/backend.js
	// Maybe this method is unnecessary and could be replaced by just submit. But that will
	// trigger the submit event, this won't, so I don't know.
	const request = new sharedb.SubmitRequest(share, agent, COLLECTION_NAME, webstrateId, op);
	request.submit(next);
};

module.exports.use = (event, callback) => share.use(event, callback);

module.exports.listen = (stream, req) => share.listen(stream, req);