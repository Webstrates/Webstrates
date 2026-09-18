'use strict';

const csv = require('csvtojson');
const db = require(APP_PATH + '/helpers/database.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');

const csvConfig = {
	workerNum: 1,
	checkType: true,
	flatKeys: false
};

// How long a search waits for another process that is already building the search cache of the
// same file before starting its own build. Building is idempotent, so the number isn't critical
// for correctness — the lock only keeps concurrent builds from doing the same work twice.
// (Locks expire on their own after 60 seconds; the TTL index lives in database.js.)
const LOCK_WAIT_MS = 30 * 1000;

const sleep = (ms) => new Promise(accept => setTimeout(accept, ms));

/**
 * Whether the search cache of a file has been built. Tracked in a manifest collection rather
 * than by the presence of rows, so that a build abandoned half-way through by a crash doesn't
 * look like a complete cache (and an empty CSV, which has no rows at all, still does).
 * @param  {string} fileName Name of the file in the file system (the asset's identifier).
 * @return {bool}            (async) Whether the cache exists.
 * @private
 */
const isCached = async (fileName) =>
	await db.assetSearchCache.findOne({ _id: fileName }, { _id: 1 });

/**
 * Insert rows into the search cache. Rows are inserted as upserts with deterministic ids
 * (derived from the file they were parsed from and their row number), so a build overlapping
 * another build of the same file — concurrent processes, a cache cleared under load, the
 * remnants of a crashed build — can only ever produce the exact same rows, never duplicates.
 * @param  {Array} rows Rows to insert.
 * @return {Promise}    Promise that resolves once the rows are inserted.
 * @private
 */
const insertRows = async (rows) => {
	if (rows.length === 0) return;
	await db.assetsCsv.bulkWrite(rows.map(row => ({
		replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true }
	})), { ordered: false });
};

/**
 * Read a CSV file and insert all its rows into MongoDB as individual documents, keyed on the
 * file they were parsed from. The rows of a file are always the same (files never change once
 * uploaded), so the cache of a file can be dropped and rebuilt at any time.
 * @param  {string} filePath Full path to the CSV file on disk.
 * @param  {string} fileName Name of the file in the file system (the asset's identifier).
 * @return {Number}          (async) Number of rows indexed.
 * @private
 */
const batchInsertJsonToMongo = (filePath, fileName) => new Promise((accept, reject) => {
	let batchRows = [];
	let rowNumber = 0;
	// csvtojson doesn't wait for async 'data' handlers, so we queue every batch on a promise
	// chain and only settle once the chain has drained — otherwise 'done' can fire while the
	// last batches are still being inserted.
	let queue = Promise.resolve();
	// Whether the promise has settled. Without this, a late 'done' following an 'error' (or
	// vice versa) could try to settle the promise a second time, and rows emitted after a
	// mid-stream failure would keep being processed.
	let settled = false;
	const settle = (err, rows) => {
		if (settled) return;
		settled = true;
		err ? reject(err) : accept(rows);
	};

	csv(csvConfig).fromFile(filePath)
		.on('data', data => {
			if (settled) return;
			const row = JSON.parse(data.toString('utf8'));
			row._id = `${fileName}:${rowNumber++}`;
			row._fileName = fileName;
			batchRows.push(row);
			// Insert 100,000 entries at a time.
			if (batchRows.length === 10e4) {
				const rows = batchRows;
				batchRows = [];
				queue = queue.then(() => insertRows(rows));
			}
		})
		.on('done', err => {
			// When we've run through all the rows, insert the remainder. This will be less
			// than 100,000 — and possibly nothing at all, as empty CSV files emit no 'data'
			// events, and insertMany would reject an empty batch.
			queue
				.then(() => insertRows(batchRows))
				.then(() => { if (err) throw err; })
				.then(() => settle(null, rowNumber), (err) => settle(err));
		})
		// Errors can arrive without a 'done' event at all (e.g. the file is gone), so settle
		// from the queue itself: either the inserts finish and the error stands, or they
		// already failed and it stands in for theirs.
		.on('error', (err) => {
			queue.then(() => settle(err), () => settle(err));
		});
});

/**
 * Wait for another process to finish building the search cache of a file.
 * @param  {string} fileName Name of the file in the file system (the asset's identifier).
 * @return {bool}            (async) Whether the cache exists by now.
 * @private
 */
const waitForCache = async (fileName) => {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (!await isCached(fileName) && Date.now() < deadline) {
		await sleep(100);
	}
	return await isCached(fileName);
};

// Whether an error is a duplicate key error, i.e. the lock we tried to claim is already held.
const isDuplicateKeyError = (err) =>
	err.code === 11000 || err?.writeErrors?.some(e => e.code === 11000);

/**
 * Make sure the search cache of a file exists, building it from the file on disk if it doesn't.
 * The cache is built lazily, on the first search against a searchable asset (uploads index
 * nothing), and builds are serialized with a lock so concurrent processes don't build the same
 * cache twice. Everything about a build is re-runnable: a lock abandoned by a crashed process
 * expires on its own, a build abandoned half-way through leaves rows but no manifest (so the
 * next search rebuilds, skipping the rows that are already there), and clearing the cache to
 * reclaim space just makes the next search rebuild it from the file.
 * @param  {string} fileName Name of the file in the file system (the asset's identifier).
 * @return {Promise}         Promise that resolves once the cache exists.
 * @private
 */
