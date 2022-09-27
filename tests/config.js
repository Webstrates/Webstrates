global.APP_PATH = __dirname + '/../';

module.exports = {
	server_address: 'http://web:strate@localhost:7007/',
	server: require('../helpers/ConfigHelper.js').getConfig(),

	// Github credentials
	username: '',
	password: ''
};