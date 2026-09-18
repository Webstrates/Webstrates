'use strict';

const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const express = require('express');
const expressWs = require('express-ws');
const httpAuth = require('http-auth');
const passport = require('passport');
const sessions = require('client-sessions');

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

// Telemetry counters for unhandled errors, exposed for inspection (e.g. from
// monitoring/debug endpoints).
global.errorTelemetry = { unhandledRejections: 0, uncaughtExceptions: 0 };

/**
 * Format an error-like value for logging: use the (shortened) stack for Errors,
 * and a plain stringification for anything else. Never dumps whole objects.
 * @param  {mixed} err Error or rejection reason.
 * @return {string}    Compact, loggable representation.
 */
const formatError = (err) => {
	if (err instanceof Error) {
		const stack = err.stack || String(err);
		return stack.split('\n').slice(0, 6).join('\n');
	}
	return String(err);
};

process.on('unhandledRejection', (reason) => {
	global.errorTelemetry.unhandledRejections++;
	// Log the rejection reason (with a stack excerpt), not the Promise object,
	// which prints as a multi-line blob that buries the useful information.
	console.error(`Unhandled rejection (#${global.errorTelemetry.unhandledRejections}):`,
		formatError(reason));
});

process.on('uncaughtException', (err, origin) => {
	global.errorTelemetry.uncaughtExceptions++;
	// The process may be in an inconsistent state after an uncaught exception,
	// so we log the context and then exit deliberately rather than keep running.
	const at = global.errorTelemetry.uncaughtExceptions;
	const originSuffix = origin ? ` (origin: ${origin})` : '';
	console.error(`Uncaught exception (#${at})${originSuffix}:`, formatError(err));
	process.exit(1);
});

const configHelper = require(APP_PATH + '/helpers/ConfigHelper.js');
const config = global.config = configHelper.getConfig();

const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const sessionManager = require(APP_PATH + '/helpers/SessionManager.js');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');
const userValidation = require(APP_PATH + '/helpers/UserValidation.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');
const httpRequestController = require(APP_PATH + '/helpers/HttpRequestController.js');

const app = express();
const wsInstance = expressWs(app);


const middleware = [];

middleware.push(require('./middleware/dosProtectionMiddleware.js'));
middleware.push(require('./middleware/keepAliveMiddleware.js'));
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

// Serve the pre-compressed client bundle (webstrates.js.br, emitted by the
// webpack build) to browsers that accept brotli
app.get('/webstrates.js', (req, res, next) => {
	if (!(req.headers['accept-encoding'] || '').includes('br')) return next();
	const compressedPath = path.join(APP_PATH, 'static', 'webstrates.js.br');
	fs.readFile(compressedPath, (err, data) => {
		if (err) return next();
		res.set('Content-Type', 'text/javascript; charset=UTF-8');
		res.set('Content-Encoding', 'br');
		res.set('Vary', 'Accept-Encoding');
		res.set('Cache-Control', 'public, max-age=186400');
		res.end(data);
	});
});

app.use(express.static('static', { maxAge: config.maxAge }));