const ensureCached = async (fileName) => {
	if (await isCached(fileName)) return;

	// Claim the build, so that other processes searching the same file for the first time wait
	// instead of parsing it in parallel.
	let locked = false;
	try {
		await db.assetSearchCacheLocks.insertOne({ _id: fileName, createdAt: new Date() });
		locked = true;
	} catch (err) {
		if (!isDuplicateKeyError(err)) throw err;
	}

	// Somebody else claimed the build, so wait for it to finish. If it never does (the process
	// crashed), we build ourselves once our patience runs out — overlapping builds are safe,
	// they can only produce identical rows.
	if (!locked && !await waitForCache(fileName)) {
		try {
			await db.assetSearchCacheLocks.insertOne({ _id: fileName, createdAt: new Date() });
			locked = true;
		} catch (err) {
			if (!isDuplicateKeyError(err)) throw err;
		}
	}

	try {
		// The cache may have been built while we waited for the lock.
		if (!await isCached(fileName)) {
			const rows = await batchInsertJsonToMongo(`${assetManager.UPLOAD_DEST}${fileName}`,
				fileName);
			// Only once every row is in do we mark the cache as existing — a manifest without
			// rows is impossible, rows without a manifest are just a half-built cache.
			await db.assetSearchCache.replaceOne({ _id: fileName },
				{ createdAt: new Date(), rows }, { upsert: true });
		}
	} finally {
		// Release the lock, so the next search doesn't have to wait for the TTL to expire.
		if (locked) await db.assetSearchCacheLocks.deleteOne({ _id: fileName });
	}
};

/**
 * Delete the search cache associated with a file: its rows, its manifest and its lock. (A build
 * that was in flight while the file was deleted may re-create some rows, but with neither the
 * file nor any asset record left, they can never be read — they get reclaimed the next time
 * the cache is cleared.)
 * @param  {string} fileName Name of the file in the file system (the asset's identifier).
 * @return {Promise}         Promise that resolves with result.
 * @public
 */
module.exports.deleteSearchable = async fileName => {
	await db.assetsCsv.deleteMany({ _fileName: fileName });
	await db.assetSearchCache.deleteOne({ _id: fileName });
	await db.assetSearchCacheLocks.deleteOne({ _id: fileName });
};

// Allowed MongoDB operators used in search query.
const VALID_MONGO_OPERATORS = ['$eq', '$ne', '$lt', '$lte', '$gt', '$gte', '$in', '$nin',
	'$and', '$or'];

/**
 * Verify that a search key is valid.
 * @param  {mixed} key Object to verify.
 * @return {bool}      Validity.
 * @private
 */
const isValidKey = key => VALID_MONGO_OPERATORS.includes(key)
	|| (!key.startsWith('$') && !key.startsWith('_') && !key.includes('.'));

/**
 * Verify that a search value is valid.
 * @param  {mixed} value Object to verify.
 * @return {bool}        Validity.
 * @private
 */
const isValidValue = value => ['string', 'number'].includes(typeof value)
	|| (Array.isArray(value) && value.every(isValidValue))
	|| (typeof value === 'object' && Object.entries(value).every(([k, v]) =>
		isValidKey(k) && isValidValue(v)));

/**
 *  * Search in a searchable asset.
 * @param  {string} webstrateId  WebstrateId.
 * @param  {string} assetName    Asset file name.
 * @param  {Number} assetVersion Version of asset to query. Can be any version the asset is active
 *                               for, e.g. if the asset is uploaded at version 5, it'll also be
 *                               active for version 6, unless it was "overwritten".
 * @param  {Object} query        MongoDB search query object.
 * @param  {Object} sort         Mongodb sort object.
 * @param  {Number} limit        Max number of records.
 * @param  {Number} skip         Number of records to skip over (useful for pagination).
 * @return {Array}               (async) Search result.
 * @public
 */
module.exports.search = async (webstrateId, assetName, assetVersion,
	query = {}, sort = {}, limit = 10, skip = 0) => {
	const asset = await assetManager.getAsset({ webstrateId, assetName, version: assetVersion });

	if (!asset)
		throw new Error('Asset not found');

	if (!asset.searchable)
		throw new Error('Asset not searchable');

	if (!isValidValue(query))
		throw new Error('Invalid query');

	if (!isValidValue(sort))
		throw new Error('Invalid sort');

	if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
		throw new Error('Invalid limit');

	if (!Number.isInteger(skip) || skip < 0)
		throw new Error('Invalid skip');

	// The search cache is keyed on the file the rows were parsed from rather than on the asset
	// record: files are deduplicated across webstrates and survive copies and restores, so
	// every webstrate referencing the same content shares the same rows — and restoring or
	// re-uploading an asset doesn't leave its rows stranded behind a new asset record id.
	await ensureCached(asset.fileName);

	query._fileName = asset.fileName;
	const result = await db.assetsCsv
		.find(query, { _id: 0, _fileName: 0 })
		.limit(limit)
		.sort(sort)
		.skip(skip)
		.toArray();

	result.forEach((row) => {
		delete row._id;
		delete row._fileName;
	});

	// 'count' is the the number of all records matching the query, disregarding the limit we've set.
	return { records: result, count: result.length };
};
