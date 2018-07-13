'use strict';
const redis = require('redis');
/*
	Rate limiting. Limits the number of messages per interval to avoid clients that have run
	haywire from DoS'ing the server. Also prevents actual malicious users from DoS'ing the server.
*/

const pubsub = global.config.pubsub && {
	publisher: redis.createClient(global.config.pubsub),
	subscriber: redis.createClient(global.config.pubsub)
};

const BANLIST_CHANNEL = 'webstratesBans';

// Map from remoteAddress (IP adresses) to expiration timestamp.
const addressBanList = new Map();
// Map from remoteAddress to number of ops in interval.
const opsList = new Map();

function banClient(remoteAddress, local) {
	const timestamp = Date.now();
	addressBanList.set(remoteAddress, timestamp);

	if (local && pubsub) {
		pubsub.publisher.publish(BANLIST_CHANNEL, JSON.stringify({
			WORKER_ID, remoteAddress, timestamp
		}));
	}
}

if (global.config.rateLimit) {
	exports.onconnect = (ws, req, next) => {
		// Check if the user is banned, then terminate.
		if (addressBanList.has(req.remoteAddress)) {
			// 1013 is the "Try Again Later" error code. It's the best we can do to let the client know
			// they're sending too many messages.
			ws.close(1013);
		}

		next();
	};

	exports.onmessage = (ws, req, data, next) => {
		// If the user has multiple connections open, another connection may have exceeded the limit, so
		// we should check if the address has already been banned and if so disconnect the user.
		if (addressBanList.has(req.remoteAddress)) {
			ws.close(1013);
			return;
		}

		let ops;
		if (!opsList.has(req.remoteAddress)) {
			ops = { ops: 1, signals: 1 };
		} else {
			ops = opsList.get(req.remoteAddress);
			ops.ops++;
			ops.signals++;
		}

		if ((data.a && ops.ops > config.rateLimit.opsPerInterval)
		|| (data.wa && ops.signals > config.rateLimit.signalsPerInterval)) {
			console.log('Blacklisting', req.remoteAddress, 'for exceeding rate limitation.');
			ws.close(1013);
			banClient();
			return;
		}
		next();
	};

	if (pubsub) {
		pubsub.subscriber.subscribe(BANLIST_CHANNEL);
		pubsub.subscriber.on('message', (channel, message) => {
			// Ignore messages on other channels.
			if (channel !== BANLIST_CHANNEL) {
				return;
			}

			message = JSON.parse(message);

			// Ignore messages from ourselves.
			if (message.WORKER_ID === WORKER_ID) {
				return;
			}

			banClient(message.remoteAddress);
		});
	}


	// Reset op and signal counts.
	setInterval(function() {
		opsList.clear();
	}, config.rateLimit.intervalLength);

	// Expire bans.
	setInterval(() => {
		const currentTime = Date.now();
		addressBanList.forEach((remoteAddress, timestamp) => {
			if (timestamp + config.rateLimit.banDuration < currentTime) {
				console.log('Removing', remoteAddress, 'from blacklist');
				addressBanList.delete(remoteAddress);
			}
		});
	}, config.rateLimit.banDuration / 10);

}