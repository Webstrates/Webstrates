const redis = require('redis');

const shareDbWrapper = require(APP_PATH + '/helpers/ShareDBWrapper.js');

if (!global.config.pubsub) {
	console.warn('God API requires Redis pub/sub');
} else {
	const subscriptions = new Map();

	/**
	 * Converts a Map to a primitive object. Yes, you'd think JavaScript's JSON.stringify() would be
	 * able to figure this out itself, but no. Stringifying a Map gives you an empty object.
	 * @param  {Map} map Map Map to convert.
	 * @return {Object}      Map as Object.
	 * @private
	 */
	const mapToObject = map => Array.from(map).reduce((o, [k, v]) => (o[k] = v, o), {});

	const pubsub = redis.createClient(global.config.pubsub);
	pubsub.subscribe('webstratesClients');

	pubsub.on('message', (channel, message) => {
		message = JSON.parse(message);
		const userId = message.userId;
		const webstrateId = message.webstrateId;
		subscriptions.forEach(({ subscriptionId, ws, users, webstrates, wildcard }) => {
			if (!wildcard && !webstrates.has(webstrateId) && !users.has(userId)) return;

			// Merge filters, e.g. if we listen for 'dom' on the webstrate the action is happening in, but
			// 'signal' from the user involved, this action is happening with the filter
			// ['dom', 'signal'].
			const filter = new Set([
				...(webstrates.get(webstrateId) || []),
				...(users.get(userId) || [])
			]);

			switch (message.action) {
				case 'clientJoin':
					if (wildcard || filter.has('user')) {
						ws.send(JSON.stringify({
							ga: 'clientJoin', subscriptionId, webstrateId, userId
						}));
					}
					break;
				case 'clientPart':
					if (wildcard || filter.has('user')) {
						ws.send(JSON.stringify({
							ga: 'clientPart', subscriptionId, webstrateId, userId
						}));
					}
					break;
				case 'publish':
					if (wildcard || filter.has('signal')) {
						ws.send(JSON.stringify({
							ga: 'signal', subscriptionId, webstrateId, userId,
							nodeId: message.nodeId,
							signal: message.message,
							recipients: message.recipients
						}));
					}
					break;
				default:
					console.log(message);
			}
		});
	});

	shareDbWrapper.use('op', (req, next) => {
		// req is the sharedb request, req.req is the HTTP request that we've attached ourselves
		// when we did share.listen(stream, req).

		const userId = req.agent.user ? req.agent.user.userId : 'server:';
		const webstrateId = req.id;
		subscriptions.forEach(({ subscriptionId, ws, users, webstrates, wildcard }) => {
			if (!wildcard && !webstrates.has(webstrateId) && !users.has(userId)) return;

			// Merge filters, e.g. if we listen for 'dom' on the webstrate the action is happening in, but
			// 'signal' from the user involved, this action is happening with the filter
			// ['dom', 'signal'].
			const filter = new Set([
				...(webstrates.get(webstrateId) || []),
				...(users.get(userId) || [])
			]);

			if (wildcard || filter.has('dom')) {
				ws.send(JSON.stringify({
					ga: 'dom', subscriptionId, webstrateId, userId,
					op: req.op.op
				}));
			}
		});

		next();
	});

	exports.onmessage = (ws, req, data, next) => {
		if (!data.ga && !('noop' in req.query)) return next();

		//const users = Array.isArray(data.users) ? data.users : [ data.users ];
		const filter = (data.filter && (Array.isArray(data.filter) ? data.filter : [ data.filter ]))
			|| ['dom', 'signal', 'user'];
		const subscriptionId = data.subscriptionId;

		if (!subscriptionId) return ws.send(JSON.stringify({ error: 'No subscriptionId specified.'}));
		let subscription = subscriptions.get(subscriptionId);
		if (!subscription) {
			subscription = { ws: ws, users: new Map(), webstrates: new Map(), wildcard: false };
			subscriptions.set(subscriptionId, subscription);
		}

		switch (data.ga) { // 'ga' for 'god action'.
			case 'subscribeWebstrate': {
				if (!data.webstrates) return ws.send(JSON.stringify({ error: 'No webstrateIds given.'}));
				const webstrates = Array.isArray(data.webstrates) ? data.webstrates : [ data.webstrates ];
				webstrates.forEach(webstrateId => subscription.webstrates.set(webstrateId, filter));
				break;
			}
			case 'subscribeUser': {
				if (!data.users) return ws.send(JSON.stringify({ error: 'No userIds given.'}));
				const users = Array.isArray(data.users) ? data.users : [ data.users ];
				users.forEach(user => subscription.users.set(user, filter));
				break;
			}
			case 'subscribeAll': {

				break;
			}
			default: {
				return ws.send(JSON.stringify({ error: 'Unknown action.'}));
			}
		}

		ws.send(JSON.stringify({
			ga: 'subscriptionCreated', subscriptionId,
			webstrates: mapToObject(subscription.webstrates),
			users: mapToObject(subscription.users)
		}));

	};

	exports.onclose = (ws, req, reason, next) => {
		subscriptions.forEach((subscription, subscriptionId) => {
			if (subscription.ws === ws) {
				subscriptions.delete(subscriptionId);
			}
		});
		next();
	};

}