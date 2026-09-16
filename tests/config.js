'use strict';

const fs = require('fs');

global.APP_PATH = __dirname + '/../';

// Under the test runner (tests/lib/run-tests.mjs) the harness state file describes the
// base server it started: use that server's address and configuration. Without it
// (mocha invoked directly) fall back to the repo-root config.json and the default port,
// the old externally-started-server workflow.
let harnessBase = null;
if (process.env.WEBSTRATES_HARNESS_STATE) {
	try {
		harnessBase = JSON.parse(fs.readFileSync(process.env.WEBSTRATES_HARNESS_STATE, 'utf8')).base;
	} catch (err) {
		console.error('Could not read harness state file', process.env.WEBSTRATES_HARNESS_STATE, err.message);
		process.exit(1);
	}
}

module.exports = {
	server: harnessBase ? harnessBase.config : require('../helpers/ConfigHelper.js').getConfig(),

	// Auth credentials
	authType: 'test', // One of 'github', 'au', 'test', ...
	server_address: harnessBase ? harnessBase.address : 'http://localhost:7007/',
	username: '',
	password: ''
};
