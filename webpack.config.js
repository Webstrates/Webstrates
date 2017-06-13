const webpack = require('webpack');
const path = require('path');

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
		new webpack.ProvidePlugin({ debug: path.resolve(__dirname, 'client/debug') }),
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
	// If not in production (i.e. developement), lint the code to make it all pretty.
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