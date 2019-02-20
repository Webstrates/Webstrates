'use strict';

const coreConfigModule = {
	attributeValueDiffing: true,
};

Object.defineProperty(coreConfigModule, 'isTransientElement', {
	get: () => config.isTransientElement,
	set: fn => {
		if (typeof fn !== 'function') throw new Error('isTransientElement must be a function');
		return config.isTransientElement = fn;
	}
});

Object.defineProperty(coreConfigModule, 'isTransientAttribute', {
	get: () => config.isTransientAttribute,
	set: fn => {
		if (typeof fn !== 'function') throw new Error('isTransientAttribute must be a function');
		return config.isTransientAttribute = fn;
	}
});

Object.defineProperty(coreConfigModule, 'peerConnectionConfig', {
	get: () => config.peerConnectionConfig,
	set: obj => {
		if (typeof obj !== 'object') throw new Error('peerConnectionConfig must be an object');
		return config.peerConnectionConfig = obj;
	}
});

Object.defineProperty(coreConfigModule, 'serverConfig', {
	// serverConfig gets injected with webpack at compile-time, the string serverConfig below will
	// literally be replaced with the value defined in webpack.config.js. Therefore, we have to have
	// the return and curly brackets, or the object itself would be interpreted as a code block, e.g.
	//   get: () => { threads: 4, niceWebstrateIds: true, ... },
	get: () => { return serverConfig; },
	set: () => { throw new Error('Server config is read-only'); }
});

module.exports = coreConfigModule;