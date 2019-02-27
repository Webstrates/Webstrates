'use strict';
const coreEvents = require('./coreEvents');
const coreUtils = require('./coreUtils');
const coreWebsocket = require('./coreWebsocket');
const globalObject = require('./globalObject');

const newWebstratesModule = {};

const webstrateId = coreUtils.getLocationObject().webstrateId;

/**
 * Prompt the user for a ZIP compressed webstrate, like the one retrieved from a `?dl` request.
 * Accepts ZIP files with extensions ZIP and WSA (WebStrate Archieve).
 * @param  {string}   webstrateId (optional) Desired WebstrateId for the new webstrate.
 * @param  {object}   options     Some options, e.g. whether to reload the page or not.
 * @param  {Function} callback    Callback to be called on completion.
 * @return {[type]}               [description]
 */
globalObject.publicObject.newFromPrototypeFile = (desiredWebstrateId, options = {},
	callback = () => {}) => {
	if (typeof desiredWebstrateId === 'function') {
		options = callback;
		callback = desiredWebstrateId;
		desiredWebstrateId = undefined;
	}

	return new Promise((accept, reject) => {
		const input = document.createElement('input');
		input.setAttribute('name', 'file');
		input.setAttribute('type', 'file');
		input.setAttribute('accept', '.zip,.wsa');

		input.addEventListener('change', event => {
			const formData = new FormData();
			formData.append('file', input.files.item(0));
			formData.append('apiCall', true);
			formData.append('id', desiredWebstrateId);

			fetch('/new', {
				method: 'post',
				credentials: 'include',
				body: formData
			})
				.then(res => res.json()
					.then(json => {
						if (res.ok) {
							accept(json);
							callback(null, json);
							// Reload the page if we're updating this webstrate, unless we're specifically
							// told not to.
							if (webstrateId === desiredWebstrateId && !options.noreload)
								document.location.reload();
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

globalObject.publicObject.newFromPrototypeURL = (url, webstrateId) => {

};

module.exports = newWebstratesModule;