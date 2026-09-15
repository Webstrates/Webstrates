const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    // Standalone `ignores` block — the ONLY way to exclude files from linting
    // entirely. (An `ignores` key inside a config object with other keys only
    // limits that object's application; the files are still linted by other
    // config objects)
    {
        // static/webstrates.js is the generated webpack bundle.
        // wrapper-header/footer.js are IIFE halves injected via BannerPlugin —
        // syntactic fragments, not valid standalone JavaScript.
        ignores: ['static/webstrates.js', 'client/wrapper-header.js', 'client/wrapper-footer.js']
    },

    // Start with ESLint's recommended rules.
    // This applies all the rules from 'eslint:recommended'.
    js.configs.recommended,

    // Add custom configurations, which will override or extend
    {
        // languageOptions replaces 'env' and 'parserOptions'
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",

            globals: {
                ...globals.browser,   // Equivalent to env.browser = true
                ...globals.node,      // Equivalent to env.node = true
                ...globals.commonjs,  // Equivalent to env.commonjs = true
		"config": true,
                "serverConfig": true,
                "APP_PATH": true
            }
        },

        // These rules will override or add to the rules from 'eslint:recommended'.
        rules: {
            'max-len': ['warn', { code: 100, tabWidth: 2 }],

            // Use tabs for indentation, throw errors otherwise.
            indent: ['error', 'tab', {
                SwitchCase: 1,
                CallExpression: { arguments: 1 },
                ArrayExpression: 1,
                ObjectExpression: 1
            }],

            // Always give an error when not using UNIX linebreaks.
            'linebreak-style': ['error', 'unix'],

            // Always give an error when using double quotes instead of single quotes.
            quotes: ['error', 'single'],

            // Always give an error with missing semicolons.
            semi: ['error', 'always'],

            // Only warn when escaping unnecessary characters in a regex (default is error).
            'no-useless-escape': ['warn'],

            'no-irregular-whitespace': ['warn', { "skipRegExps": true }],

            // Only warn when unreachable code exists (default is error).
            'no-unreachable': ['warn'],

            'no-unused-vars': ['warn', {
                args: 'none',
                varsIgnorePattern: '^_'
            }],

            // Do allow the use of console.log().
            'no-console': 'off'
        }
    },
    {
        // .mjs files are ES modules (tests/). With the global sourceType
        // "commonjs" they all died at the first `import` and were never linted.
        files: ['**/*.mjs'],
        languageOptions: {
            sourceType: "module",
            globals: {
                ...globals.browser,   // puppeteer page.evaluate() runs in browser context
                ...globals.node,
                ...globals.mocha      // describe/it/beforeEach/afterEach
            }
        }
    }
];