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
		user.userId = user.username + ":" + user.provider;
		db.sessions.update({ userId: user.userId }, user, { upsert: true }, function(err, result) {
			if (err) {
				console.error(err);
				return next(err);
			}
			next(null, user.userId);
		});
	};

	/**
	 * Deserializes a user object from ObjectID.
	 * @param  {int}    userId UserID (username:provider combination).
	 * @param  {Function} next Callback.
	 * @return {objec}         (async) Passport user object.
	 * @public
	 */
	module.deserializeUser = function(userId, next) {
		db.sessions.findOne({ userId }, function(err, user) {
			if (!user) return next(null, null);
			delete user.createdAt;
			next(null, user);
		});
	};

	return module;
};