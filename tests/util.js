const config = require('./config.js');

const util = {};

config.username = config.username || process.env.WEBSTRATES_TEST_USERNAME;
config.password = config.password || process.env.WEBSTRATES_TEST_PASSWORD;

util.randomString = function (size = 8,
	alphabet = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ') {
	let len = alphabet.length, str = '';
	while (size--) {
		str += alphabet[Math.floor(Math.random() * len)];
	}
	return str;
};

util.allEquals = function (x, y, ...rest) {
	if (y === undefined) return true;
	if (x !== y) return false;
	return util.allEquals(y, ...rest);
};

util.escapeRegExp = function (s) {
	return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
};

// Shortid webstrate ids are 9 characters (version, worker and timestamp parts)
// and grow by one character each time the server's per-second generation
// counter crosses a power of 16 — the first id of a second is 9 chars, ids 2-15
// are 10, and parallel suites bursting /new requests can push it further.
// Accept the generator's full realistic range.
util.webstrateIdRegex = (config.server && config.server.niceWebstrateIds)
	? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,3})'
	: '([A-z0-9-]{9,14})';

// Remove HTTP basic auth credentials from the server address, e.g. http://web:strate@domain.tld/
// becomes http://domain.tld/. Useful for comparing page URL with server address and for iframes,
// as having credentials in iframe src attributes is prohibited.
util.cleanServerAddress = config.server_address.replace(/^(https?:\/\/)([^@]+@)/, '$1');

// Whether we're testing on localhost. Some tests that depend on latency might not work properly
// this way.
util.isLocalhost = util.cleanServerAddress.match('https?://localhost') !== null;

util.credentialsProvided = config.authType === 'test' || (config.username && config.password);
/**
 * Wait for predicate to become truthy or timeout.
 * @param  {Page} page         Puppeteer page.
 * @param  {Function} fn       Predicate function.
 * @param  {Number} timeout    Timeout in seconds.
 * @param  {mixed} args        Arguments to pass to function.
 * @return {bool}              True if predicate became truthy false otherwise.
 * @public
 */
util.waitForFunction = async function (page, fn, timeout = 10, ...args) {
	if (typeof timeout !== 'number') {
		throw new Error(`Invalid timeout: ${timeout}, expected number.`);
	}
	try {
		await page.waitForFunction(fn, { timeout: timeout * 1000, polling: 100 }, ...args);
	} catch (e) {
		// Using (.*) wildcard to be compatible with error messages from older versions of Puppeteer.
		if (e.message.match(/^(w|W)aiting (.*)failed: (timeout )?\d+ms exceeded$/)) {
			return false;
		}
		throw e;
	}
	return true;
};

/**
 * Wait for an async predicate to become truthy, polling it at an interval until a
 * timeout. Like waitForFunction, but for predicates evaluated here rather than in a
 * browser page (server replies, database reads, and the like).
 * @param  {Function} predicate Function returning a value (may return a Promise).
 * @param  {Number}   timeout   Timeout in seconds.
 * @param  {Number}   pollMs    Polling interval in milliseconds.
 * @return {bool}               True if the predicate became truthy, false on timeout.
 * @public
 */
util.waitFor = async function (predicate, timeout = 5, pollMs = 100) {
	const deadline = Date.now() + timeout * 1000;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await util.sleep(pollMs / 1000);
	}
	return await predicate();
};

util.showLogs = (page, ...pages) => {
	page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));
	if (pages.length > 0) {
		util.showLogs(...pages);
	}
};

util.warn = (...args) => console.log('\u001b[33m    ! ' + args + '\u001b[0m');

util.logInToGithub = async function (page) {
	if (!util.credentialsProvided) {
		throw new Error('No GitHub login credentials provided. Update `config.js` to run GitHub ' +
			'tests.');
	}

	let url = await page.url();
	if (!url.match(/^https:\/\/github.com\/login?/)) {
		await page.goto(config.server_address + 'auth/github', { waitUntil: 'networkidle2' });
	}

	let title = await page.title();
	if (title !== 'Sign in to GitHub · GitHub') {
		throw new Error(`Incorrect login page title: "${title}"`);
	}

	let navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2' });

	await page.type('input#login_field', config.username);
	await page.type('input#password', config.password);
	await page.click('input[type=submit]');

	// Wait for redirect to authorize URL.
	await navigationPromise;

	// Sleeping to circumvent bug: https://github.com/GoogleChrome/puppeteer/issues/1325
	await util.sleep(1);

	// Sometimes, we might need to reauthorize.
	title = await page.title();
	if (title === 'Authorize application') {
		// It seems the login button isn't immediately available after page load (probably to prevent
		// automation, woups...), so we wait for it to become clickable.
		await util.sleep(3);
		let navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2' });
		await page.click('button[name=authorize]');
		await navigationPromise;
	}

	url = await page.url();
	// If we get sent back to the GitHub login page, throw whatever error GitHub produced.
	if (url === 'https://github.com/session') {
		const flashMsg = await page.evaluate(() =>
			document.querySelector('div#js-flash-container').innerText);
		throw new Error(flashMsg);
	}

	return true;
};

