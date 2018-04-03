const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const WrapperPlugin = require('wrapper-webpack-plugin');
const fileWatcherPlugin = require('filewatcher-webpack-plugin');
const configHelper = require('./helpers/ConfigHelper.js');

global.APP_PATH = __dirname;

// Find last Git commit, so we can expose it to the client.
let gitCommit;
try {
	gitCommit = require('child_process')
		.execSync('git log -1 --oneline')
		.toString().trim()
}
catch (error) {
	console.warn('Couldn\'t get last Git commit', error.toString());
}

const serverConfig = configHelper.getConfig();
const cleanServerConfig = {
	threads: serverConfig.threads,
	niceWebstrateIds: serverConfig.niceWebstrateIds,
	maxAssetSize: serverConfig.maxAssetSize,
	rateLimit: serverConfig.rateLimit,
	basicAuth: serverConfig.basicAuth,
	providers: serverConfig.providers && Object.keys(serverConfig.providers),
	gitCommit
};

const config = {
	entry: './client/index.js',
	output: {
		path: path.resolve(__dirname, 'static'),
		filename: 'webstrates.js',
		sourceMapFilename: '[file].map'
	},
	devtool: 'eval',
	module: {
		rules: []
	},
	plugins: [
		// Our own config and debug module
		new webpack.ProvidePlugin({ config: path.resolve(__dirname, 'client/config') }),
		new webpack.DefinePlugin({serverConfig: JSON.stringify(cleanServerConfig) }),
		new WrapperPlugin({
			header: filename => fs.readFileSync('./client/wrapper-header.js', 'utf-8'),
			footer: filename => fs.readFileSync('./client/wrapper-footer.js', 'utf-8'),
		})
	]
};

// In production
if (process.env.NODE_ENV === 'production') {
	// Uglify/minify the code.
	config.plugins.push(new webpack.optimize.UglifyJsPlugin());

	// And also Babel it (for better browser support).
	config.module.rules.push({
		test: /\.js$/,
		use: 'babel-loader'
	});
} else {
	//config.plugins.push(new fileWatcherPlugin( {watchFileRegex: ['./client/*.js']}));

	// Lint the code to make it all pretty in development environment (or anything not production).
	config.module.rules.push({
		test: /\.js$/,
		enforce: 'pre',
		loader: 'eslint-loader',
		options: {
			fix: true,
			emitWarning: true,
		}
	});
}

module.exports = config;