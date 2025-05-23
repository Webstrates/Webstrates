const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    // Start with ESLint's recommended rules.
    // This applies all the rules from 'eslint:recommended'.
    js.configs.recommended,

    // Add custom configurations, which will override or extend
    {
        // languageOptions replaces 'env' and 'parserOptions'
        languageOptions: {
            ecmaVersion: 2017,
            sourceType: "commonjs",

            globals: {
                ...globals.browser,   // Equivalent to env.browser = true
                ...globals.node,      // Equivalent to env.node = true
                ...globals.commonjs,  // Equivalent to env.commonjs = true
		"config": true,
                "serverConfig": true,
                "WORKER_ID": true,
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
        },

        // Note: `ignorePatterns` from .eslintrc maps to `ignores` in flat config.
        ignores: ['static/webstrates.js']
    }
];