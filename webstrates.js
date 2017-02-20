"use strict";

var argv = require("optimist").argv;
var cluster = require('cluster');
var Duplex = require("stream").Duplex;
var express = require("express");
var fs = require("fs");
var fss = require("fs-sync");
var http = require("http");
var httpAuth = require("http-auth");
var MongoClient = require("mongodb").MongoClient;
var passport = require("passport");
var redis = require("redis");
var sessions = require("client-sessions");
var sharedb = require("sharedb");
var sharedbMongo = require("sharedb-mongo");
var sharedbRedisPubSub = require("sharedb-redis-pubsub");
var WebSocketServer = require("ws").Server;

global.WORKER_ID = cluster.worker && cluster.worker.id || 1;
global.APP_PATH = __dirname;

require('console-stamp')(console, {
	metadata: function() {
		return (new Error().stack.split("\n")[3]).trim().substr(3);
	},
	pattern: 'HH:MM:ss',
	colors: {
		stamp: "yellow",
		label: "blue",
		metadata: "grey"
	}
});

if (!fss.exists(APP_PATH + "/config.json")) {
	console.warn("No config file present, creating one now");
	if (!fss.exists(APP_PATH + "/config-sample.json")) {
		console.warn("Sample config not present either, creating empty config")
		fss.write(APP_PATH + "/config.json", "{}");
	} else {
		fss.copy(APP_PATH + "/config-sample.json", APP_PATH + "/config.json");
	}
}

global.config = fss.readJSON(APP_PATH + "/config.json");

// Setting up multi-threading. If config.threads is 0, a thread for each core is created.
var threadCount = 1;
if (typeof global.config.threads !== "undefined") {
	threadCount = parseInt(global.config.threads) || require('os').cpus().length;
	if (!global.config.pubsub) {
		console.warn("Can't run multithreaded without Redis");
	} else {
		threadCount = parseInt(global.config.threads) || require('os').cpus().length;
		if (cluster.isMaster) {
			for (var i = 0; i < threadCount; ++i) {
				cluster.fork();
			}
			return;
		}
	}
}

var DB_ADDRESS = global.config.db || "mongodb://localhost:27017/webstrate";

var pubsub;
if (global.config.pubsub) {
	pubsub = {
		publisher: redis.createClient(global.config.pubsub),
		subscriber: redis.createClient(global.config.pubsub)
	};
}

var share = sharedb({
	db: sharedbMongo(DB_ADDRESS),
	pubsub: global.config.pubsub && sharedbRedisPubSub({
		client: pubsub.publisher,
		observer: pubsub.subscriber
	})
});
var agent = share.connect();

var db = {};
MongoClient.connect(DB_ADDRESS, function(err, _db) {
	if (err)
		throw err;

	db.sessionLog = _db.collection('sessionLog');
	db.webstrates = _db.collection('webstrates');
	db.ops = _db.collection('ops');
	db.tags = _db.collection('tags');
	db.tags.ensureIndex({ webstrateId: 1, label: 1 }, { unique: true });
	db.tags.ensureIndex({ webstrateId: 1, v: 1 }, { unique: true });
	db.assets = _db.collection('assets');
	db.assets.ensureIndex({ webstrateId: 1, originalFileName: 1, v: 1 }, { unique: true });
	db.cookies = _db.collection('cookies');
	db.cookies.ensureIndex({ userId: 1, webstrateId: 1 }, { unique: true });
});

var cookieHelper = require("./helpers/CookieHelper.js")();
var clientManager = require("./helpers/ClientManager.js")(cookieHelper, db, pubsub);
var documentManager = require("./helpers/DocumentManager.js")(clientManager, share, agent, db);
var permissionManager = require("./helpers/PermissionManager.js")(documentManager, pubsub);
var assetManager = require("./helpers/AssetManager.js")(permissionManager, clientManager,
	documentManager, db);
var httpRequestController = require("./helpers/HttpRequestController.js")(documentManager,
	permissionManager, assetManager);

var app = express();
app.server = http.createServer(app);
app.use(express.static("build"));
app.use(express.static("static"));

if (config.basicAuth) {
	if (WORKER_ID === 1) console.log("Basic auth enabled");
	var basic = httpAuth.basic({
		realm: config.basicAuth.realm
	}, function(username, password, callback) {
		return callback(username === config.basicAuth.username
			&& password === config.basicAuth.password);
	});
	app.use(httpAuth.connect(basic));
}

var auth = false;

