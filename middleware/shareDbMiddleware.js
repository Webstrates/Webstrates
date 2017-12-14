'use strict';

const Duplex = require('stream').Duplex;
const clientManager = require(APP_PATH + '/helpers/ClientManager.js');
const shareDbWrapper = require(APP_PATH + '/helpers/ShareDBWrapper.js');

const streams = new Map();

exports.onconnect = (ws, req, next) => {
	if ('noop' in req.query) return next();

	const stream = new Duplex({
		objectMode: true
	});

	streams.set(req.socketId, stream);

	// This might be unnecessary.
	['error', 'end', 'finish'].forEach(type => {
		stream.on(type, msg => {
			clientManager.removeClient(req.socketId);
		});
	});

	stream._write = function(chunk, encoding, callback) {
		try {
			ws.send(JSON.stringify(chunk));
		} catch (err) {
			console.error(err);
		}
		callback();
	};

	stream._read = function() {};

	shareDbWrapper.listen(stream, req);
	next();
};

exports.onmessage = (ws, req, data, next) => {
	if ('noop' in req.query) return next();

	const stream = streams.get(req.socketId);
	if (stream) {
		// Ensuring the client is using the right collection.
		//if (data.c) data.c = 'webstrates';

		stream.push(data);
	}
	next();
};

exports.onclose = (ws, req, reason, next) => {
	if ('noop' in req.query) return next();

	const stream = streams.get(req.socketId);
	if (stream) {
		stream.push(null);
		stream.emit('close');
		stream.emit('end');
		stream.end();
	}
	next();
};