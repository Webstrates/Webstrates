const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;
const webpack = require('webpack');
const ESLintPlugin = require('eslint-webpack-plugin'); 
const configHelper = require('./helpers/ConfigHelper.js');
const TerserPlugin = require('terser-webpack-plugin');


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

// Read header and footer content used to wrap the client
const wrapperHeaderContent = fs.readFileSync(path.resolve(__dirname, './client/wrapper-header.js'), 'utf-8');
const wrapperFooterContent = fs.readFileSync(path.resolve(__dirname, './client/wrapper-footer.js'), 'utf-8');


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
        resolve: {
            fallback: { 
		"util": false,
		"setimmediate": require.resolve("setimmediate")
	    } // webpack < 5 used to include polyfills for node.js core modules by default
        },
        plugins: [
                // Our own config and debug module
                new webpack.ProvidePlugin({ config: path.resolve(__dirname, 'client/config') }),
                new webpack.DefinePlugin({ serverConfig: JSON.stringify(cleanServerConfig) }),
                // Header and footer
                new webpack.BannerPlugin({banner: wrapperHeaderContent,raw:true,entryOnly:true}),                
                new webpack.BannerPlugin({banner: wrapperFooterContent,raw:true,entryOnly:true,footer:true}),
                {
                        // Add a hash of webstrates.js to the HTML that's being served to the client in order to
                        // invalidate webstrates.js when it gets updated.
                        apply(compiler) {
                                compiler.hooks.done.tap('AddHashPlugin', (stats) => {        
                                        const htmlInputPath = './client/client.html';
                                        const htmlOutputPath = path.resolve(compiler.options.output.path, 'client.html');
                                        const htmlInput = fs.readFileSync(htmlInputPath, 'utf-8');
                                        const htmlOutput = htmlInput.replace('{{hash}}', stats.hash);
                                        fs.writeFileSync(htmlOutputPath, htmlOutput);
                                });
                        }
                },
                new ESLintPlugin({ extensions: ['js'] })  
        ], performance: {
                // Set a recommended size limit to maky sure we don't grow too much
                maxAssetSize: 1024 * 1024, // 1 MiB
                maxEntrypointSize: 1024 * 1024,
        }
};

// In production
if (process.env.NODE_ENV && process.env.NODE_ENV.trim() === 'production') {
        // Minify the code.
        config.plugins.push(
            new TerserPlugin({
                terserOptions: {
                    compress: {
                        drop_console: true,
                    },
                },
            })
        );

        // And also Babel it (for better browser support).
        config.module.rules.push({
                test: /\.js$/,
                use: 'babel-loader'
        });
}
module.exports = config;
