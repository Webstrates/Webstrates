const config = require('./config.js');

const util = {};

config.username = config.username || process.env.GITHUB_USERNAME;
config.password = config.password || process.env.GITHUB_PASSWORD;

util.randomString = function(size = 8,
	alphabet = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ') {
	let len = alphabet.length, str = '';
	while (size--) {
		str += alphabet[Math.floor(Math.random() * len)];
	}
	return str;
};

util.allEquals = function(x, y, ...rest) {
	if (y === undefined) return true;
	if (x !== y) return false;
	return util.allEquals(y, ...rest);
};

util.escapeRegExp = function(s) {
	return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
};

util.webstrateIdRegex =  (config.server && config.server.niceWebstrateIds)
	? '([a-z]{2,13}-[a-z]{2,13}-\\d{1,3})'
	: '([A-z0-9-]{8,10})';

// Remove HTTP basic auth credentials from the server address, e.g. http://web:strate@domain.tld/
// becomes http://domain.tld/. Useful for comparing page URL with server address and for iframes,
// as having credentials in iframe src attributes is prohibited.
util.cleanServerAddress = config.server_address.replace(/^(https?:\/\/)([^@]+@)/, '$1');

// Whether we're testing on localhost. Some tests that depend on latency might not work properly
// this way.
util.isLocalhost = util.cleanServerAddress.match('https?://localhost') !== null;

util.credentialsProvided = config.username && config.password;
/**
 * Wait for predicate to become truthy or timeout.
 * @param  {Page} page         Puppeteer page.
 * @param  {Function} fn       Predicate function.
 * @param  {Number} timeout    Timeout in seconds.
 * @param  {mixed} args        Arguments to pass to function.
 * @return {bool}              True if predicate became truthy false otherwise.
 * @public
 */
util.waitForFunction = async function(page, fn, timeout = 1, ...args) {
	if (typeof timeout !== 'number') {
		throw new Error(`Invalid timeout: ${timeout}, expected number.`);
	}
	try {
		await page.waitForFunction(fn, { timeout: timeout * 1000 }, ...args);
	} catch (e) {
		// Using (.*) wildcard to be compatible with error messages from older versions of Puppeteer.
		if (e.message.match(/^waiting (.*)failed: timeout \d+ms exceeded$/)) {
			return false;
		}
		throw e;
	}
	return true;
};

util.showLogs = (page, ...pages) => {
	page.on('console', msg => console.log(`[page:${msg.type()}] ${msg.text()}`));
	if (pages.length > 0) {
		util.showLogs(...pages);
	}
};

util.warn = (...args) => console.log('\u001b[33m    ! ' + args + '\u001b[0m');

util.logInToGithub = async function(page) {
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

	await page.type('input#login_field', config.username);
	await page.type('input#password', config.password);
	await page.click('input[type=submit]');

	// Wait for redirect to authorize URL.
	await page.waitForNavigation({ waitUntil: 'networkidle2' });

	// Sleeping to circumvent bug: https://github.com/GoogleChrome/puppeteer/issues/1325
	await util.sleep(1);

	// Sometimes, we might need to reauthorize.
	title = await page.title();
	if (title === 'Authorize application') {
		// It seems the login button isn't immediately available after page load (probably to prevent
		// automation, woups...), so we wait for it to become clickable.
		await util.sleep(3);
		await page.click('button[name=authorize]');
		await page.waitForNavigation({ waitUntil: 'networkidle2' });
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

util.sleep = async function(seconds) {
	return new Promise(resolve => setTimeout(resolve, seconds * 1000));
};

module.exports = util;