'use strict';

module.exports = {
	env: {
		browser: true,
		commonjs: true,
		es6: true,
		node: true
	},
	extends: 'eslint:recommended',
	parserOptions: {
		ecmaVersion: 2017
	},
	globals: {
		"config": true,
		"serverConfig": true,
		"WORKER_ID": true,
		"APP_PATH": true
	},
	rules: {
		'max-len': ['warn', { code: 100, tabWidth: 2 }],
		// Use tabs for indentation, throw errors otherwise.
		indent: ['error', 'tab', {
			// Switch cases should be indented 1 tab. The "standard" is to have the 'case' line up with
			// the 'switch'.
			SwitchCase: 1,
			// When a line is too long for the function definition to be on one line, the arguments on the
			// following line should be indented 1 tab.
			CallExpression: { arguments: 1 },
			// Same goes for arrays.
			ArrayExpression: 1,
			// And objects.
			ObjectExpression: 1
		}],
		// Always give an error when not using UNIX libebreaks.
		'linebreak-style': ['error', 'unix'],
		// Always give an error when using double quotes instead of single quotes.
		quotes: ['error', 'single'],
		// Always give an error with missing semicolons.
		semi: ['error', 'always'],
		// Only warn when escaping unnecessary characters in a regex (default is error).
		'no-useless-escape': ['warn'],
		'no-irregular-whitespace': ['warn', { "skipRegExps": true }],
		// Only warn hen unreachable code exists (default is error).
		'no-unreachable': ['warn'],
		'no-unused-vars': ['warn', {
			// Do not check arguments at all, e.g. so function(accept, reject) { ... } is okay even if
			// neither of the arguments are used.
			args: 'none',
			// Doing [x, y] = f() if we only need y. will give a warning, because x is never used. We now
			// allow variables that are prefixed with _ to be ignored (i.e. not throw warnings). A better
			// solution would be to just allow all unused variables in destructuring assignments, but
			// eslint doesn't seem to support that.
			varsIgnorePattern: '^_'
		}],
		// Do allow the use of console.log().
		'no-console': 'off'
	},
};
