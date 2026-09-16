'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// By default the server reads its config from <repo>/config.json. Setting the
// WEBSTRATES_CONFIG environment variable (absolute path, or relative to the repo root)
// overrides this; the test harness uses it to run server instances against generated
// configurations (see tests/lib/server-harness.mjs).
const envConfigPath = process.env.WEBSTRATES_CONFIG;
const configPath = '/config.json';
const sampleConfigPath = '/config-sample.json';

const resolveConfigPath = () => envConfigPath
	? (path.isAbsolute(envConfigPath) ? envConfigPath : path.resolve(APP_PATH, envConfigPath))
	: APP_PATH + configPath;

/** Create config file if it doesn't already exist by copying config-sample. */
const createConfig = () => {
    // The env-provided config is expected to exist (the harness always writes it before
    // starting a server); only the default repo-root config is auto-created from the sample.
    if (envConfigPath) {
        if (!fs.existsSync(resolveConfigPath())) {
            console.error(`Config file "${resolveConfigPath()}" (from WEBSTRATES_CONFIG) not found, terminating`);
            process.exit(1);
        }
        return;
    }
    if (!fs.existsSync(APP_PATH+configPath)) {
        console.warn('No config file present, creating one now');
        if (!fs.existsSync(APP_PATH+sampleConfigPath)) {
            console.error('Sample config not present either, terminating');
            process.exit(1);
        } else {
            try {
                fs.writeFileSync(APP_PATH+configPath, JSON.stringify(getSampleConfig(), null, '\t'));
            } catch (err) {
                console.error('Error creating config file from sample:', err);
                process.exit(1);
            }
        }
    }
};

/** Read config file from disk. */
const getConfig = () => {
	try {
		return JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf8'));
	} catch (e) {
		console.error(envConfigPath
			? `Unable to read config file "${resolveConfigPath()}".`
			: 'Unable to parse config file.');
		process.exit(1);
	}
};

/** Read sample config from disk and add a randomly generated cookie encryption key. */
const getSampleConfig = () => {
	const config = JSON.parse(fs.readFileSync(APP_PATH+sampleConfigPath, 'utf8'));
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