global.APP_PATH = __dirname + '/../';

module.exports = {
	server: require('../helpers/ConfigHelper.js').getConfig(),

	// Auth credentials
	authType: 'au', // One of 'github', 'au', ...
	server_address: 'http://localhost:7007/',
	username: '',
	password: ''
};