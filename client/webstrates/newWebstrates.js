'use strict';
const coreUtils = require('./coreUtils');
const globalObject = require('./globalObject');

const webstrateId = coreUtils.getLocationObject().webstrateId;

/**
 * Prompt the user for a ZIP compressed webstrate, like the one retrieved from a `?dl` request.
 * Accepts ZIP files with extensions ZIP and WSA (WebStrate Archieve).
 * @param  {string}   webstrateId (optional) Desired WebstrateId for the new webstrate.
 * @param  {object}   options     Some options, e.g. whether to reload the page or not.
 * @return {Promise}              Will accept on success or reject on failure.
 * @public
 */
globalObject.publicObject.newFromPrototypeFile = (desiredWebstrateId, options = {}) => {
	desiredWebstrateId = desiredWebstrateId || webstrateId;

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
			}).then(res => res.json()
				.then(json => {
					if (res.ok) {
						accept(json);
						// Reload the page if we're updating this webstrate, unless we're specifically
						// told not to.
						if (webstrateId === desiredWebstrateId && !options.noreload) {
							document.location.reload();
						}
					} else {
						reject(json.error);
					}
				})
				.catch(err => {
					reject(err);
				})
			).catch(err => {
				reject(err);
			});
		});

		input.click();
	});
};

/**
 * Prototype a webstrate to a target webstrate, potentially this webstrate.
 * @param  {string}   webstrateId (optional) Desired WebstrateId for the new webstrate.
 * @param  {object}   options     Some options, e.g. whether to reload the page or not.
 * @return {Promise}              Will accept on success or reject on failure.
 * @public
 */
globalObject.publicObject.newFromPrototypeURL = (url, desiredWebstrateId, options = {}) => {
	desiredWebstrateId = desiredWebstrateId || webstrateId;
	url = new URL(url, location.href);

	return new Promise((accept, reject) => {
		fetch(`/new?prototypeUrl=${url}&id=${desiredWebstrateId}`, {
			method: 'get',
			credentials: 'include'
		}).then(res => res.text()
			.then(text => {
				if (res.ok) {
					accept(text);
					// Reload the page if we're updating this webstrate, unless we're specifically
					// told not to.
					if (webstrateId === desiredWebstrateId && !options.noreload) {
						document.location.reload();
					}
				} else {
					reject(text.error);
				}
			})
			.catch(err => {
				reject(err);
			})
		).catch(err => {
			reject(err);
		});
	});
};