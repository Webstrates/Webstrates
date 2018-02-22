const config = require('./config.js');

const util = {};

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

// Remove HTTP basic auth credentials from the server address, e.g. http://web:strate@domain.tld/
// becomes http://domain.tld/. Useful for comparing page URL with server address and for iframes,
// as having credentials in iframe src attributes is prohibited.
util.cleanServerAddress = config.server_address.replace(/^(https?:\/\/)([^@]+@)/, '$1');

// Whether we're testing on localhost. Some tests that depend on latency might not work properly
// this way.
util.isLocalhost = util.cleanServerAddress.match('https?://localhost') !== null;

util.waitForFunction = async function(page, fn, timeout = 1, ...args) {
	try {
		await page.waitForFunction(fn, { timeout: timeout * 1000 }, ...args);
	} catch (e) {
		if (e.message.match(/^waiting failed: timeout \d+ms exceeded$/)) {
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
	if (!config.username || !config.password) {
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

	await page.focus('input#login_field');
	await page.type(config.username);
	await page.focus('input#password');
	await page.type(config.password);
	await page.click('input[type=submit]');

	// Wait for redirect to authorize URL.
	await page.waitForNavigation({ waitUntil: 'networkidle2' });

	// Sometimes, we might need to reauthorize.
	title = await page.title();
	if (title === 'Authorize application') {
		// It seems the login button isn't immediately available after page load (probably to prevent
		// automation, woups...), so we wait for it to become clickable.
		await util.sleep(3);
		await page.click('button[name=authorize]');
	}

	url = await page.url();
	// If we get sent back to the GitHub login page
	if (url === 'https://github.com/session') {
		const flashMsg = await page.evaluate(() =>
			document.querySelector('div#js-flash-container').innerText);
		throw new Error(flashMsg);
	}

	// Wait for redirect back to Webstrates server or error page.
	await page.waitForNavigation({ waitUntil: 'networkidle2' });

	return true;
};

util.sleep = async function(seconds) {
	return new Promise(resolve => setTimeout(resolve, seconds * 1000));
};

module.exports = util;