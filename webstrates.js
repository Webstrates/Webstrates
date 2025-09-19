'use strict';

const argv = require('minimist')(process.argv.slice(2));
const bodyParser = require('body-parser');
const cluster = require('cluster');
const express = require('express');
const expressWs = require('express-ws');
const httpAuth = require('http-auth');
const passport = require('passport');
const sessions = require('client-sessions');

global.WORKER_ID = (cluster.worker && cluster.worker.id) || 1;
global.APP_PATH = __dirname;

require('console-stamp')(console, {
	metadata: () => (new Error().stack.split('\n')[3]).trim().substr(3),
	pattern: 'HH:MM:ss',
	colors: {
		stamp: 'yellow',
		label: 'blue',
		metadata: 'grey'
	}
});

process.on('unhandledRejection', (reason, p) => {
	console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

const configHelper = require(APP_PATH + '/helpers/ConfigHelper.js');
const config = global.config = configHelper.getConfig();

const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const sessionManager = require(APP_PATH + '/helpers/SessionManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const httpRequestController = require(APP_PATH + '/helpers/HttpRequestController.js');

// Setting up multi-threading. If config.threads is 0, a thread for each core is created.
var threadCount = 1;
if (typeof config.threads !== 'undefined') {
	threadCount = parseInt(config.threads) || require('os').cpus().length;
	if (!config.pubsub) {
		console.warn('Can\'t run multithreaded without Redis');
	} else {
		threadCount = parseInt(config.threads) || require('os').cpus().length;
		if (cluster.isMaster) {
			for (var i = 0; i < threadCount; ++i) {
				cluster.fork();
			}
			return;
		}
	}
}

var app = express();
expressWs(app);


const middleware = [];

middleware.push(require('./middleware/dosProtectionMiddleware.js'));
middleware.push(require('./middleware/keepAliveMiddleware.js'));
if (config.godApi) {
	middleware.push(require('./middleware/godApiMiddleware.js'));
}
middleware.push(require('./middleware/userHistory.js'));
middleware.push(require('./middleware/userInvites.js'));
middleware.push(require('./middleware/customActionHandlerMiddleware.js'));
middleware.push(require('./middleware/shareDbMiddleware.js'));

/**
 * Execute a type of middleware
 * @param  {string}     type        Type of middleware (onconnect, onmessage, onclose).
 * @param  {array}      args        Array of arguments to be passed to middleware.
 * @params {middleware} middleware  All middleware objects passed in as arguments.
 */
function runMiddleware(type, args, middleware, ...middlewares) {
	if (!middleware) return;
	if (!middleware[type]) return runMiddleware(type, args, ...middlewares);

	middleware[type](...args, () => runMiddleware(type, args, ...middlewares));
}



app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('static', { maxAge: config.maxAge }));

if (config.basicAuth) {
	if (WORKER_ID === 1) console.log('Basic auth enabled');
	var basic = httpAuth.basic({
		realm: config.basicAuth.realm
	}, function(username, password, callback) {
		return callback(username === config.basicAuth.username
			&& password === config.basicAuth.password);
	});
	app.use((req, res, next) => {
		if (!req.ws) {
			httpAuth.connect(basic)(req, res, next);
		}
		else {
			next();
		}
	});
}

if (config.auth) {
	const { secret, duration } = config.auth.cookie;
	app.use(sessions({ secret, duration, cookieName: 'session' }));

	// Work around passport >0.5.3 open issue needing session.regenerate which is not provided by client-sessions
	// https://github.com/jaredhanson/passport/issues/904
	app.use(function(request, response, next) {
		if (request.session && !request.session.regenerate) {
			request.session.regenerate = (cb) => {
				cb()
			}
		}
		if (request.session && !request.session.save) {
			request.session.save = (cb) => {
				cb()
			}
		}
		next()
	})

	passport.serializeUser(sessionManager.serializeUser);
	passport.deserializeUser(sessionManager.deserializeUser);

	for (let key in config.auth.providers) {
		let PassportStrategy, passportInstance;

		if (key === 'test') {
			console.warn('The test auth provider is only for testing purposes and should not be used in production.');
			PassportStrategy = require('passport-local').Strategy;
			passportInstance = new PassportStrategy({
				usernameField: 'username',
				passwordField: 'password'
			}, (username, password, done) => {
				return done(null, {
					username: username,
					userUrl: 'none-for-testing',
					provider: 'test',
					displayName: username,
					id: username
				});
			});
		} else {
			PassportStrategy = require(config.auth.providers[key].node_module).Strategy;
			passportInstance = new PassportStrategy(config.auth.providers[key].config,
				(request, accessToken, refreshToken, profile, done) => {
					profile.provider = key;
					process.nextTick(() => done(null, profile));
				});
		}

		config.auth.providers[key].name = passportInstance.name;
		passport.use(passportInstance);
	}

	app.use(passport.initialize());
	app.use(passport.session());

	for (let key in config.auth.providers) {
		const strategy = config.auth.providers[key].name;

		if (key === 'test') {
			app.get('/auth/test', (req, res) => {
				let referer = req.header('referer');
				if (req.query.webstrateId) {
					const origin = new URL(req.header('referer')).origin;
					referer = origin + '/' + req.query.webstrateId;
				}
				req.session.referer = referer;

				res.send(`
					<html>
						<body>
							<h2>Test Login</h2>
							<form method="post" action="/auth/test">
								<div>
									<label>Username:</label>
									<input type="text" name="username" required>
								</div>
								<div style="display: none;">
									<label>Password:</label>
									<input type="password" name="password" value="test" required>
								</div>
								<button type="submit">Login</button>
							</form>
						</body>
					</html>
				`);
			});

			app.post('/auth/test', passport.authenticate('local', {
				failureRedirect: '/auth/test'
			}), function (req, res) {
				let referer = req.session.referer;
				delete req.session.referer;
				res.redirect(referer || '/');
			});
		} else {
			app.get('/auth/' + key,
				(req, res, next) => {
					let referer = req.header('referer');
					if (req.query.webstrateId) {
						const origin = new URL(req.header('referer')).origin;
						referer = origin + '/' + req.query.webstrateId;
					}
					req.session.referer = referer;
					next();
				},
				passport.authenticate(strategy, config.auth.providers[key].authOptions));
			app.get('/auth/' + key + '/callback', passport.authenticate(strategy, {
				failureRedirect: '/auth/' + key
			}), function (req, res) {
				let referer = req.session.referer;
				delete req.session.referer;
				res.redirect(referer || '/');
			});
		}

		if (WORKER_ID === 1) console.log(strategy + '-based authentication enabled');
	}

	app.get('/auth/logout', function(req, res) {
		req.logout(err => {
			if (err) res.status(500).send("Failure to log out" + err);
			res.redirect(req.header('referer') || '/');
		});
	});
}

// Ensure trailing slash after webstrateId and tag/label.
app.get(/^\/([A-Z0-9._-]+)(\/([A-Z0-9_-]+))?$/i,
	httpRequestController.trailingSlashAppendHandler);


/**
	Middleware for extracting user data from cookies used for Express HTTP requests only.
 */
const sessionMiddleware = function(req, res, next) {
	let webstrateId;

	if (req.params.any?.length>2) webstrateId = req.params.any[1];

	req.remoteAddress = req.remoteAddress || (req.headers && (req.headers['X-Forwarded-For'] ||
		req.headers['x-forwarded-for'])) || (req.connection && req.connection.remoteAddress);

	if (typeof req.user !== 'object') {
		req.user = {};
	}

	if (req.query.token) {
		const userObj = permissionManager.getUserFromAccessToken(webstrateId, req.query.token);
		if (!userObj) {
			if (req.ws) req.ws.close(1002, 'Invalid access token.');
			else res.status(403).send('Invalid access token.');
			return;
		}
		req.user = userObj;
		req.user.token = req.query.token;
	}

	req.user.username = req.user.username || req.user.email || req.user.id || 'anonymous';
	req.user.provider = req.user.providerName || req.user.provider || '';
	req.user.userId = req.user.userId || (req.user.username + ':' + req.user.provider);
	req.webstrateId = webstrateId;
	next();
};


// This middleware gets triggered on both regular HTTP request and websocket connections.
app.use("*any", function(req, res, next) {
	sessionMiddleware(req, res, next);
});

app.ws('/:webstrateId', (ws, req) => {
	const socketId = clientManager.addClient(ws, req, req.user);
	req.socketId = socketId;

	req.socket.setTimeout(30 * 1000);

	// We replace `ws.send` with a function that doesn't throw an exception if the message fails.
	ws.__send = ws.send;
	ws.send = data => {
		try {
			ws.__send(data);
		} catch (err) {
			ws.close(err);
			return false;
		}
		return true;
	};

	ws.on('error', err => {
		ws.close(err);
	});

	ws.on('close', reason => {
		runMiddleware('onclose', [ws, req, reason], ...middleware);
	});

	ws.on('message', data => {
		try {
			data = JSON.parse(data);
		} catch (err) {
			console.error('Received invalid websocket data from', req.socketId + ':', data);
			return;
		}
		runMiddleware('onmessage', [ws, req, data], ...middleware);
	});
	runMiddleware('onconnect', [ws, req], ...middleware);
});

// Move params to req to emulate legacy interface until rest of code has been rewritten to use .params
const queryExtractor = async (req, res, next) => {
	req.webstrateId = req.params.webstrateId;

	// assetName (+ assetPath)
	if (req.params.asset) {
		req.assetName = req.params.asset;
		if (req.params.extension) req.assetName += "." + req.params.extension;
		if (req.params.assetPath) req.assetPath = req.params.assetPath.join("/");
	}

	// version (number) or tag (string)
	req.versionOrTag = req.params.versionOrTag;
	if ("versionOrTag" in req.params) {
		if (/^-?\d+$/.test(req.params.versionOrTag)) {
			req.version = Number(req.params.versionOrTag);
		} else {
			req.tag = req.params.versionOrTag;
		}
	}

	if (req.params.assetOrVersionOrTag && req.params.assetOrVersionOrTag.includes('.')) {
		// If assetOrVersionOrTag contains a dot it is an asset
		req.assetName = req.params.assetOrVersionOrTag;
	} else if (req.params.assetOrVersionOrTag && /^-?\d+$/.test(req.params.assetOrVersionOrTag)) {
		// If it is a number it is a version
		req.version = Number(req.params.assetOrVersionOrTag);
		req.versionOrTag = req.params.assetOrVersionOrTag;
	} else {
		// Otherwise we need to check in the request handler if there is a tag
		req.assetOrTag = req.params.assetOrVersionOrTag;
	}

	next();
};

app.get('/', httpRequestController.rootRequestHandler);
app.get('/new', httpRequestController.newWebstrateGetRequestHandler);
app.post('/new', httpRequestController.newWebstratePostRequestHandler);

// Matches /<webstrateId>/(<versionOrTag>)?//<assetName>)?
// Handles mostly all requests.
app.get([
	'/:webstrateId/:asset.:extension{/*assetPath}',
	'/:webstrateId/:versionOrTag/:asset.:extension{/*assetPath}',
	'/:webstrateId{/:versionOrTag/:asset}',
	'/:webstrateId{/:assetOrVersionOrTag}'
], queryExtractor, httpRequestController.requestHandler);

// We can only post to /<webstrateId>/, because we won't allow users to add assets to old versions
// of a document.
app.post('/:webstrateId',
	queryExtractor,
	function(req, res) {
		if (req.body && 'token' in req.body) {
			return permissionManager.generateAccessToken(req, res);
		}

		if (req.headers['content-type'].startsWith('multipart/form-data;')) {
			return assetManager.assetUploadHandler(req, res);
		}

		return res.status(422).send('Parameter missing from request. No \'token\' or files found.');
	}
);



// Catch all for get.
app.get("*any",function(req, res) {
	res.send('Invalid request URL.');
});

// Catch all for post.
app.post('*any',function(req, res) {
	res.send('You can only post assets to URLs of the form /<webstrateId>/.');
});

app.use((err, req, res, next) => {
	console.log(err, next());
});

var port = argv.p || config.listeningPort || 7007;
var address = argv.h || config.listeningAddress || "localhost";
app.listen(port, address);
if (WORKER_ID === 1)
	console.log(`Listening on http://${address}:${port}/ in ${threadCount} thread(s)`);
