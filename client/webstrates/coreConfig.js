'use strict';

const coreConfigModule = {
	attributeValueDiffing: true,
};

Object.defineProperty(coreConfigModule, 'isTransientElement', {
	get: () => config.isTransientElement,
	set: fn => {
		if (typeof fn !== 'function') throw new Error('isTransientElement must be a function');
		config.isTransientElement = fn;
	}
});

Object.defineProperty(coreConfigModule, 'isTransientAttribute', {
	get: () => config.isTransientAttribute,
	set: fn => {
		if (typeof fn !== 'function') throw new Error('isTransientAttribute must be a function');
		config.isTransientAttribute = fn;
	}
});

Object.defineProperty(coreConfigModule, 'peerConnectionConfig', {
	get: () => config.peerConnectionConfig,
	set: obj => {
		if (typeof obj !== 'object') throw new Error('peerConnectionConfig must be an object');
		config.peerConnectionConfig = obj;
	}
});

// The serverConfig value gets injected with webpack at compile-time: the string
// serverConfig below will literally be replaced with the object defined in
// webpack.config.js. It is captured into a constant once so that every access returns
// the same object — reading the injected literal directly in the getter would construct
// a fresh copy on every access, and mutations (the client version check in
// coreWebsocket.js reads serverConfig.clientVersion) would never be seen anywhere.
const serverConfigObject = serverConfig;

Object.defineProperty(coreConfigModule, 'serverConfig', {
	get: () => serverConfigObject,
	set: () => { throw new Error('Server config is read-only'); }
});

module.exports = coreConfigModule;