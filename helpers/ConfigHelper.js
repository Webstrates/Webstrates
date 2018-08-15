'use strict';

const fss = require('fs-sync');
const crypto = require('crypto');

/** Create config file if it doesn't already exist by copying config-sample. */
const createConfig = () => {
	if (!fss.exists(APP_PATH + '/config.json')) {
		console.warn('No config file present, creating one now');
		if (!fss.exists(APP_PATH + '/config-sample.json')) {
			console.error('Sample config not present either, terminating');
			process.exit(1);
		} else {
			fss.write(APP_PATH + '/config.json', JSON.stringify(getSampleConfig(), null, '\t'));
		}
	}
};

/** Read config file from disk. */
const getConfig = () => {
	try {
		return fss.readJSON(APP_PATH + '/config.json');
	} catch (e) {
		console.error('Unable to parse config file.');
		process.exit(1);
	}
};

/** Read sample config from disk and add a randomly generated cookie encryption key. */
const getSampleConfig = () => {
	const config = fss.readJSON(APP_PATH + '/config-sample.json');
	const randomSecret = crypto.randomBytes(16).toString('base64');
	config.auth.cookie.secret = randomSecret;
	return config;
};

/**
 * Merge two objects. Use target object with filler as a prototype, e.g. use the property on
 * target if it exists, otherwise copy over the property from filler to the target object.
 * @param  {Object} target Object to base result on.
 * @param  {Object} filler Object to copy missing properties from onto target.
 * @return {Object}        target object with missing properties from filler object.
 */
const mergeJSON = (target, filler) => {
	if (!target) return filler;

	if (typeof filler === 'object') {
		Object.entries(filler).forEach(([key, value]) => {
			target[key] = mergeJSON(target[key], filler[key]);
		});
	}

	return target || filler;
};

/**
 * Get merge configs from disk as object.
 * @return {Object} Config.
 */
exports.getConfig = () => {
	createConfig();
	return mergeJSON(getConfig(), getSampleConfig());
};