if (config.auth) {
	app.use(sessions(config.auth.cookie));

	passport.serializeUser(function(user, done) {
		return done(null, user);
	});

	passport.deserializeUser(function(obj, done) {
		return done(null, obj);
	});

	for (var key in config.auth.providers) {
		var PassportStrategy = require(config.auth.providers[key].node_module).Strategy;
		passport.use(new PassportStrategy(config.auth.providers[key].config,
			function(accessToken, refreshToken, profile, done) {
				return process.nextTick(function() {
					return done(null, profile);
				});
			}));
	}

	app.use(passport.initialize());
	app.use(passport.session());

	for (var provider in config.auth.providers) {
		app.get('/auth/' + provider, passport.authenticate(provider), function(req, res) {});
		app.get('/auth/' + provider + '/callback', passport.authenticate(provider, {
			failureRedirect: '/auth/' + provider
		}), function(req, res) {
			return res.redirect("/");
		});
		if (WORKER_ID === 1) console.log(provider + "-based authentication enabled");
	}

	app.get('/auth/logout', function(req, res) {
		req.logout();
		return res.redirect("/");
	});

	auth = true;
}

app.use(function(req, res, next) {
	sessionMiddleware(req, next);
});

app.get("/", httpRequestController.rootRequestHandler);
app.get("/new", httpRequestController.newWebstrateRequestHandler);
app.get("/favicon.ico", httpRequestController.faviconRequestHandler);

// Ensure trailing slash after webstrateId and tag/label.
app.get(/^\/([A-Z0-9\._-]+)(\/([A-Z0-9_-]+))?$/i,
	httpRequestController.trailingSlashAppendHandler);

// Matches /<webstrateId>/(<tagOrVersion>)?//<assetName>)?
app.get(/^\/([A-Z0-9\._-]+)\/(?:([A-Z0-9%_-]+)\/)?(?:([A-Z0-9%\._-]+\.[A-Z0-9_-]+))?$/i,
	httpRequestController.extractQuery,
	httpRequestController.requestHandler);

// We can only post to /<webstrateId>/, because we won't allow users to add assets to old versions
// of a document.
app.post(/^\/([A-Z0-9\._-]+)\/$/i,
	httpRequestController.extractQuery,
	assetManager.assetUploadHandler
);

// Catch all for get.
app.get(function(req, res) {
	res.send("Invalid request URL.");
});

// Catch all for post.
app.post(function(req, res) {
	res.send("You can only post assets to URLs of the form /<webstrateId>/.");
});

/**
	Middleware for logging userIds of connected clients. Makes it possible to map sessionIds to
	userIds. Used when getting ops list.
 */
var sessionLoggingMiddleware = function(req, next) {
	var insertFn = function() {
		if (!db.sessionLog) {
			return process.nextTick(insertFn);
		}

		db.sessionLog.insert({
			sessionId: req.agent.clientId,
			userId: req.user.userId,
			connectTime: req.agent.connectTime,
			remoteAddress: req.stream.remoteAddress
		}, function(err, db) {
			if (err) {
				throw err;
			}
		});
	}

	insertFn();
	next();
};

/**
	Middleware for extracting user data from cookies used for both regular HTTP requests (Express)
	and WebSocket requests.
 */
var sessionMiddleware = function(req, next) {
	var username = "anonymous";
	var provider = "";

	if (auth) {
		var session = req.session || (req.agent && req.agent.stream && req.agent.stream.session);
		if (session && session.passport && session.passport.user) {
			username = session.passport.user.username;
			provider = session.passport.user.provider;
		}
	}
	if (typeof req.user !== "object") {
		req.user = {};
	}

	req.remoteAddr = (req.headers && (req.headers['X-Forwarded-For'] ||
		req.headers['x-forwarded-for'])) || (req.connection && req.connection.remoteAddress);

	req.user.username = username;
	req.user.provider = provider;
	req.user.userId = username + ":" + provider;
	req.webstrateId = req.id || req.data && req.data.d;
	next();
};

share.use(['connect', 'receive', 'fetch', 'bulk fetch', 'getOps', 'query', 'submit', 'delete'],
	function(req, next) {
	sessionMiddleware(req, next);
});

share.use('connect', function(req, next) {
	sessionLoggingMiddleware(req, next)
});


