/**
 * This script cleans up assets in the file system and database. It deletes any assets only found
 * in the file system, and any assets only found in the database, as these aren't accessible anyway.
 *
 * You'll be prompted before taking any action, so it's safe to run even if you only want to check
 * if you have any dangling records.
 */

global.APP_PATH = __dirname;

const fs = require('fs');
const util = require('util');
const readline = require('readline');
const configHelper = require(APP_PATH + '/helpers/ConfigHelper.js');
const config = global.config = configHelper.getConfig();
const db = require(APP_PATH + '/helpers/database.js');

const UPLOAD_DEST = `${APP_PATH}/uploads/`;

const cleanUp = async () => {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const readdir = util.promisify(fs.readdir);
	const unlink = util.promisify(fs.unlink);

	const assetsFs = await readdir(UPLOAD_DEST);
	const assetDbCursor = await db.assets.find({}, { fileName: 1, _id: 0 });
	const assetsDb = (await assetDbCursor.toArray()).map(o => o.fileName);

	console.log('Found', assetsDb.length, 'assets in database,', assetsFs.length, 'in file system.');
	console.log('Now finding dangling files/entries. This can take a few minutes...');

	const assetsOnlyInDb = assetsDb.filter(asset => !assetsFs.includes(asset));
	const assetsOnlyInFs = assetsFs.filter(asset => !assetsDb.includes(asset));
	console.log('Found', assetsOnlyInDb.length, 'assets that are only in database,',
		assetsOnlyInFs.length, 'that are only in the file system.');
	console.log('(Note that duplicates are automatically removed from the file system, so it is ' +
		'natural that there might be more files in the database than in the file system.)');

	if (assetsOnlyInDb.length === 0 && assetsOnlyInFs.length === 0) {
		console.log('Nothing to clean up!');
		process.exit(0);
		return;
	}

	console.log('\nOnly in database:', assetsOnlyInDb.join(' '));
	console.log('\nOnly in file system:', assetsOnlyInFs.join(' '));

	rl.question('Delete all dangling files/entries [y/N]? ', async (answer) => {
		if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
			console.log('Deleting files from file system.');
			const assetsFsPromises = assetsOnlyInFs.map(async (asset) => unlink(UPLOAD_DEST + asset));
			await Promise.all(assetsFsPromises);

			console.log('Deleting entries from database.');
			await db.assets.deleteMany({ fileName: { $in: assetsOnlyInDb }});

			console.log('Done.');
		} else {
			console.log('Exiting without deleting.');
		}
		process.exit(0);
	});
}

// We wait a little, so we know we're connected to MongoDB.
setTimeout(cleanUp, 2000);