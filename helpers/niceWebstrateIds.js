'use strict';

const util = require('util');
const documentManager = require(APP_PATH + '/helpers/DocumentManager.js');

const animals = require('human-readable-ids/assets/animals').humanReadableIds.animals;
const adjectives = require('human-readable-ids/assets/adjectives').humanReadableIds.adjectives;

/**
 * Shuffle an array.
 * @param  {Array} list Array.
 * @return {Array}      Shuffled array.
 * @private
 */
function shuffle(list) {
	let currentIndex = list.length, temporaryValue, randomIndex;
	while (0 !== currentIndex) {
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;
		temporaryValue = list[currentIndex];
		list[currentIndex] = list[randomIndex];
		list[randomIndex] = temporaryValue;
	}
	return list;
}

/**
 * Get a random element from a list.
 * @param  {Array} list Array.
 * @return {element}   Random element from list.
 * @private
 */
function getRandomElement(list) {
	return list[Math.floor(Math.random() * list.length)];
}

// Keep track of the last recent 8 letters generated animals from and try to avoid reusing those.
// We fill the list to begin with, so we don't have to keep track of length. Instead, we can always
// just shift and push (remove and add).
let recentlyUsedLetters = new Array(8);

/**
 * Get random element starting with letter if specified.
 * @param  {char} letter Letter the animal should start with.
 * @return {string}      Animal name.
 * @private
 */
function getRandomAnimal(letter) {
	if (letter) {
		// Update list of recently used animals.
		if (!recentlyUsedLetters.includes(letter)) {
			recentlyUsedLetters.shift();
			recentlyUsedLetters.push(letter);
		}
		const filteredAnimals = animals.filter(animal => animal.startsWith(letter));
		// Try to get an animal starting with the letter. If we can't, just return any animal.
		return getRandomElement(filteredAnimals) || getRandomElement(animals);
	} else {
		// Try to find an animal whose first letter hasn't been used recently by choice, i.e. if we
		// previously requested an animal starting with 'k', we try to avoid giving out random animals
		// starting with 'k', too.
		let animal, triesLeft = 3;
		do {
			animal = getRandomElement(animals);
		} while (recentlyUsedLetters.includes(animal.charAt(0)) && --triesLeft > 0);
		return animal;
	}
}

let unusedAdjectives = [];
/**
 * Get random adjective. Picks randomly from a list, then reinitiates the list once it's empty
 * to ensure proper distribution of elements.
 * @return {string} Random adjective.
 * @private
 */
function getRandomAdjective() {
	if (unusedAdjectives.length === 0) {
		unusedAdjectives = adjectives.slice();
		shuffle(unusedAdjectives);
	}
	return unusedAdjectives.pop();
}

/**
 * Get an array from [start, end), e.g. getRange(3, 7) = [3, 4, 5, 6].
 * @param  {Number} start Number to start list from (inclusive).
 * @param  {Number} end   Number to end list with (exclusive).
 * @return {Array}        Numbers.
 * @private
 */
function getRange(start, end) {
	return Array.from(new Array(end - start), (e, i) => start + i);
}

let unusedNumbers = [];
/**
 * Get random number.
 * @return {Number}           Number.
 * @private
 */
function getRandomNumberFromList() {
	if (unusedNumbers.length === 0) {
		// We don't want webstrateIds ending with "-0" or "-1", just because.
		unusedNumbers = getRange(2, 100);
		shuffle(unusedNumbers);
	}
	return unusedNumbers.pop();
}

const generateRandomNumber = (min, max) => Math.round(min + (max - min) * Math.random());

const documentExists = util.promisify(documentManager.documentExists);
/**
 * Generate a random webstrateId of the form <adjective>-<animal>-<number>. If letter is defined,
 * we'll attempt to find an animal beginning with that letter.
 * @param  {char} letter Letter the animal should start with.
 * @return {string}      String on the form <adjective>-<animal>-<number>.
 * @public
 */
module.exports.generate = async letter => {
	let webstrateId, iterations = 0;
	do {
		// If we keep making collisions when trying to generate a new webstrateId, we slowly increase
		// the max number used, so we never run out of webstrateIds.
		const number = ++iterations < 5
			? getRandomNumberFromList()
			: generateRandomNumber(100, 100 + 20 * iterations);

		const adjective = getRandomAdjective();
		const animal = getRandomAnimal(letter);
		webstrateId = `${adjective}-${animal}-${number}`;
	} while (await documentExists(webstrateId));
	return webstrateId;
};