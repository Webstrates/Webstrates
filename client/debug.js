const debugModule = {};

function tryStringify(obj) {
	try {
		return JSON.stringify(obj);
	} catch (e) {
		return obj;
	}
}

if (config.VERBOSE_MODE) {
	if (window.chrome) {
		debugModule.log = (...args) => {
			args = args.map(arg => typeof arg === 'object' ? tryStringify(arg) : arg);
			let callstack = new Error().stack;
			let location = callstack.split('\n')[2].match(/\((.*)\)$/)[1];
			console.debug('[' + location + ']', ...args);
		};
	} else {
		// Safari's error.stack string is useless, so we just divert the arguments directly to
		// console.debug.
		console.debug('For a better debug.log results, please use Chrome.');
		debugModule.log = (...args) => {
			console.debug(...args);
		};
	}
} else {
	debugModule.log = () => {};
}
module.exports = debugModule;