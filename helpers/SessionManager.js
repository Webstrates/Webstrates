'use strict';

const db = require(APP_PATH + '/helpers/database.js');

/**
 * Serializes user object by saving it in the database and returning the id.
 * @param  {object}   user Passport user object.
 * @param  {Function} next Callback.
 * @return {int}        (async) MongoDB ObjectID.
 * @public
 */
module.exports.serializeUser = function(user, next) {
	user.createdAt = new Date();
	user.userId = user.username + ':' + user.provider;
	db.sessions.updateOne({ userId: user.userId }, { $set: user }, { upsert: true }).then(result=>{
		next(null, user.userId);
	}).catch(err=>{
		console.error(err);
		return next(err);
	});
};

/**
 * Deserializes a user object from ObjectID.
 * @param  {int}    userId UserID (username:provider combination).
 * @param  {Function} next Callback.
 * @return {objec}         (async) Passport user object.
 * @public
 */
module.exports.deserializeUser = function(userId, next) {
	db.sessions.findOne({ userId }).then(user=>{
		if (!user) return next(null, null);
		delete user.createdAt;
		next(null, user);
	}).catch(err=>{
	    console.error(err);
	    next && next(err);
	});
};