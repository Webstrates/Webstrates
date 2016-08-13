"use strict";

var Duplex = require('stream').Duplex;
var express = require('express');
var argv = require('optimist').argv;
var sharedb = require('sharedb');
var sharedbMongo = require('sharedb-mongo');
var jsonml = require('jsonml-tools');
var httpAuth = require('http-auth');
var WebSocketServer = require('ws').Server;
var http = require('http');
var passport = require('passport');
var sessions = require("client-sessions");
var fs = require("fs-sync");
var MongoClient = require('mongodb').MongoClient;

if (!fs.exists("config.json")) {
	console.warn("No config file present, creating one now.");
	if (!fs.exists("config-sample.json")) {
		console.warn("Sample config not present either, creating empty config.")
		fs.write("config.json", "{}");
	} else {
		fs.copy("config-sample.json", "config.json");
	}
}
var config = fs.readJSON("config.json");

var WEBSTRATE_DB = config.db || "mongodb://localhost:27017/webstrate";

var share = sharedb({
	db: sharedbMongo(WEBSTRATE_DB)
});
var agent = share.connect();

var sessionLog = {};
MongoClient.connect(WEBSTRATE_DB, function(err, db) {
	if (err)
		throw err;
	sessionLog.coll = db.collection('sessionLog');
});

var clientManager = require("./helpers/ClientManager.js");
var documentManager = require("./helpers/DocumentManager.js")(share, agent, sessionLog);
var permissionManager = require("./helpers/PermissionManager.js")(documentManager, config.auth);
var cookieHelper = require("./helpers/CookieHelper.js")(config.auth ? config.auth.cookie : {});

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
			return res.redirect('/');
		});
		console.log(provider + "-based authentication enabled");
	}

	app.get('/auth/logout', function(req, res) {
		req.logout();
		return res.redirect('/');
	});

	auth = true;
}

share.use('connect', function(req, next) {
	var insertFn = function() {
		if (!sessionLog.coll) {
			return process.nextTick(insertFn);
		}

		sessionLog.coll.insert({
			sessionId: req.agent.clientId,
			userId: req.userId,
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
});

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

share.use(['receive', 'fetch', 'bulk fetch', 'getOps', 'query', 'submit', 'delete'],
	function(req, next) {
	sessionMiddleware(req, next);
});

app.use(function(req, res, next) {
	sessionMiddleware(req, next);
});

share.use(['receive', 'fetch', 'bulk fetch', 'getOps', 'query', 'submit', 'delete'],
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
			case "getOps": // Operations request
			case "query": // Document request
				if (permissions.indexOf("r") !== -1) {
					return next();
				}
				break;
			case "submit": // Operation submission
				if (permissions.indexOf("w") !== -1) {
					return next();
				}
				break;
			case "receive":
				// u = unsubscribe
				if (req.data.a === "u") {
					clientManager.removeClientFromWebstrate(req.data.socketId, req.webstrateId);
					return;
				}

				if (req.data.a !== "s") {
					return next();
				}

				// Initial document request (s = subscribe)
				if (req.data.a === "s" && permissions.indexOf("r") !== -1) {
					clientManager.addClientToWebstrate(req.data.socketId, req.webstrateId);
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

app.get('/favicon.ico', function(req, res) {
	return res.status(404).send("");
});

app.get('/new', function(req, res) {
	var webstrateId = req.query.id;
	var prototypeId = req.query.prototype;
	var version = req.query.v === "" ? "" : (Number(req.query.v) || undefined);

	var permissions = permissionManager.getDefaultPermissions(req.user.username, req.user.provider);

	if (permissions.indexOf("w") === -1) {
		return res.send("Permission denied");
	}

	documentManager.createNewDocument({
		webstrateId,
		prototypeId,
		version
	}, function(err, webstrateId) {
		if (err) {
			console.error(err);
			return res.status(409).send(err);
		}

		if (!prototypeId) {
			return res.redirect('/' + webstrateId);
		}

		permissionManager.addPermissions(req.user.username, req.user.provider, permissions,
			webstrateId, function(err, ops) {
			if (err) {
				console.error(err);
				return res.status(409).send(err);
			}
			return res.redirect('/' + webstrateId);
		});
	});
});

app.get('/:id', function(req, res) {
	var webstrateId = req.params.id;
	var version = req.query.v === "" ? "" : (Number(req.query.v) || undefined);

	if (!webstrateId) {
		return res.redirect('/frontpage');
	}

	documentManager.getDocument({
		webstrateId,
		version
	}, function(err, snapshot) {
		if (err) {
			console.error(err);
			return res.status(409).send(err);
		}

		// TODO: We could use getPermissionsFromSnapshot and save a database call here.
		permissionManager.getPermissions(req.user.username, req.user.provider, webstrateId,
			function(err, permissions) {
			if (err) {
				console.error(err);
				return res.status(409).send(err);
			}

			// If the webstrate doesn't exist, write permissions are required to create it.
			if (!snapshot.type && permissions.indexOf("w") === -1) {
				return res.send("Permission denied");
			}

			// If the webstrate does exist, read permissions are required to access it.
			if (permissions.indexOf("r") === -1) {
				return res.send("Permission denied");
			}

			if (typeof version !== "undefined") {
				// If version is set, but not defined (i.e. "/myWebstrate?v"), the user is requesting the
				// current version number.
				if (version == "") {
					return res.send(String(snapshot.v));
				}

				// If the version is set and defined, we generate the version on the server and return it.
				// Note that this returned version will not be interactive -- operations performed on it
				// will not be saved.
				return res.send(jsonml.toXML(snapshot.data, ["area", "base", "br", "col", "embed", "hr",
					"img", "input", "keygen", "link", "menuitem", "meta", "param", "source", "track",
					"wbr"]));
			}

			if (typeof req.query.ops !== "undefined") {
				return documentManager.getOps({
					webstrateId,
					version
				}, function(err, ops) {
					if (err) {
						console.error(err);
						return res.status(409).send(err);
					}
					res.send(ops);
				});
			}

			res.setHeader("Location", '/' + webstrateId);
			return res.sendFile(__dirname + "/static/client.html");
		});
	});
});

app.get('/', function(req, res) {
	return res.redirect('/frontpage');
});

var wss = new WebSocketServer({
	server: app.server
});

wss.on('connection', function(client) {
	var socketId = clientManager.addClient(client);

	client.on('message', function(data) {
		data = JSON.parse(data);

		// ignore alive messages
		if (data.type && data.type === 'alive') {
			return;
		}

		// Adding socketId to every incoming message
		data.socketId = socketId;
		return stream.push(JSON.stringify(data));
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

	var stream = new Duplex({
		objectMode: true
	});

	stream.session = cookieHelper.decodeCookie(client.upgradeReq.headers.cookie);
	stream.headers = client.upgradeReq.headers;
	stream.remoteAddress = client.upgradeReq.connection.remoteAddress;

	stream._write = function(chunk, encoding, callback) {
		try {
			client.send(JSON.stringify(chunk));
		} catch (error) {
			console.error(error);
		}
		return callback();
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

	share.listen(stream);
});

var port = argv.p || 7007;
app.server.listen(port);
console.log("Listening on http://localhost:" + port + "/");
