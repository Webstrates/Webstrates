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

module.exports = coreConfigModule;