var webstrateActivites = {};
var AUTO_TAGGING_PREFIX = config.tagging && config.tagging.tagPrefix || "Session of ";
var AUTO_TAGGING_INTERVAL = config.tagging && config.tagging.autotagInterval || 3600;
share.use('op', function(req, next) {
	// We are only interested in ops coming from clients here, which all will have a `d` (document)
	// property.
	if (!req.op.d) return next();

	var webstrateId = req.op.d;
	var timestamp = Date.now();

	if (!webstrateActivites[webstrateId] || webstrateActivites[webstrateId] +
		AUTO_TAGGING_INTERVAL * 1000 < timestamp) {
		var version = req.op.v;
		documentManager.getTag(webstrateId, version, function(err, tag) {
			// If a tag already exists at this version, we don't want to overwrite it with our generic,
			// auto-tagging one.
			if (tag) return next();

			var label = AUTO_TAGGING_PREFIX + new Date(timestamp);
			documentManager.tagDocument(webstrateId, version, label, function(err) {
				if (err) console.error("Auto-tagging failed", err);
			});
		});
	}

	webstrateActivites[webstrateId] = timestamp;
	next();
});

share.use(['fetch', 'getOps', 'query', 'submit', 'receive', 'bulk fetch', 'delete'],
	function(req, next) {
		// If the user is creating a new document, it makes no sense to verify whether he has access to
		// said document.
		if (req.op && req.op.create) {
			return next();
		}

		permissionManager.getPermissions(req.user.username, req.user.provider, req.webstrateId,
			function(err, permissions) {
				if (err) {
					return next(err);
				}

				// If the user doesn't have any permissions.
				if (!permissions) {
					return next(new Error("Forbidden"));
				}

				switch (req.action) {
					case "fetch":
						console.log("req.action fetch");
					case "getOps": // Operations request.
					case "query": // Document request.
						if (permissions.includes("r")) {
							return next();
						}
						break;
					case "submit": // Operation submission.
						if (permissions.includes("w")) {
							return next();
						}
						break;
					case "receive":
						// u = unsubscribe.
						if (req.data.a === "u") {
							clientManager.removeClientFromWebstrate(req.data.socketId, req.webstrateId, true);
							return;
						}

						// Check if the incoming update is an op (and not a create op).
						if (req.data.a === "op" && Array.isArray(req.data.op)) {
							// Check if the update changes the permissions of the document.
							var permissionsChanged = req.data.op.some(function(op) {
								return op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === "data-auth";
							});
							// And if the permissions have changed, invalidate the permissions cache.
							if (permissionsChanged) {
								permissionManager.invalidateCachedPermissions(req.webstrateId, true);
							}
						}

						// Anything but a subscribe request.
						if (req.data.a !== "s") {
							return next();
						}

						// Initial document request (s = subscribe).
						if (req.data.a === "s" && permissions.includes("r")) {
							var webstrateId = req.data.d;
							// Add client and send "hello" message including client list.
							clientManager.addClientToWebstrate(req.data.socketId, webstrateId, true);

							// Send list of tags to clients if any.
							documentManager.getTags(webstrateId, function(err, tags) {
								if (err) console.error(err);
								if (tags) {
									clientManager.sendToClient(req.data.socketId, {
										wa: "tags", d: webstrateId, tags
									});
								}
							});

							// Send list of assets to clients if any.
							assetManager.getAssets(webstrateId, function(err, assets) {
								if (err) console.error(err);
								if (assets) {
									clientManager.sendToClient(req.data.socketId, {
										wa: "assets", d: webstrateId, assets
									});
								}
							})

							// No reason to lock up the thread by waiting for the tags and assets to be loaded;
							// they will be sent when they arrive, so we just return now.
							return next();
						}
						break;
					case "bulk fetch":
						console.log("req.action bulk fetch");
						break;
					case "delete":
						console.log("req.action delete");
						break;
				}

				return next(new Error("Forbidden"));
			});
	});


var addressBanList = {};
var BANLIST_CHANNEL = "webstratesBans";

var wss = new WebSocketServer({
	server: app.server,
	verifyClient: function(info, next) {
		var remoteAddress = info.req.headers['X-Forwarded-For'] ||
		info.req.headers['x-forwarded-for'] || info.req.connection.remoteAddress;

		if (config.rateLimit && addressBanList[remoteAddress]) {
			return next(false, 429);
		}

		next(true);
	}
});

