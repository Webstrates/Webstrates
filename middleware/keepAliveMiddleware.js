'use strict';

exports.onmessage = (ws, req, data, next) => {
	if (!data || data.type === 'alive') return;
	next();
};