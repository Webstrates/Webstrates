'use strict';

const csv = require('csvtojson');
const db = require(APP_PATH + '/helpers/database.js');
const assetManager = require(APP_PATH + '/helpers/AssetManager.js');

const csvConfig = {
	workerNum: 1, //, Math.max(1, Math.round(config.threads / 2)),
	checkType: true,
	flatKeys: false
};

/**
 * Read a CSV file and insert all rows into MongoDB as individual documents with an associated
 * assetId.
 * @param  {string} filePath Full path CSV file on disk.
 * @param  {string} assetId) Mongo ObjectID of asset this should be associated with.
 * @return {[type]}          [description]
 */
const batchInsertJsonToMongo = (filePath, assetId) => new Promise((accept, reject) => {
	let batchRows = [];
	let counter = 0;
	csv(csvConfig).fromFile(filePath)
		.on('json', row => {
			row._assetId = assetId;
			batchRows.push(row);
			counter++;
			// Insert 100,000 entries at a time.
			if (counter === 10e4) {
				db.assetsCsv.insertMany(batchRows, { ordered: true });
				batchRows = [];
				counter = 0;
			}
		})
		.on('done', err => {
			// When we've run through all the rows, insert the remainder. This will be less than 100,000.
			db.assetsCsv.insertMany(batchRows, { ordered: true });
			if (err) reject(err);
			else accept();
		});
});

/**
 * Make a CSV asset searchable.
 * @param  {string} assetId  Mongo ObjectID of asset.
 * @param  {string} filePath Full path to asset file.
 * @return {bool}            (async) Whether we suceeded.
 */
module.exports.makeSearchable = async (assetId, filePath) => {
	const startTime = Date.now();
	await batchInsertJsonToMongo(filePath, assetId);
	console.log('Insertion of', assetId, 'took', (Date.now() - startTime) / 1000 + 's');
	return db.assets.update({ _id: assetId }, { $set: { searchable: true }});
};

/**
 * Delete all searchable data associated with an asset.
 * @param  {ObjectId} assetId MongoDB Object ID for asset.
 * @return {Promise}          Promise that resolves with result.
 * @public
 */
module.exports.deleteSearchable = async assetId =>
	db.assetsCsv.deleteMany({ _assetId: assetId });


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

	// If this webstrate is a copy of another webstrate, the CSV assets will be associated with the
	// original webstrate, so we use that ID instead.
	query._assetId = asset._originalId || asset._id;
	const result = db.assetsCsv
		.find(query, { _id: 0, _assetId: 0 })
		.limit(limit)
		.sort(sort)
		.skip(skip);

	// 'count' is the the number of all records matching the query, disregarding the limit we've set.
	return { records: await result.toArray(), count: await result.count() };
};