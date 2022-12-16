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
async function cleanUp() {
	let totalOpsDeleted = 0;
	let webstratesCursor = db.webstrates.find();

	while(await webstratesCursor.hasNext()) {
		let opsToDelete = [];

		let webstrate = await webstratesCursor.next();
		const id = webstrate._id;
		const version = webstrate._v;

		console.log("Checking:", id, version);

		//Find and mark for deletion all extra ops for each version
		//the last op at a version, is the correct one
		for(let v = 0; v<version; v++) {
			let opsForVersion = await db.ops.find({d: id, v: v}).toArray();
			//All but last, should be deleted
			for(let i = 0; i<opsForVersion.length-1; i++) {
				opsToDelete.push(opsForVersion[i]._id);
			}
		}
		
		//Find all ops later than version, as they are also wrong
		let oldOpsCursor = db.ops.find({d: id, v:{$gte: version}});
		while(await oldOpsCursor.hasNext()) {
			opsToDelete.push((await oldOpsCursor.next())._id);
		}
		await oldOpsCursor.close();

		if(opsToDelete.length > 0) {
			console.log("Found ops to delete for ["+id+"]:", opsToDelete.length);
			for(let opId of opsToDelete) {
				let result = await db.ops.deleteOne({"_id": opId});
				totalOpsDeleted++;
			}
		}
	}

	console.log("Total ops deleted:", totalOpsDeleted);

	process.exit();
}

// We wait a little, so we know we're connected to MongoDB.
setTimeout(cleanUp, 2000);
