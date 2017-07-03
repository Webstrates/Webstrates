var MongoClient = require('mongodb').MongoClient;

var db = {};

module.exports = function(DB_ADDRESS) {

	// Return database object prematurely if it has already been initialized.
	if (Object.keys(db).length > 0 && typeof DB_ADDRESS === 'undefined')  {
		return db;
	}

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

		db.sessions = _db.collection('sessions');
		db.sessions.ensureIndex({ userId: 1, createdAt: 1/*, *expireAfterSeconds: 60 * 60 * 24 * 365 */});

		db.messages = _db.collection('messages');
		db.messages.ensureIndex({ createdAt: 1, expireAfterSeconds: 60 * 60 * 24 * 30 });

		db.cookies = _db.collection('cookies');
		db.cookies.ensureIndex({ userId: 1, webstrateId: 1 }, { unique: true });
	});

	return db;
};