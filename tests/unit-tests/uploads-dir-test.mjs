// Uploads directory resolution (issue #86): the uploadsDir config.json property and
// the WEBSTRATES_UPLOADS_DIR environment variable decide where uploaded assets are
// stored (see helpers/ConfigHelper.js). These tests exercise the resolution logic in
// isolation; where uploads actually land on a running server is covered by
// tests/functional-tests/4-uploads-dir.mjs.
/* global describe after it */
import { assert } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

global.APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The module captures WEBSTRATES_CONFIG at load time, so it has to be set before the
// require below. The fixture config file it points at keeps the tests off the repo's
// own config.json (which getConfig() would otherwise create from the sample).
const configFixturePath = path.join(os.tmpdir(), `webstrates-uploads-test-${process.pid}.json`);
fs.writeFileSync(configFixturePath, JSON.stringify({ uploadsDir: '/uploads/from/config' }));
process.env.WEBSTRATES_CONFIG = configFixturePath;

const require = createRequire(import.meta.url);
const configHelper = require(path.join(global.APP_PATH, 'helpers/ConfigHelper.js'));

describe('Uploads directory resolution', function () {

	after(() => {
		fs.unlinkSync(configFixturePath);
		delete process.env.WEBSTRATES_CONFIG;
		delete process.env.WEBSTRATES_UPLOADS_DIR;
	});

	it('should default to the uploads directory in the application root', () => {
		assert.equal(configHelper.uploadsPath({}),
			path.join(global.APP_PATH, 'uploads') + path.sep);
	});

	it('should treat an empty uploadsDir as no configuration', () => {
		assert.equal(configHelper.uploadsPath({ uploadsDir: '' }),
			path.join(global.APP_PATH, 'uploads') + path.sep);
	});

	it('should resolve relative directories against the application root', () => {
		assert.equal(configHelper.uploadsPath({ uploadsDir: 'some/relative/dir' }),
			path.join(global.APP_PATH, 'some/relative/dir') + path.sep);
	});

	it('should use absolute directories as they are', () => {
		assert.equal(configHelper.uploadsPath({ uploadsDir: '/var/webstrates/uploads' }),
			path.join('/var/webstrates/uploads') + path.sep);
	});

	it('should always return a path with a trailing separator', () => {
		const noSeparator = configHelper.uploadsPath({ uploadsDir: '/var/webstrates/uploads' });
		const withSeparator = configHelper.uploadsPath({ uploadsDir: '/var/webstrates/uploads/' });
		assert.equal(noSeparator, withSeparator,
			'A directory configured with a trailing separator should resolve to the same path');
		assert.isTrue(noSeparator.endsWith(path.sep),
			'The path should end with a separator (file names are concatenated onto it)');
	});

	it('should read the global config when no config is passed', () => {
		const previousConfig = global.config;
		try {
			global.config = { uploadsDir: '/var/webstrates/global' };
			assert.equal(configHelper.uploadsPath(), path.join('/var/webstrates/global') + path.sep);
		} finally {
			global.config = previousConfig;
		}
	});

	it('should let WEBSTRATES_UPLOADS_DIR override the config.json directory', () => {
		process.env.WEBSTRATES_UPLOADS_DIR = '/uploads/from/environment';
		const config = configHelper.getConfig();
		assert.equal(config.uploadsDir, '/uploads/from/environment');
		assert.equal(configHelper.uploadsPath(config),
			path.join('/uploads/from/environment') + path.sep);
	});

	it('should use the config.json directory without WEBSTRATES_UPLOADS_DIR', () => {
		delete process.env.WEBSTRATES_UPLOADS_DIR;
		const config = configHelper.getConfig();
		// The fixture config's uploadsDir, not the sample's default "uploads".
		assert.equal(config.uploadsDir, '/uploads/from/config');
		assert.equal(configHelper.uploadsPath(config),
			path.join('/uploads/from/config') + path.sep);
	});

	it('should ignore an empty WEBSTRATES_UPLOADS_DIR', () => {
		process.env.WEBSTRATES_UPLOADS_DIR = '';
		try {
			const config = configHelper.getConfig();
			assert.equal(config.uploadsDir, '/uploads/from/config',
				'An empty environment variable should not override the config.json directory');
		} finally {
			delete process.env.WEBSTRATES_UPLOADS_DIR;
		}
	});
});
