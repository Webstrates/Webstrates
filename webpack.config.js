const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;
const zlib = require('zlib');
const webpack = require('webpack');
const ESLintPlugin = require('eslint-webpack-plugin');
const configHelper = require('./helpers/ConfigHelper.js');
const MinimizerPlugin = require('minimizer-webpack-plugin');


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
        niceWebstrateIds: serverConfig.niceWebstrateIds,
        maxAssetSize: serverConfig.maxAssetSize,
        rateLimit: serverConfig.rateLimit,
        basicAuth: serverConfig.basicAuth,
        providers: serverConfig.providers && Object.keys(serverConfig.providers),
        compressedSnapshots: serverConfig.compressedSnapshots === true,
        gitCommit,
        nodeVersion: process.version
};

// Read header and footer content used to wrap the client
const wrapperHeaderContent = fs.readFileSync(path.resolve(__dirname, './client/wrapper-header.js'), 'utf-8');
const wrapperFooterContent = fs.readFileSync(path.resolve(__dirname, './client/wrapper-footer.js'), 'utf-8');


// Embed the brotli decoder's wasm bytes in the bundle as base64: the client
// snapshot fast path decodes the websocket payload with them, and an
// embedded copy avoids a runtime roundtrip for the .wasm asset
const brotliWasmPath = path.resolve(__dirname,
        'node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm');
fs.writeFileSync(path.resolve(__dirname, 'client/webstrates/brotli-wasm-bytes.b64'),
        fs.readFileSync(brotliWasmPath).toString('base64'));

const config = {
        entry: './client/index.js',
        output: {
                path: path.resolve(__dirname, 'static'),
                filename: 'webstrates.js',
                sourceMapFilename: '[file].map',
                // An explicit publicPath skips webpack's auto-detection
                publicPath: '/'
        },
        devtool: 'eval',
        module: {
                rules: [
                        // Base64-embedded binaries (the brotli decoder's wasm bytes,
                        // generated above into client/webstrates/brotli-wasm-bytes.b64)
                        // are imported as plain strings.
                        {
                                test: /brotli-wasm-bytes\.b64$/,
                                type: 'asset/source'
                        },
                        // The brotli-dec-wasm package's fetch-based default init
                        // references its .wasm via new URL(...). The client never
                        // calls it (it inits with the embedded bytes), but webpack
                        // statically rewrites the reference, so the file must stay
                        // resolvable as an asset. It is emitted but never fetched.
                        {
                                test: /brotli_dec_wasm_bg\.wasm$/,
                                type: 'asset/resource',
                                generator: { filename: 'brotli-dec.wasm' }
                        }
                ]
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
                // Pre-compress the client bundle with brotli
                {
                        apply(compiler) {
                                compiler.hooks.done.tap('EmitPrecompressedBundle', () => {
                                        const bundlePath = path.resolve(__dirname, 'static', 'webstrates.js');
                                        const compressed = zlib.brotliCompressSync(
                                                fs.readFileSync(bundlePath),
                                                { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
                                        const tmp = bundlePath + '.br.tmp';
                                        fs.writeFileSync(tmp, compressed);
                                        fs.renameSync(tmp, bundlePath + '.br');
                                });
                        }
                },
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
		new ESLintPlugin()
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
            new MinimizerPlugin({
                minify: {
                    implementation: MinimizerPlugin.terserMinify,
                    options: {
                        compress: {
                            drop_console: true,
                        },
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
