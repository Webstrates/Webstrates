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
	db.sessions.createIndex({ userId: 1, createdAt: 1 });
	// Expire sessions 365 days after the last login, as originally intended. A TTL index must be
	// single-field with expireAfterSeconds as an option — the value sat commented out in the key
	// spec above, where it could never have worked (and as a compound key it wouldn't either).
	db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

	db.messages = _db.collection('messages');
	// Messages expire after 30 days. expireAfterSeconds is an index option, not a key —
	// previous releases misplaced it in the key spec, creating a plain compound index on a
	// bogus "expireAfterSeconds" field, so messages never expired.
	db.messages.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 })
		// Drop the non-TTL index pre-fix releases left behind (it indexes a nonexistent
		// expireAfterSeconds field for nothing). Only the TTL index remains.
		.then(() => db.messages.indexes())
		.then(indexes => Promise.all(indexes
			.filter(index => index.name !== '_id_' && !index.expireAfterSeconds)
			.map(index => db.messages.dropIndex(index.name))))
		.catch(err => console.error('Failed to ensure the messages TTL index:', err));

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
