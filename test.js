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
	let debug = {};

	let cursor = await db.ops.find({"v": 0});
	while(await cursor.hasNext()) {
		let op = await cursor.next();

		let count = debug[op.d];
		if(count == null) {
			count = 0;
		}

		debug[op.d] = count + 1;
	}

	Object.keys(debug).forEach((key)=>{
		if(debug[key] > 1) {
			console.log(key, debug[key]);
		}
	})

	process.exit();
}

// We wait a little, so we know we're connected to MongoDB.
setTimeout(cleanUp, 2000);
