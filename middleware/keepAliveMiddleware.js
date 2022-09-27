'use strict';

exports.onmessage = (ws, req, data, next) => {
	if (data.type === 'alive') return;
	next();
};