if (config.rateLimit) {
	setInterval(function() {
		var currentTime = Date.now();
		for (var remoteAddress in addressBanList) {
			if (addressBanList[remoteAddress] + config.rateLimit.banDuration < currentTime) {
				console.log("Removing", remoteAddress, "from blacklist");
				delete addressBanList[remoteAddress];
			}
		}
	}, config.rateLimit.banDuration / 10);

	if (pubsub) {
		pubsub.subscriber.subscribe(BANLIST_CHANNEL);
		pubsub.subscriber.on("message", function(channel, message) {
			// Ignore messages on other channels.
			if (channel !== BANLIST_CHANNEL) {
				return;
			}

			message = JSON.parse(message);

			// Ignore messages from ourselves.
			if (message.WORKER_ID === WORKER_ID) {
				return;
			}

			addressBanList[message.remoteAddress] = message.timestamp;
		});
	}
}

wss.on('connection', function(client) {
	var cookie = cookieHelper.decodeCookie(client.upgradeReq.headers.cookie);
	var user = (cookie && cookie.passport.user) || {};
	client.user = user;

	var socketId = clientManager.addClient(client);

	// We replace `client.send` with a function that doesn't throw an exception if the message fails.
	// Instead, it just quietly removes the client.
	client.__send = client.send;
	client.send = function(data) {
		try {
			client.__send(data);
		} catch (err) {
			clientManager.removeClient(socketId);
			return false;
		}
		return true;
	};

	var stream = new Duplex({
		objectMode: true
	});

	var remoteAddress = client.upgradeReq.headers['X-Forwarded-For'] ||
		client.upgradeReq.headers['x-forwarded-for'] || client.upgradeReq.connection.remoteAddress;

	stream.session = cookie;
	stream.headers = client.upgradeReq.headers;
	stream.remoteAddress = remoteAddress;

	stream._write = function(chunk, encoding, callback) {
		try {
			client.send(JSON.stringify(chunk));
		} catch (err) {
			console.error(err);
		}
		callback();
	};

	stream._read = function() {};

	stream.on('error', function(msg) {
		try {
			return client.close(msg);
		} catch (err) {
			console.error(err);
		}
	});

	stream.on('end', function() {
		try {
			return client.close();
		} catch (err) {
			console.error(err);
		}
	});

	if (config.rateLimit) {
		var messageCount = 0;
		setInterval(function() {
			messageCount = 0;
		}, config.rateLimit.intervalLength);
	}

	client.on('message', function(data) {
		// Rate limiting. Limits the number of messages per interval to avoid clients that have run
		// haywire from DoS'ing the server.
		if (config.rateLimit) {
			if (++messageCount > config.rateLimit.messagesPerInterval) {
				console.log("Blacklisting", remoteAddress, "for exceeding rate limitation.");
				var timestamp = Date.now();
				addressBanList[remoteAddress] = timestamp;
				if (pubsub) {
					pubsub.publisher.publish(BANLIST_CHANNEL, JSON.stringify({
						WORKER_ID, remoteAddress, timestamp
					}));
				}
			}

			if (addressBanList[remoteAddress]) {
				client.close();
				return;
			}
		}

		try {
			data = JSON.parse(data);
		} catch (err) {
			console.error("Received invalid websocket data from", socketId + ":", data);
			return;
		}

		// Ignore keep alive messages.
		if (data.type === 'alive') {
			return;
		}

		// Adding socketId to every incoming message. This has to be done even to the messages we send
		// to sharedb, because it may trigger our share.use callbacks where we need access to the
		// socketId.
		data.socketId = socketId;

		// All our custom actions have the wa (webstrates action) property set. If this is not the case,
		// the message was intended for sharedb.
		if (!data.wa) {
			// We do not need to check for permissions here; this happens in the sharedb middleware.
			stream.push(data);
			return;
		}

		// Handle webstrate actions.
		var webstrateId = data.d;

		permissionManager.getPermissions(user.username, user.provider, webstrateId,
			function(err, permissions) {
			if (err) return console.error(err);

			if (!permissions.includes("r")) {
				return console.error("Insufficient read permissions in", data.wa, "call");
			}

			switch (data.wa) {
				// When the client is ready.
				case "ready":
					clientManager.triggerJoin(socketId);
					break;
				// Request a snapshot.
				case "fetchdoc":
					var version = data.v;
					var tag = data.l;
					if (data.token) {
						documentManager.getDocument({ webstrateId, tag, version }, function(err, snapshot) {
							var responseObj = { wa: "reply", token: data.token };
							if (err) {
								responseObj.error = err.message;
							} else {
								responseObj.reply = snapshot;
							}
							client.send(JSON.stringify(responseObj));
						});
					}
					break;
				// Subscribe to signals.
				case "subscribe":
					var nodeId = data.id || "document";
					clientManager.subscribe(socketId, webstrateId, nodeId);
					if (data.token) {
						client.send(JSON.stringify({ wa: "reply", token: data.token }));
					}
					break;
				// Unsubscribe from signals.
				case "unsubscribe":
					var nodeId = data.id || "document";
					clientManager.unsubscribe(socketId, webstrateId, nodeId);
					if (data.token) {
						client.send(JSON.stringify({ wa: "reply", token: data.token }));
					}
					break;
				// Send a signal.
				case "publish":
					var nodeId = data.id || "document";
					var message = data.m;
					var recipients = data.recipients;
					clientManager.publish(socketId, webstrateId, nodeId, message, recipients, true);
					break;
				// Signaling on user object.
				case "signalUserObject":
					var message = data.m;
					clientManager.signalUserObject(user.userId, socketId, message, true);
					break;
				// Received cookie update.
				case "cookieUpdate":
					if (data.update && user.userId !== "anonymous") {
						clientManager.updateCookie(user.userId, webstrateId, data.update.key, data.update.value,
						true);
					}
					break;
				// Restoring a document to a previous version.
				case "restore":
					if (!permissions.includes("w")) {
						console.error("Insufficient write permissions in", data.wa, "call");
						client.send(JSON.stringify({ wa: "reply", token: data.token,
							error: "Insufficient write permissions in restore call." }));
						return;
					}
					var version = data.v;
					var tag = data.l;
					// Only one of these should be defined. We can't restore to a version and a tag.
					// version xor tag.
					if (!!version ^ !!tag) {
						var source = `${user.userId} (${stream.remoteAddress})`;
						documentManager.restoreDocument({ webstrateId, tag, version }, source,
							function(err, newVersion) {
							if (err) {
								if (data.token) {
									client.send(JSON.stringify({ wa: "reply", token: data.token,
										error: err.message
									}));
								}
							} else {
								// The permissions of the older version of the document may be different than what
								// they are now, so we should invalidate the cached permissions.
								permissionManager.invalidateCachedPermissions(webstrateId);

								client.send(JSON.stringify({ wa: "reply", reply: newVersion, token: data.token }));
							}
						});
					} else {
						console.error("Can't restore, need either a tag label or version. Not both.");
						if (data.token) {
							client.send(JSON.stringify({ wa: "reply", token: data.token,
								error: "Can't restore, need either a tag label or version. Not both."
							}));
						}
					}
					break;
				// Adding a tag to a document version.
				case "tag":
					if (!permissions.includes("w")) {
						console.error("Insufficient write permissions in", data.wa, "call");
						if (data.token) {
							client.send(JSON.stringify({ wa: "reply", token: data.token,
								error: "Insufficient write permissions in tag call."
							}));
						}
						return;
					}
					var tag = data.l;
					var version = parseInt(data.v);
					// Ensure that label does not begin with a number and that version is a number.
					if (/^\d/.test(tag) || !/^\d+$/.test(version)) {
						return;
					}
					documentManager.tagDocument(webstrateId, version, tag, function(err, res) {
						if (err) {
							console.error(err);
							if (data.token) {
								client.send(JSON.stringify({ wa: "reply", token: data.token, error: err.message }));
							}
						}
					});
					break;
				// Removing a tag from a document version.
				case "untag":
					if (!permissions.includes("w")) {
						return console.error("Insufficient write permissions in", data.wa, "call");
					}
					var tag = data.l;
					if (tag && !/^\d/.test(tag)) {
						documentManager.untagDocument(webstrateId, { tag });
						break;
					}
					var version = parseInt(data.v);
					if (version) {
						documentManager.untagDocument(webstrateId, { version });
						break;
					}
					console.error("Can't restore, need either a tag label or version.");
					break;
			}
		});
	});

	client.on('close', function(reason) {
		clientManager.removeClient(socketId);
		stream.push(null);
		stream.emit('close');
		stream.emit('end');
		stream.end();
		try {
			return client.close(reason);
		} catch (err) {
			console.error(err);
		}
	});

	share.listen(stream);
});

var port = argv.p || config.listeningPort || 7007;
var address = argv.h || config.listeningAddress;
app.server.listen(port, address);
if (WORKER_ID === 1)
	console.log(`Listening on http://localhost:${port}/ in ${threadCount} thread(s)`);