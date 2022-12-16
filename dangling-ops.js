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

	let webstratesWithOpsThatDoNotExist = [];

	let webstratesWithOps = await db.ops.distinct("d");

	for(let webstrateId of webstratesWithOps) {
		//Check if webstrate exists
		let found = await db.webstrates.find({"_id": webstrateId}).count();

		if(found === 0) {
			webstratesWithOpsThatDoNotExist.push(webstrateId);
		}
	}

	console.log("Number of webstrates referenced from ops, but that does not exist:", webstratesWithOpsThatDoNotExist.length);

	if(webstratesWithOpsThatDoNotExist.length > 0) {
		console.log(webstratesWithOpsThatDoNotExist);

		rl.question('Delete all dangling ops [y/N]? ', async (answer) => {
			if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
				for(let webstrateId of webstratesWithOpsThatDoNotExist) {
					await db.ops.deleteMany({"d": webstrateId});
				}

				console.log("Dangling ops delted!");
			}
		});
	}

	process.exit();
}

// We wait a little, so we know we're connected to MongoDB.
setTimeout(cleanUp, 2000);
