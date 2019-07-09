'use strict';
/*
	Middleware for user activity history, i.e. when users last participated in webstrates.
	Records acitivities in the database, but also replies to requests for the user activity history.
 */
const db = require(APP_PATH + '/helpers/database.js');

const updateMap = new Map();

exports.onmessage = async (ws, req, data, next) => {
	const userId = req.user && req.user.userId;

	if (data.wa && data.wa === 'userHistory') {
		const limit = Number(data.options && data.options.limit) || 50;
		//const result = await db.userHistory.findOne({ userId }, { webstrates: { $slice: 10 } });
		console.log(data);
		const result = await db.userHistory.aggregate([
			{ $match: { userId } },
			{ $project: { webstrates: { $objectToArray: '$webstrates' } } },
			{ $unwind: '$webstrates' },
			{ $replaceRoot: { newRoot: '$webstrates' } },
			{ $sort: { 'v' : -1 } },
			{ $limit: limit }
		]).toArray();

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
		const $set = {};
		$set[`webstrates.${webstrateId}`] = now;

		db.userHistory.update({ userId }, { $set }, { upsert: true }, (err, res) => {
			if (err) console.error(err);
		});
	}

	next();
};