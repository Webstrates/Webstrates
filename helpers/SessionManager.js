"use strict";

var ObjectID = require('mongodb').ObjectID;

/**
 * AssetManager constructor.
 * @constructor
 */
module.exports = function(db) {
	var module = {};

	/**
	 * Serializes user object by saving it in the database and returning the id.
	 * @param  {object}   user Passport user object.
	 * @param  {Function} next Callback.
	 * @return {int}        (async) MongoDB ObjectID.
	 * @public
	 */
	module.serializeUser = function(user, next) {
		user.createdAt = new Date();
		db.sessions.insertOne(user, function(err, result) {
			if (err) return next(err);			//console.log("Saving", result.insertedId);
			next(null, result.insertedId)
		});
	};

	/**
	 * Deserializes a user object from ObjectID.
	 * @param  {int}   id      MongoDB ObjectID as an integer.
	 * @param  {Function} next Callback.
	 * @return {objec}         (async) Passport user object.
	 * @public
	 */
	module.deserializeUser = function(id, next) {
		//return next(null, id);
		if (!ObjectID.isValid(id)) {
			console.log("Invalid serialization", id);
			return next(null, null);
		}
		db.sessions.findOne(ObjectID(id), function(err, user) {
			if (!user) return next(null, null);
			delete user.createdAt;
			next(null, user);
		});
	};

	return module;
};