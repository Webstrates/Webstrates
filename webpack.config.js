const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;
const webpack = require('webpack');
const wrapperPlugin = require('wrapper-webpack-plugin');
const configHelper = require('./helpers/ConfigHelper.js');

global.APP_PATH = __dirname;

// Find last Git commit, so we can expose it to the client.
let gitCommit;
try {
	gitCommit = execSync('git log -1 --oneline 2>/dev/null').toString().trim();
} catch (error) {
	// Couldn't find git commit, continuing without it silently. Printing any error message here would
	// needlessly intimidate newcomers.
}

const serverConfig = configHelper.getConfig();
const cleanServerConfig = {
	threads: serverConfig.threads,
	niceWebstrateIds: serverConfig.niceWebstrateIds,
	maxAssetSize: serverConfig.maxAssetSize,
	rateLimit: serverConfig.rateLimit,
	basicAuth: serverConfig.basicAuth,
	providers: serverConfig.providers && Object.keys(serverConfig.providers),
	gitCommit,
	nodeVersion: process.version
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
		new wrapperPlugin({
			header: filename => fs.readFileSync('./client/wrapper-header.js', 'utf-8'),
			footer: filename => fs.readFileSync('./client/wrapper-footer.js', 'utf-8'),
		}),
		{
			// Add a hash of webstrates.js to the HTML that's being served to the client in order to
			// invalidate webstrates.js when it gets updated.
			apply(compiler) {
				compiler.plugin('done', (stats) => {
					const htmlInputPath = './client/client.html';
					const htmlOutputPath = path.resolve(compiler.options.output.path, 'client.html');
					const htmlInput = fs.readFileSync(htmlInputPath, 'utf-8');
					const htmlOutput = htmlInput.replace('{{hash}}', stats.hash);
					fs.writeFileSync(htmlOutputPath, htmlOutput);
				});
			}
		}
	]
};

// In production
if (process.env.NODE_ENV && process.env.NODE_ENV.trim() === 'production') {
	// Uglify/minify the code.
	config.plugins.push(new webpack.optimize.UglifyJsPlugin());

	// And also Babel it (for better browser support).
	config.module.rules.push({
		test: /\.js$/,
		use: 'babel-loader'
	});
} else {
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