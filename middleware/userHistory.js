'use strict';
/*
	Middleware for user activity history, i.e. when users last participated in webstrates.
	Records acitivities in the database, but also replies to requests for the user activity history.
 */
const db = require(APP_PATH + '/helpers/database.js');

const updateMap = new Map();

/**
 * Coerce a client-supplied history limit into a positive integer. The $limit stage of the
 * history aggregation rejects anything that is not a positive integer, so missing,
 * non-numeric and infinite requests fall back to the default of 50, while zero and negative
 * requests are clamped up to 1 instead of being handed to the database to fail on.
 * @param  {mixed}  requested Limit as sent by the client (any type).
 * @return {number}           Positive integer limit.
 * @private
 */
const sanitizeLimit = (requested) => {
	const limit = Math.floor(Number(requested)) || 50;
	return Number.isFinite(limit) ? Math.max(limit, 1) : 50;
};

exports.onmessage = async (ws, req, data, next) => {
	const userId = req.user && req.user.userId;

	if (data.wa && data.wa === 'userHistory') {
		const limit = sanitizeLimit(data.options && data.options.limit);

		let result;
		try {
			result = await db.userHistory.aggregate([
				{ $match: { userId } },
				{ $project: { webstrates: { $objectToArray: '$webstrates' } } },
				{ $unwind: '$webstrates' },
				{ $replaceRoot: { newRoot: '$webstrates' } },
				{ $sort: { 'v' : -1 } },
				{ $limit: limit }
			]).toArray();
		} catch (err) {
			console.error(err);
			// Even if the aggregation fails, the client is waiting for a reply.
			ws.send(JSON.stringify({
				wa: 'reply',
				error: err.message,
				token: data.token
			}));

			// We don't want to call next() here.
			return;
		}

		const obj = {};
		result.forEach(({k, v}) => {
			obj[k] = v;
		});

		ws.send(JSON.stringify({
			wa: 'reply',
			reply: obj,
			token: data.token
		}));

		// We don't want to call next() here.
		return;
	}

	if (data.a && data.a === 'op' && data.d && userId && req.user.provider !== '') {
		const userId = req.user.userId;
		const webstrateId = data.d;
		const now = new Date();

		// Webstrate ids are URL segments and may contain dots (or begin with a dollar
		// sign), and a classic $set path like `webstrates.${webstrateId}` makes MongoDB
		// store *nested* subdocuments for such ids ({webstrates: {a: {b: {c: …}}}}) instead
		// of the flat key the history aggregation above expects — those webstrates would
		// never show up in the history listing. A pipeline update with $setField keeps the
		// key flat for any id ($literal keeps ids beginning with a dollar sign from being
		// read as field path references). $setField requires MongoDB 5.0+; on older servers
		// the write fails, gets logged, and user history is simply not recorded.
		try {
			await db.userHistory.updateOne({ userId }, [
				{ $set: { webstrates: { $setField: {
					field: { $literal: webstrateId },
					input: { $ifNull: ['$webstrates', {}] },
					value: now
				} } } }
			], { upsert: true });
		} catch (err){
			console.error(err);
		};
	}

	next();
};
