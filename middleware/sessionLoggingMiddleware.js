'use strict';
/*
	Middleware for logging userIds of connected clients. Makes it possible to map sessionIds to
	userIds. Used when getting ops list.
 */
const { db } = global.helpers;

function insertLog(log, attempts = 3) {
	if (!db.sessionLog) return insertLog(log, attempts - 1);
	db.sessionLog.insert(log, (err, db) => {
		if (err) return insertLog(log, attempts - 1);
	});
}

exports.onconnect = (ws, req, next) => {
	insertLog({
		sessionId: req.agent.clientId,
		userId: req.user.userId,
		connectTime: req.agent.connectTime,
		remoteAddress: req.remoteAddress
	});
	next();
};