if (config.basicAuth) {
	console.log('Basic auth enabled');
	var basic = httpAuth.basic({
		realm: config.basicAuth.realm
	}, function (username, password, callback) {
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
	app.use(function (request, response, next) {
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
				// Usernames containing apostrophes, quotes or ampersands are not valid usernames
				// in this system, they corrupt the data-auth permission parsing of every
				// document they are granted permissions in. 
				if (!userValidation.isValidUsername(username)) {
					return done(null, false, {
						message: 'Usernames may not contain apostrophes, quotes or ampersands.'
					});
				}
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

		console.log(strategy + '-based authentication enabled');
	}

	app.get('/auth/logout', function (req, res) {
		req.logout(err => {
			if (err) res.status(500).send('Failure to log out' + err);
			res.redirect(req.header('referer') || '/');
		});
	});
}

// Ensure trailing slash after webstrateId and tag/label.
app.get(/^\/([A-Z0-9._-]+)(\/([A-Z0-9_-]+))?$/i, httpRequestController.trailingSlashAppendHandler);


/**
 * Middleware for extracting user data from cookies used for Express HTTP requests only.
 */
const sessionMiddleware = function (req, res, next) {
	let webstrateId;

	if (req.params.any?.length > 2) webstrateId = req.params.any[1];

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

	// Establish the username for this request: the first of the user's username, email or id
	// that is a valid username in this system, or 'anonymous'. 
	req.user.username = userValidation.getEffectiveUsername(req.user);
	req.user.provider = req.user.providerName || req.user.provider || '';
	req.user.userId = req.user.username + ':' + req.user.provider;
	req.params.webstrateId = webstrateId;
	next();
};


// This middleware gets triggered on both regular HTTP request and websocket connections.
app.use('*any', function (req, res, next) {
	sessionMiddleware(req, res, next);
});

// The ws library completes the websocket upgrade (the 101 response) before Express runs
// the middleware chain that ends in the app.ws() handler below, and that chain is partly
// asynchronous (deserializing the user's session is a database query). A client that sends
// its first frame immediately after the handshake can therefore have that frame emitted
// into the socket before the handler has attached its 'message' listener, where the
// EventEmitter silently drops it. Buffer such early frames on the socket and replay them
// once the connection is fully set up (see the app.ws() handler below), instead of losing
// them and waiting for the client's own retry or the socket timeout.
const earlyFrames = new WeakMap();

wsInstance.getWss().on('connection', (ws) => {
	// When the middleware chain completes synchronously (connections without a login
	// cookie), the app.ws() handler has already attached its 'message' listener by the
	// time this listener runs, and there is no window to guard against.
	if (ws.listenerCount('message') > 0) return;

	const guard = { listener: null, frames: [] };
	guard.listener = (data) => {
		guard.frames.push(data);
	};
	earlyFrames.set(ws, guard);
	ws.on('message', guard.listener);
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

	// The connection is not fully set up until the 'onconnect' middleware below has
	// run (the ShareDB stream is registered there). Frames arriving before that —
	// including any held by the early-frame guard above — must wait, so they are
	// processed in order and not ahead of the connection setup.
	let connectionReady = false;

	ws.on('message', data => {
		if (!connectionReady) return;
		try {
			data = JSON.parse(data);
		} catch (err) {
			console.error('Received invalid websocket data from', req.socketId + ':', data);
			return;
		}
		runMiddleware('onmessage', [ws, req, data], ...middleware);
	});

	// The last middleware in the 'onconnect' chain: the connection is now fully set
	// up, so the listener above takes over and any frames the guard buffered while
	// the middleware chain was still running are delivered in arrival order.
	const replayEarlyFrames = {
		onconnect: (ws, req, next) => {
			connectionReady = true;
			const guard = earlyFrames.get(ws);
			if (guard) {
				earlyFrames.delete(ws);
				ws.removeListener('message', guard.listener);
				for (const frame of guard.frames) {
					ws.emit('message', frame);
				}
			}
			next();
		}
	};
	runMiddleware('onconnect', [ws, req], ...middleware, replayEarlyFrames);
});

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
], httpRequestController.requestHandler);

// We can only post to /<webstrateId>/, because we won't allow users to add assets to old versions
// of a document.
app.post('/:webstrateId', function (req, res) {
	if (req.body && 'token' in req.body) {
		return permissionManager.generateAccessToken(req, res);
	}

	// The Content-Type header is optional (curl can be told to omit it, and so can any raw
	// HTTP client), so we must not dereference req.headers['content-type'] unconditionally.
	if ((req.headers['content-type'] || '').startsWith('multipart/form-data;')) {
		return assetManager.assetUploadHandler(req, res);
	}

	return res.status(422).send('Parameter missing from request. No \'token\' or files found.');
});

// Catch all for get.
app.get('*any', function (req, res) {
	res.send('Invalid request URL.');
});

// Catch all for post.
app.post('*any', function (req, res) {
	res.send('You can only post assets to URLs of the form /<webstrateId>/.');
});

// Error middleware: log the error and respond with a 500. Previously this middleware called
// next() (as an argument to console.log) and never sent a response, so the request fell
// through the router and the client got a misleading 404 error page.
app.use((err, req, res, next) => {
	console.error(err);
	if (res.headersSent) {
		return next(err);
	}
	res.status(500).send('Internal server error.');
});

const port = argv.p || config.listeningPort || 7007;
const address = argv.h || config.listeningAddress || 'localhost';
app.listen(port, address);
console.log(`Listening on http://${address}:${port}/`);
