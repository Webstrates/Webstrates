'use strict';

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

	insertSessionLog({
		sessionId: req.agent.clientId,
		userId: req.req.user.userId,
		connectTime: req.agent.connectTime,
		remoteAddress: req.req.remoteAddress
	});
	next();
});

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
					if (err) console.error('Auto-tagging failed', err);
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

	// Check if the update changes the permissions of the document.
	const permissionsChanged = req.op.op.some(op =>
		op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === 'data-auth');

	// And if the permissions have changed, invalidate the permissions cache and expire
	// all access tokens.
	if (permissionsChanged) {
		const webstrateId = req.op.d;
		permissionManager.invalidateCachedPermissions(webstrateId, true);
		permissionManager.expireAllAccessTokens(webstrateId, true);
	}

	next();
});

share.use(['fetch', 'getOps', 'query', 'submit', 'receive', 'bulk fetch', 'delete'],
	function(req, next) {
	// Same as above: If req.agent.user hasn't been set, it's the server acting, which we don't care
	// about.
		if (!req.agent.user) return next();

		const socketId = req.agent.socketId;
		const user = req.agent.user;
		const webstrateId = req.id || (req.data && req.data.d) || req.op.d;

		// If the user is creating a new document, it makes no sense to verify whether he has access to
		// said document.
		if (req.op && req.op.create) {
			return next();
		}

		permissionManager.getUserPermissions(user.username, user.provider, webstrateId,
			(err, permissions) => {
				if (err) {
					return next(err);
				}

				// If the user doesn't have any permissions.
				if (!permissions) {
					return next(new Error('Forbidden'));
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
						// Check if the update changes the permissions of the document.
							const permissionsChanged = req.data.op.some(op =>
								op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === 'data-auth');
							// And if the permissions have changed, invalidate the permissions cache and expire
							// all access tokens.
							if (permissionsChanged) {
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

				return next(new Error('Forbidden'));
			});
	});

module.exports.submit = (webstrateId, op, next) => {
	share.submit(agent, COLLECTION_NAME, webstrateId, op, null, next);
};

module.exports.getOps = (webstrateId, versionFrom, versionTo, next) => {
	share.getOps(agent, COLLECTION_NAME, webstrateId, versionFrom, versionTo, next);
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

module.exports.use = (event, callback) => {
	share.use(event, callback);
};

module.exports.listen = (stream, req) => share.listen(stream, req);