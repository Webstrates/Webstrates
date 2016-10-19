"use strict";

var argv = require('optimist').argv;
var Duplex = require('stream').Duplex;
var express = require('express');
var fs = require("fs");
var fss = require("fs-sync");
var http = require('http');
var httpAuth = require('http-auth');
var jsonml = require('jsonml-tools');
var MongoClient = require('mongodb').MongoClient;
var passport = require('passport');
var sessions = require("client-sessions");
var sharedb = require('sharedb');
var sharedbMongo = require('sharedb-mongo');
var shortId = require('shortid');
var WebSocketServer = require('ws').Server;

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
	console.warn("No config file present, creating one now.");
	if (!fss.exists(APP_PATH + "/config-sample.json")) {
		console.warn("Sample config not present either, creating empty config.")
		fss.write(APP_PATH + "/config.json", "{}");
	} else {
		fss.copy(APP_PATH + "/config-sample.json", APP_PATH + "/config.json");
	}
}

var config = fss.readJSON(APP_PATH + "/config.json");

var WEBSTRATE_DB = config.db || "mongodb://localhost:27017/webstrate";

var share = sharedb({
	db: sharedbMongo(WEBSTRATE_DB)
});
var agent = share.connect();

var db = {};
MongoClient.connect(WEBSTRATE_DB, function(err, _db) {
	if (err)
		throw err;
	db.sessionLog = _db.collection('sessionLog');
	db.tags = _db.collection('tags');
	db.tags.ensureIndex({ webstrateId: 1, label: 1 }, { unique: true });
	db.tags.ensureIndex({ webstrateId: 1, v: 1 }, { unique: true });
});

var cookieHelper = require("./helpers/CookieHelper.js")(config.auth ? config.auth.cookie : {});
var clientManager = require("./helpers/ClientManager.js")(cookieHelper);
var documentManager = require("./helpers/DocumentManager.js")(clientManager, share, agent, db);
var permissionManager = require("./helpers/PermissionManager.js")(documentManager, config.auth);

var httpRequestController = require("./helpers/HttpRequestController.js")(documentManager,
	permissionManager);


var app = express();
app.server = http.createServer(app);
app.use(express.static("build"));
app.use(express.static("static"));

if (config.basicAuth) {
	console.log("Basic auth enabled");
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
		console.log(provider + "-based authentication enabled");
	}

	app.get('/auth/logout', function(req, res) {
		req.logout();
		return res.redirect("/");
	});

	auth = true;
}

app.get("/", httpRequestController.rootRequestHandler);
app.get('/new', httpRequestController.newWebstrateRequestHandler);
app.get('/favicon.ico', httpRequestController.faviconRequestHandler);
// :id is a catch all, so it must come last.
app.get('/:id', httpRequestController.idRequestHandler);

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
	var username = "anonymous",
		provider = "";

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

app.use(function(req, res, next) {
	sessionMiddleware(req, next);
});

share.use('connect', function(req, next) {
	sessionLoggingMiddleware(req, next)
});

var webstrateActivites = {};
var AUTO_TAGGING_PREFIX = config.tagging && config.tagging.tagPrefix || "Session of ";
var AUTO_TAGGING_INTERVAL = config.tagging && config.tagging.autotagInterval || 3600;
share.use('op', function(req, next) {
	var webstrateId = req.op.d;
	var timestamp = Date.now();

	if (!webstrateActivites[webstrateId] || webstrateActivites[webstrateId] +
		AUTO_TAGGING_INTERVAL * 1000 < timestamp) {
		var version = req.op.v;
		var label = AUTO_TAGGING_PREFIX + new Date(timestamp);
		documentManager.tagDocument(webstrateId, req.op.v, label);
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
						if (permissions.indexOf("r") !== -1) {
							return next();
						}
						break;
					case "submit": // Operation submission.
						if (permissions.indexOf("w") !== -1) {
							return next();
						}
						break;
					case "receive":
						// u = unsubscribe.
						if (req.data.a === "u") {
							clientManager.removeClientFromWebstrate(req.data.socketId, req.webstrateId);
							return;
						}

						// Check if the incoming update is an op (and not a create op).
						if (req.data.a === "op" && req.data.op) {
							// Check if the update changes the permissions of the document.
							var permissionsChanged = req.data.op.some(function(op) {
								return op.p[0] && op.p[0] === 1 && op.p[1] && op.p[1] === "data-auth";
							});
							// And if the permissions have changed, invalidate the permissions cache.
							if (permissionsChanged) {
								permissionManager.invalidateCachedPermissions(req.webstrateId);
							}
						}

						// Anything but a subscribe request.
						if (req.data.a !== "s") {
							return next();
						}

						// Initial document request (s = subscribe).
						if (req.data.a === "s" && permissions.indexOf("r") !== -1) {
							return documentManager.getTags(req.data.d, function(err, tags) {
								if (err) console.error(err);
								if (tags) {
									clientManager.sendToClient(req.data.socketId, {
										wa: "tags",
										d: req.data.d,
										tags: tags
									});
								}
								clientManager.addClientToWebstrate(req.data.socketId, req.webstrateId);
								next();
							});
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

var wss = new WebSocketServer({
	server: app.server
});

wss.on('connection', function(client) {
	var socketId = clientManager.addClient(client);

	var stream = new Duplex({
		objectMode: true
	});

	var cookie = cookieHelper.decodeCookie(client.upgradeReq.headers.cookie);
	var user = (cookie && cookie.passport.user) || {};
	stream.session = cookie;
	stream.headers = client.upgradeReq.headers;
	stream.remoteAddress = client.upgradeReq.connection.remoteAddress;

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

	client.on('message', function(data) {
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
					clientManager.publish(socketId, webstrateId, nodeId, message, recipients);
					break;
				// restoreing a document to a previous version.
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
						var source = user.userId;
						documentManager.restoreDocument({ webstrateId, tag, version }, source,
							function(err, newVersion) {
							if (err) {
								console.error(err);
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
						console.error("Can't restore, need either a tag label or version.");
						if (data.token) {
								client.send(JSON.stringify({ wa: "reply", token: data.token,
									error: "Can't restore, need either a tag label or version."
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

var port = argv.p || 7007;
app.server.listen(port);
console.log("Listening on http://localhost:" + port + "/");
