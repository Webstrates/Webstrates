'use strict';

const MongoClient = require('mongodb').MongoClient;
const db = {};

module.exports = db;

MongoClient.connect(global.config.db).then(client =>{
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

	db.invites = _db.collection("invites");
	db.invites.createIndex({key: 1}, {unique: true});
	db.invites.createIndex({webstrateId: 1, key: 1});
	db.invites.createIndex({expiresAt: 1});


}).catch(err => {
        // This catch block WILL fire if there's a connection error or a timeout
        console.error("[ERROR] MongoDB Connection Failed (or timed out):", err);
        // Include the full error object for more details
        console.error("[ERROR] Error details:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
        throw err; // Re-throw to stop the application if connection is critical
        });;
