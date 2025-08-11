global.APP_PATH = __dirname + '/../';

module.exports = {
	server: require('../helpers/ConfigHelper.js').getConfig(),

	// Auth credentials
	authType: 'test', // One of 'github', 'au', 'test', ...
	server_address: 'http://localhost:7007/',
	username: '',
	password: ''
};