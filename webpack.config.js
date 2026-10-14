const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Version identity of this client build: 16 hex chars of sha256 over every input that
// shapes the bundle — all files under client/ (the generated brotli decoder bytes above
// included), the embedded server config, and the dependency manifest. It changes
// whenever the client build changes (and only then), so the server can tell builds
// apart: it announces the version of the bundle it ships on every websocket connection
// (middleware/versionMiddleware.js), and clients compare it against the copy embedded
// below as serverConfig.clientVersion — a mismatch means the server was upgraded
// underneath the running page, which then reloads. Computed before it is embedded,
// so it never hashes itself.
const clientVersion = (() => {
        const hash = crypto.createHash('sha256');
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
                .filter(entry => entry.name[0] !== '.')
                .sort((a, b) => a.name < b.name ? -1 : 1)
                .flatMap(entry => {
                        const full = path.join(dir, entry.name);
                        return entry.isDirectory() ? walk(full) : [full];
                });
        for (const file of walk(path.resolve(__dirname, 'client'))) {
                hash.update(path.relative(__dirname, file));
                hash.update(fs.readFileSync(file));
        }
        hash.update(JSON.stringify(cleanServerConfig));
        hash.update(JSON.stringify(require('./package.json').dependencies));
        return hash.digest('hex').slice(0, 16);
})();
cleanServerConfig.clientVersion = clientVersion;

const isProduction = process.env.NODE_ENV && process.env.NODE_ENV.trim() === 'production';

const config = {
        entry: './client/index.js',
        output: {
                path: path.resolve(__dirname, 'static'),
                filename: 'webstrates.js',
                sourceMapFilename: '[file].map',
                // An explicit publicPath skips webpack's auto-detection
                publicPath: '/'
        },
        // Allow the minifier to run in production but keep eval-source in dev
        devtool: isProduction ? false : 'eval',
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
	    }, // webpack < 5 used to include polyfills for node.js core modules by default

            // ShareDB's client pulls in its whole real-time presence subsystem
            // (plus the `async` library) from connection.js, but no Webstrates
            // code ever uses it. Alias them to shims
            alias: {
                './presence/presence$': path.resolve(__dirname, 'client/shims/presence.js'),
                './presence/doc-presence$': path.resolve(__dirname, 'client/shims/doc-presence.js'),
                './presence/doc-presence-emitter$':
			path.resolve(__dirname, 'client/shims/doc-presence-emitter.js')
            }
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
                        // Serve the client bundle under a content-hashed filename
                        // (static/webstrates_<hash>.js) and reference that URL from the skeleton
                        apply(compiler) {
                                compiler.hooks.done.tap('AddHashPlugin', () => {
                                        const staticPath = path.resolve(__dirname, 'static');
                                        const bundlePath = path.join(staticPath, 'webstrates.js');
                                        const bundle = fs.readFileSync(bundlePath);
                                        // 16 hex chars of the bundle's sha256: identifies the
                                        // exact build, short enough for readable URLs.
                                        const hash = crypto.createHash('sha256')
                                                .update(bundle).digest('hex').slice(0, 16);

                                        const writeAtomically = (targetPath, content) => {
                                                const tmpPath = path.join(staticPath,
                                                        '.tmp-' + path.basename(targetPath));
                                                fs.writeFileSync(tmpPath, content);
                                                fs.renameSync(tmpPath, targetPath);
                                        };

                                        writeAtomically(path.join(staticPath, `webstrates_${hash}.js`), bundle);
                                        // The pre-compressed bundle (EmitPrecompressedBundle
                                        // above) is written before this plugin in the same pass.
                                        writeAtomically(path.join(staticPath, `webstrates_${hash}.js.br`),
                                                fs.readFileSync(bundlePath + '.br'));

                                        // Point the skeleton at the hashed bundle before
                                        // removing earlier builds' copies: with this order, a
                                        // failure mid-hook leaves the old skeleton paired with
                                        // the old (not yet deleted) bundle, so pages keep
                                        // working; the other order could leave the skeleton
                                        // referencing a deleted bundle.
                                        const htmlInputPath = './client/client.html';
                                        const htmlOutputPath = path.resolve(compiler.options.output.path, 'client.html');
                                        const htmlInput = fs.readFileSync(htmlInputPath, 'utf-8');
                                        writeAtomically(htmlOutputPath, htmlInput.replace('{{hash}}', hash));

                                        // Remove the hashed copies of previous builds (and any
                                        // temp files a failed earlier pass left behind) so they
                                        // don't accumulate across development rebuilds. Stale
                                        // copies would only ever serve outdated clients again;
                                        // pages still running an old build reload and fetch the
                                        // current one.
                                        for (const file of fs.readdirSync(staticPath)) {
                                                if (/^(\.tmp-|webstrates_[0-9a-f]+\.js(\.br)?$)/.test(file)
                                                        && !file.startsWith(`webstrates_${hash}`)) {
                                                        fs.unlinkSync(path.join(staticPath, file));
                                                }
                                        }
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
if (isProduction) {
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
