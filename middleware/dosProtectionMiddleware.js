'use strict';
/*
	Rate limiting. Limits the number of messages per interval to avoid clients that have run
	haywire from DoS'ing the server. Also prevents actual malicious users from DoS'ing the server.

	Counters and bans are keyed on req.remoteAddress, so all connections from one address (every
	tab of a browser, or every client behind a NAT or proxy) share the same budgets. An address
	that exceeds a budget is banned: its connections are disconnected and further connections
	from the address are torn down without processing until the ban expires.

	Note that remoteAddress is taken from X-Forwarded-For when present, falling back to the
	socket's address (webstrates.js, sessionMiddleware). Behind nginx/apache the proxy MUST set
	X-Forwarded-For to the client address (and overwrite, not append to, a client-supplied
	value): without it every user shares the proxy's single budget, and one flooding client
	bans the whole deployment for banDuration. With the header set, each client gets its own
	budget — but a client that can inject its own X-Forwarded-For value still gets a fresh
	budget per value, and the raw header is used as the key without parsing multi-hop
	comma-separated chains. Handle those by terminating client-supplied XFF at your proxy.
*/

// Map from remoteAddress (IP addresses) to the timestamp the ban was issued at.
const addressBanList = new Map();
// Map from remoteAddress to the { ops, signals } message count of the current interval.
const opsList = new Map();

function banClient(remoteAddress) {
	addressBanList.set(remoteAddress, Date.now());
	// The counters have run over the limit, so leaving them would re-ban the address on its
	// first message once the ban expires (the interval boundary can lie well beyond
	// banDuration, silently extending the ban). A lifted ban means a fresh budget.
	opsList.delete(remoteAddress);
}

const rateLimit = global.config && global.config.rateLimit;
const rateLimitConfigured = rateLimit && ['opsPerInterval', 'signalsPerInterval', 'intervalLength',
	'banDuration'].every(field => Number.isFinite(rateLimit[field]) && rateLimit[field] > 0);

if (rateLimitConfigured) {
	exports.onconnect = (ws, req, next) => {
		if (!addressBanList.has(req.remoteAddress)) return next();

		// The address is banned, so terminate the connection without running any further
		// middleware. We terminate rather than close: the client was already told why it was
		// disconnected with the 1013 close code when the ban was issued, and a banned client
		// that keeps reconnecting gets its socket torn down right away instead of holding it
		// in a closing handshake (up to the 30 s socket timeout, if it never responds).
		ws.terminate();
	};

	exports.onmessage = (ws, req, data, next) => {
		// If the user has multiple connections open, another connection may have exceeded the
		// limit, so we should check if the address has already been banned and if so disconnect
		// the user. Frames of a flood may still be in flight after the offending connection was
		// closed, so they get dropped here too. (A connection that refuses to complete the close
		// handshake is torn down by the 30 s socket timeout; new connections from the address
		// are terminated on connect.)
		if (addressBanList.has(req.remoteAddress)) {
			ws.close(1013);
			return;
		}

		// ShareDB messages (data.a: ops, subscribes, fetches, ...) count against the ops budget,
		// Webstrates actions (data.wa: signals, ...) against the signals budget. Anything else
		// counts as an op: leaving a message type uncounted would be a trivial way around the
		// limit, and even keep-alives still cost a parse.
		const counters = opsList.get(req.remoteAddress) || { ops: 0, signals: 0 };
		if (data.wa) counters.signals++;
		else counters.ops++;
		opsList.set(req.remoteAddress, counters);

		if (counters.ops > rateLimit.opsPerInterval
		|| counters.signals > rateLimit.signalsPerInterval) {
			console.log('Blacklisting', req.remoteAddress, 'for exceeding rate limitation.');
			// 1013 is the "Try Again Later" error code. It's the best we can do to let the client
			// know they're sending too many messages.
			ws.close(1013);
			banClient(req.remoteAddress);
			return;
		}
		next();
	};

	// Reset op and signal counts.
	setInterval(function() {
		opsList.clear();
	}, rateLimit.intervalLength);

	// Expire bans. (Map#forEach hands its entries to the callback as (value, key), here
	// (banTimestamp, remoteAddress), and the sweep interval is clamped so a small banDuration
	// doesn't produce a busy loop.)
	setInterval(() => {
		const currentTime = Date.now();
		addressBanList.forEach((banTimestamp, remoteAddress) => {
			if (banTimestamp + rateLimit.banDuration < currentTime) {
				console.log('Removing', remoteAddress, 'from blacklist');
				addressBanList.delete(remoteAddress);
			}
		});
	}, Math.max(1, rateLimit.banDuration / 10));
} else if (rateLimit) {
	console.warn('Invalid rateLimit configuration, rate limiting is disabled:',
		JSON.stringify(rateLimit));
}