util.logInToAU = async function (page) {
	console.log('Using AU auth...');
	if (!util.credentialsProvided) {
		throw new Error('No au login credentials provided. Update `config.js` to run GitHub ' +
			'tests.');
	}

	await page.goto(config.server_address + 'auth/' + config.authType, { waitUntil: 'networkidle0' });
	let title = await page.title();
	if (title !== 'Select an authentication source') {
		throw new Error(`Incorrect login page title: "${title}"`);
	}

	// Click on auth type and wait for load
	await page.waitForSelector('.ldap-au input', { visible: true, timeout: 1000 });
	console.log('Selecting AU auth type...');
	await page.click('.ldap-au input');

	// Fill in data 
	await page.waitForSelector('input#username', { visible: true, timeout: 3000 });
	title = await page.title();
	if (title !== 'Enter your username and password') {
		throw new Error(`Incorrect login page title: "${title}"`);
	}
	console.log('Typing in user details...');
	await page.type('input#username', config.username);
	await page.type('input#password', config.password);
	navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2' });
	await page.click('button#submit_button');
	await navigationPromise;

	url = await page.url();
	console.log('Redirecting to...' + url);
	// If we get sent back to the GitHub login page, throw whatever error GitHub produced.
	if (!url.startsWith(config.server_address)) {
		const flashMsg = await page.evaluate(() =>
			document.body.innerText);
		throw new Error(flashMsg);
	}

	return true;
};

util.logInToTest = async function (page, username = 'testuser') {
	console.log('Using test auth...');

	// Navigate to the test auth form page
	await page.goto(config.server_address + 'auth/test', { waitUntil: 'networkidle2' });

	// Wait for the form to be available
	await page.waitForSelector('form[action="/auth/test"]', { visible: true, timeout: 3000 });

	// Fill in the username field
	await page.waitForSelector('input[name="username"]', { visible: true, timeout: 1000 });
	await page.type('input[name="username"]', username);

	// Submit the form and wait for navigation
	const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2' });
	await page.click('button[type="submit"]');
	await navigationPromise;

	const url = await page.url();
	console.log('Redirected to: ' + url);

	// Check if we successfully redirected back to the server
	if (!url.startsWith(config.server_address)) {
		throw new Error(`Test authentication failed. Expected redirect to ${config.server_address}, got ${url}`);
	}

	return true;
};

util.logInToAuth = async function (page) {
	switch (config.authType) {
		case 'github':
			return await util.logInToGithub(page);
		case 'au':
			return await util.logInToAU(page);
		case 'test':
			return await util.logInToTest(page);
		default:
			throw new Error('Unsupported auth type');
	}
}

util.sleep = async function (seconds) {
	return new Promise(resolve => setTimeout(resolve, seconds * 1000));
};

// The client version the server is currently shipping: the one embedded in the client
// bundle it serves (serverConfig.clientVersion), which the server also announces on
// every websocket connection (middleware/versionMiddleware.js).
let cachedClientVersion;
util.clientVersion = async function () {
	if (cachedClientVersion) return cachedClientVersion;
	const response = await fetch(config.server_address + 'webstrates.js');
	const bundle = await response.text();
	const match = /"?clientVersion"?\s*:\s*"([0-9a-f]{16})"/.exec(bundle);
	if (!match) throw new Error('Could not determine client version from the served bundle ' +
		`(status ${response.status}, url ${response.url}).`);
	cachedClientVersion = match[1];
	return cachedClientVersion;
};

util.waitForWebstrateLoaded = async (page) => {
	await util.waitForFunction(page, async () => {
		await new Promise((resolve, reject) => {
			window.webstrate.on('loaded', () => {
				resolve();
			});
		});
	}, 2);
};

/**
 * Delete the webstrate a page is on by navigating to its ?delete URL, tolerant
 * of the delete-redirect race: the server broadcasts the deletion to the page's
 * own webstrates client before responding with a redirect to the front page.
 * The helpe waits for whichever navigation wins and throws if the page
 * never leaves, so a genuinely failed delete still surfaces.
 * @param  {Page}   page Puppeteer page currently on the webstrate.
 * @param  {String} url  The webstrate's URL; the ?delete query is appended here.
 *                      Any query string or fragment the URL carries is dropped
 *                      first — e.g. the /new redirect target keeps its
 *                      ?prototypeUrl query, and appending ?delete to that URL
 *                      would glue it onto the existing query parameter instead
 *                      of ever reaching the server as a delete request.
 * @public
 */
util.deleteWebstrate = async function (page, url) {
	// Accept the webstrate URL with or without a trailing slash, and ignore
	// whatever query string or fragment it carries.
	const docUrl = url.split(/[?#]/)[0];
	const baseUrl = docUrl.endsWith('/') ? docUrl : docUrl + '/';
	try {
		await page.goto(baseUrl + '?delete', { waitUntil: 'domcontentloaded' });
	} catch (e) {
		// The page's own client redirecting to the front page aborts the navigation
		// above — the delete itself has already been processed at that point.
		if (!e.message.includes('net::ERR_ABORTED')) throw e;
	}

	// Whichever navigation won, the page must end up off the deleted webstrate.
	const left = await util.waitFor(async () =>
		!page.url().startsWith(baseUrl), 25);
	if (!left) {
		throw new Error(`Page never left ${baseUrl} after ?delete — the webstrate ` +
			'may not have been deleted.');
	}
};

module.exports = util;