// Instruction to ESLint that 'describe' and 'it' actually has been defined.
/* global describe it */
'use strict';
var assert = require('chai').assert;

const coreEvents = require('../../client/webstrates/coreEvents');

describe('Event Management', function() {

	it('should be able to create event', function() {
		coreEvents.createEvent('testEvent1');
	});

	it('event should exist after creation', function() {
		assert(coreEvents.eventExists('testEvent1') === true);
	});

	it('unknown event should not exist', function() {
		assert(coreEvents.eventExists('testEvent2') === false);
	});

	it('should not be able to create event that exists', function() {
		assert.throws(function() {
			coreEvents.createEvent('testEvent1');
		}, Error, 'Event testEvent1 already exists.');
	});

	it('should be able to trigger event that exists', function() {
		coreEvents.triggerEvent('testEvent1');
	});

	it('should not be able to trigger event that does not exist', function() {
		assert.throws(function() {
			coreEvents.triggerEvent('testEvent2');
		}, Error, 'Event testEvent2 doesn\'t exist.');
	});

	it('should be able to add event listener to event that exists', function() {
		coreEvents.addEventListener('testEvent1', function() {});
	});

	it('should not be able to add event listener to event that does not exist', function() {
		assert.throws(function() {
			coreEvents.addEventListener('testEvent2', function() {});
		}, Error, 'Event testEvent2 doesn\'t exist.');
	});
});

describe('Event Triggering', function() {

	coreEvents.createEvent('testEvent3');

	it('should trigger event with arguments', function() {
		coreEvents.triggerEvent('testEvent3', 'foo');
	});

	it('should pass arguments to eventlistener', function(done) {
		coreEvents.addEventListener('testEvent3', function(a, b) {
			assert(a === 'bar' && b === 'quux', 'a should be bar and b should be quux');
			done();
		});
		coreEvents.triggerEvent('testEvent3', 'bar', 'quux');
	});

});

describe('Listener Priority', function() {

	it('should not throw error on valid priority', function() {

		assert.doesNotThrow(function() {
			coreEvents.PRIORITY.IMMEDIATE;
			coreEvents.PRIORITY.HIGH;
			coreEvents.PRIORITY.MEDIUM;
			coreEvents.PRIORITY.LOW;
			coreEvents.PRIORITY.LAST;
		});

	});

	it('should throw error on invalid priority', function() {

		assert.throws(function() {
			coreEvents.PRIORITY.SOMETHING_UNDEFINED;
		}, Error, 'Invalid priority SOMETHING_UNDEFINED');

	});

	it('should respect priority in execution order', function(done) {

		var promises = [];
		var result = [];

		coreEvents.createEvent('testEvent4');

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.LOW);
				accept();
			}, coreEvents.PRIORITY.LOW);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.HIGH);
				accept();
			}, coreEvents.PRIORITY.HIGH);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.MEDIUM);
				accept();
			}, coreEvents.PRIORITY.MEDIUM);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.IMMEDIATE);
				accept();
			}, coreEvents.PRIORITY.IMMEDIATE);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.LAST);
				accept();
			}, coreEvents.PRIORITY.LAST);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.LOW);
				accept();
			}, coreEvents.PRIORITY.LOW);
		}));

		promises.push(new Promise(function(accept) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.LOW);
				accept();
			} /* Adding without priority should default to LOW PRIORITY */);
		}));

		promises.push(new Promise(function(resolve) {
			coreEvents.addEventListener('testEvent4', () => {
				result.push(coreEvents.PRIORITY.HIGH);
				resolve();
			}, coreEvents.PRIORITY.HIGH);
		}));

		result.push('beforeTrigger');
		coreEvents.triggerEvent('testEvent4');
		result.push('afterTrigger');

		Promise.all(promises).then(function() {
			try {
				assert.deepEqual(result, [
					'beforeTrigger',
					coreEvents.PRIORITY.IMMEDIATE,
					'afterTrigger',
					coreEvents.PRIORITY.HIGH,
					coreEvents.PRIORITY.HIGH,
					coreEvents.PRIORITY.MEDIUM,
					coreEvents.PRIORITY.LOW,
					coreEvents.PRIORITY.LOW,
					coreEvents.PRIORITY.LOW,
					coreEvents.PRIORITY.LAST
				]);
				done();
			} catch (e) {
				done(e);
			}
		});
	});

});