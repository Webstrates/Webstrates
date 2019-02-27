'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

const assetsModule = {};

// Create internal event that other modules may subscribe to
coreEvents.createEvent('asset');

// Create event in userland.
globalObject.createEvent('asset');

let assets;

const websocket = coreWebsocket.copy((event) => event.data.startsWith('{"wa":'));
const webstrateId = coreUtils.getLocationObject().webstrateId;

websocket.onjsonmessage = (message) => {
	if (message.d !== webstrateId) return;
	switch (message.wa) {
		case 'assets':
			assets = message.assets;
			break;
		case 'asset':
			assets.push(message.asset);
			coreEvents.triggerEvent('asset', message.asset);
			globalObject.triggerEvent('asset', message.asset);
			break;
	}
};

// Define webstrate.assets. Returns a frozen copy, so users won't modify it.
Object.defineProperty(globalObject.publicObject, 'assets', {
	get: () => Object.freeze(coreUtils.objectClone(assets))
});

/**
 * Makes it possible to select and upload files.
 * @param  {Function} callback Callback with two arguments, error and response. First argument will
 *                             be null on success.
 * @return {Promise}  Promise that gets resolved with the result.
 * @public
 */
globalObject.publicObject.uploadAsset = (callback = () => {}, options = {}) => {
	return new Promise((accept, reject) => {
		const input = document.createElement('input');
		input.setAttribute('multiple', true);
		input.setAttribute('type', 'file');

		input.addEventListener('change', event => {
			const formData = new FormData();
			Object.entries(options).forEach(([key, value]) => formData.append(key, value));

			for (let i=0; i < input.files.length; i++) {
				formData.append('file[]', input.files.item(i));
			}

			fetch('', {
				method: 'post',
				credentials: 'include',
				body: formData
			})
				.then(res => res.json()
					.then(json => {
						if (res.ok) {
							accept(json);
							callback(null, json);
						} else {
							reject(json.error);
							callback(json.error);
						}
					})
					.catch(err => {
						reject(err);
						callback(err);
					})
				)
				.catch(err => {
					reject(err);
					callback(err);
				});
		});

		input.click();
	});
};

globalObject.publicObject.deleteAsset = (assetName, callback) => {
	websocket.send({ wa: 'deleteAsset', d: webstrateId, assetName },
		(err, result) => callback && callback(err, result));
};

globalObject.publicObject.searchAsset = (assetIdentifier, query = {}, callback) => {
	if (typeof callback !== 'function') throw new Error('Must provide callback function');

	const [assetName, assetVersion] = assetIdentifier.split('/');
	websocket.send({ wa: 'assetSearch', d: webstrateId, assetName, assetVersion: +assetVersion,
		query: query.query, sort: query.sort, limit: query.limit, skip: query.skip },
	(err, result) => callback(err, result.records, result.count));
};

module.exports = assetsModule;