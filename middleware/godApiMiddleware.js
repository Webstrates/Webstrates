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

	const pubsub = global.config.pubsub && {
		publisher: redis.createClient(global.config.pubsub),
		subscriber: redis.createClient(global.config.pubsub)
	};
	pubsub.subscriber.subscribe('webstratesClients');
	pubsub.subscriber.subscribe('webstratesGodAPI');

	pubsub.subscriber.on('message', (channel, message) => {
		message = JSON.parse(message);
		const userId = message.userId;
		const webstrateId = message.webstrateId;
		subscriptions.forEach(({ subscriptionId, ws, users, webstrates, wildcard }) => {
			if (!wildcard
				&& !(webstrates.has(webstrateId) || webstrates.has('*'))
				&& !users.has(userId)) return;

			// Merge filters, e.g. if we listen for 'dom' on the webstrate the action is happening in, but
			// 'signal' from the user involved, this action is happening with the filter
			// ['dom', 'signal'].
			const filter = new Set([
				...(webstrates.get(webstrateId) || webstrates.get('*') || []),
				...(users.get(userId) || [])
			]);

			switch (message.action) {
				// clientJoin, clientPart and publish are created by Webstrates.
				case 'clientJoin': {
					if (wildcard || filter.has('user')) {
						ws.send(JSON.stringify({
							ga: 'clientJoin', subscriptionId, webstrateId, userId
						}));
					}
					break;
				}
				case 'clientPart': {
					if (wildcard || filter.has('user')) {
						ws.send(JSON.stringify({
							ga: 'clientPart', subscriptionId, webstrateId, userId
						}));
					}
					break;
				}
				case 'publish': {
					if (wildcard || filter.has('signal')) {
						ws.send(JSON.stringify({
							ga: 'signal', subscriptionId, webstrateId, userId,
							nodeId: message.nodeId,
							signal: message.message,
							recipients: message.recipients
						}));
					}
					break;
				}
				// op is created by ourselves below. We do this to ensure every thread gets a chance to
				// react to it, as the list of subscriptions is local to each thread and op only gets
				// triggered in one thread. Thus, is an op happens in any thread but the one with the
				// subscription, it won't get send to the subscriber.
				case 'op': {
					subscriptions.forEach(({ subscriptionId, ws, users, webstrates, wildcard }) => {
						if (!wildcard
							&& !(webstrates.has(webstrateId) || webstrates.has('*'))
							&& !users.has(userId)) return;
						// Merge filters, e.g. if we listen for 'dom' on the webstrate the action is happening
						// in, but 'signal' from the user involved, this action is happening with the filter
						// ['dom', 'signal'].
						const filter = new Set([
							...(webstrates.get(webstrateId) || webstrates.get('*') || []),
							...(users.get(userId) || [])
						]);

						if (wildcard || filter.has('dom')) {
							ws.send(JSON.stringify({
								ga: 'dom', subscriptionId, webstrateId, userId,
								op: message.op
							}));
						}
					});
					break;
				}
				//default:
				//	console.log(message);
			}
		});
	});

	// This will only get triggered in one thread (the receiving thread), so we publish it through
	// Reddis, so all threads get a chance to react.
	shareDbWrapper.use('receive', (req, next) => {
		if (req.data.a !== 'op') return next();
		// req is the sharedb request, req.req is the HTTP request that we've attached ourselves
		// when we did share.listen(stream, req).
		const userId = req.agent.user ? req.agent.user.userId : 'server:';
		const webstrateId = req.data.d;
		const op = req.data.op;
		pubsub.publisher.publish('webstratesGodAPI', JSON.stringify({
			action: 'op', userId, webstrateId, op
		}));
		next();
	});

	exports.onmessage = (ws, req, data, next) => {
		// We use 'noop' to skip the regular ShareDB initialization.
		if (!data.ga && !('noop' in req.query)) return next();

		if (!ws.authorized) {
			if (data.ga === 'key' && data.key === config.godApi.key) {
				ws.authorized = true;
				ws.send(JSON.stringify({ ga: 'authorized' }));
			} else {
				ws.send(JSON.stringify({ ga: 'unauthorized' }));
			}
			return;
		}

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