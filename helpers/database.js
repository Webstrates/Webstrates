'use strict';

const MongoClient = require('mongodb').MongoClient;
const db = {};

module.exports = db;

MongoClient.connect(global.config.db, { useUnifiedTopology: true }, function(err, client) {
	if (err)
		throw err;

	let _db = client.db();

	db.sessionLog = _db.collection('sessionLog');
	db.webstrates = _db.collection('webstrates');

	db.ops = _db.collection('ops');

	db.tags = _db.collection('tags');
	db.tags.createIndex({ webstrateId: 1, label: 1 }, { unique: true });
	db.tags.createIndex({ webstrateId: 1, v: 1 }, { unique: true });

	db.assets = _db.collection('assets');
	db.assets.createIndex({ webstrateId: 1, originalFileName: 1, v: 1 }, { unique: true });
	db.assetsCsv = _db.collection('assetsCsv');
	db.assetsCsv.createIndex({ _assetId: 1 });

	db.sessions = _db.collection('sessions');
	db.sessions.createIndex({ userId: 1, createdAt: 1/*, *expireAfterSeconds: 60 * 60 * 24 * 365 */});

	db.messages = _db.collection('messages');
	db.messages.createIndex({ createdAt: 1, expireAfterSeconds: 60 * 60 * 24 * 30 });

	db.cookies = _db.collection('cookies');
	db.cookies.createIndex({ userId: 1, webstrateId: 1 }, { unique: true });

	db.userHistory = _db.collection('userHistory');
	db.userHistory.createIndex({ userId: 1, }, { unique: true });
});
