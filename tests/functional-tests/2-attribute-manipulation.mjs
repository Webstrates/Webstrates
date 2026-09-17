// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert } from 'chai';
import config from '../config.js';
import util from '../util.js';

describe('Attribute Manipulation', function() {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });
		util.showLogs(pageA);

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		pageA.on("console", async (msg)=>{
			const msgType = msg.type();
			const msgText = msg.text();
		  
			console.log(`PAGE A CONSOLE [${msgType.toUpperCase()}]: ${msgText}`);
		  
			if (msgType === 'error') {
			  const args = msg.args();
			  if (args.length > 0) {
				try {
				  const firstArg = args[0];
		  
				  // Check if the first argument is likely an Error object
				  // We evaluate a function in the page context to get message and stack
				  const errorDetails = await firstArg.evaluate(obj => {
					// Check if it's an instance of Error or has error-like properties
					if (obj instanceof Error || (typeof obj === 'object' && obj !== null && 'message' in obj && 'stack' in obj)) {
					  return {
						message: obj.message,
						stack: obj.stack,
						name: obj.name,
						// Add any other properties you might be interested in
					  };
					}
					// Fallback if it's not an error object (e.g., just a string or number)
					return obj;
				  });
		  
				  if (errorDetails && typeof errorDetails === 'object' && 'message' in errorDetails) {
					console.error('  Resolved Error Details:');
					console.error('    Message:', errorDetails.message);
					console.error('    Stack:', errorDetails.stack);
					if (errorDetails.name) {
					  console.error('    Name:', errorDetails.name);
					}
				  } else {
					// If it wasn't an Error object after all, just log its resolved value
					const resolvedArgs = await Promise.all(args.map(arg => arg.jsonValue()));
					console.error('  Resolved Console Arguments:', resolvedArgs);
				  }
		  
				} catch (e) {
				  console.error('  Error processing console error arguments:', e);
				}
			  }
			}
		})
		pageB.on("console", async (msg)=>{
			const msgType = msg.type();
			const msgText = msg.text();
		  
			console.log(`PAGE B CONSOLE [${msgType.toUpperCase()}]: ${msgText}`);
		  
			if (msgType === 'error') {
			  const args = msg.args();
			  if (args.length > 0) {
				try {
				  const firstArg = args[0];
		  
				  // Check if the first argument is likely an Error object
				  // We evaluate a function in the page context to get message and stack
				  const errorDetails = await firstArg.evaluate(obj => {
					// Check if it's an instance of Error or has error-like properties
					if (obj instanceof Error || (typeof obj === 'object' && obj !== null && 'message' in obj && 'stack' in obj)) {
					  return {
						message: obj.message,
						stack: obj.stack,
						name: obj.name,
						// Add any other properties you might be interested in
					  };
					}
					// Fallback if it's not an error object (e.g., just a string or number)
					return obj;
				  });
		  
				  if (errorDetails && typeof errorDetails === 'object' && 'message' in errorDetails) {
					console.error('  Resolved Error Details:');
					console.error('    Message:', errorDetails.message);
					console.error('    Stack:', errorDetails.stack);
					if (errorDetails.name) {
					  console.error('    Name:', errorDetails.name);
					}
				  } else {
					// If it wasn't an Error object after all, just log its resolved value
					const resolvedArgs = await Promise.all(args.map(arg => arg.jsonValue()));
					console.error('  Resolved Console Arguments:', resolvedArgs);
				  }
		  
				} catch (e) {
				  console.error('  Error processing console error arguments:', e);
				}
			  }
			}
		})
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	const tests = [
		{
			title: 'regular attribute',
			key: 'some-attr',
			value: util.randomString()
		},
		{
			title: 'attribute with quotes in value',
			key: 'quotesInAttribute',
			value: util.randomString(3) + '"' + util.randomString(3)  + '\''
		},
		{
			title: 'attribute with ampersand in value',
			key: 'AMPERSAND_ATTRIBUTE',
			value: util.randomString(3) + '&' + util.randomString(4)
		},
		{
			title: 'long attribute with quotes in value',
			key: 'quotesInAttributeLong',
			value: util.randomString(3) + '"' + util.randomString(4) + "----------------------------------------------------------------------------------------"
		},		
		{
			title: 'long attribute with ampersand in value',
			key: 'AMPERSAND_LONG_ATTRIBUTE',
			value: util.randomString(3) + '&' + util.randomString(4) + "----------------------------------------------------------------------------------------"
		},		
		{
			title: 'attribute with periods',
			key: 'some.attr.with.periods',
			value: util.randomString()
		},
	];

	tests.forEach(({ title, key, value }) => {
		it('should be possible to set ' + title, async () => {
			await pageA.evaluate((key, value) => document.body.setAttribute(key, value),
				key, value);

			const attributeGetsSetA = await util.waitForFunction(pageA, (key, value) =>
				document.body.getAttribute(key) === value,
			undefined, key, value);

			const attributeGetsSetB = await util.waitForFunction(pageB, (key, value) =>
				document.body.getAttribute(key) === value,
			undefined, key, value);

			let attA = await pageA.evaluate((key)=>{
				return document.body.getAttribute(key);
			}, key);				
			let attB = await pageB.evaluate((key)=>{
				return document.body.getAttribute(key);
			}, key);	

			assert.equal(attA, value);
			assert.equal(attB, value);
		});
	});

	const prependTests = [
		{
			insertType: 'letter a',
			insertValue: "a"
		},	
		{
			insertType: 'ampersand',
			insertValue: "&"
		},			
		{
			insertType: 'double quotes',
			insertValue: "\""
		},			
		{
			insertType: 'small random string',
			insertValue: util.randomString(3)
		},		
		{
			insertType: 'long random string',
			insertValue: util.randomString(50)
		},		
	]

	prependTests.forEach(({insertType, insertValue})=>{
		tests.forEach(({ title, key, value }) => {
			it('should be possible to prepend ' + insertType + " to " + title, async () => {
				let combinedValue = insertValue + value;
				await pageB.evaluate((key, value) => document.body.setAttribute(key, value),
					key, combinedValue);
	
				const attributeGetsSetA = await util.waitForFunction(pageA, (key, value) =>
					document.body.getAttribute(key) === value,
				undefined, key, combinedValue);
	
				const attributeGetsSetB = await util.waitForFunction(pageB, (key, value) =>
					document.body.getAttribute(key) === value,
				undefined, key, combinedValue);

				let attA = await pageA.evaluate((key)=>{
					return document.body.getAttribute(key);
				}, key);				
				let attB = await pageB.evaluate((key)=>{
					return document.body.getAttribute(key);
				}, key);	
	
				assert.equal(attA, combinedValue);
				assert.equal(attB, combinedValue);
			});
		});
	});
});

// Webstrates in protected mode (data-protected on the <html> tag) only sync attributes that
// have been approved. Uppercase attribute names get lowercased by setAttribute in HTML
// documents (e.g. 'myAttr' is stored as 'myattr'), but the approval used to be registered
// under the name as written — so the attribute was deemed transient and never synced to
// other clients
describe('Attribute Manipulation in Protected Mode', function() {
	this.timeout(15000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId + '/';
	let browser, pageA, pageB;

	before(async () => {
		browser = await puppeteer.launch();

		pageA = await browser.newPage();
		await pageA.goto(url, { waitUntil: 'networkidle2' });

		pageB = await browser.newPage();
		await pageB.goto(url, { waitUntil: 'networkidle2' });

		await pageA.evaluate(() =>
			document.documentElement.setAttribute('data-protected', 'all'));

		const dataProtectedSetB = await util.waitForFunction(pageB, () =>
			document.documentElement.getAttribute('data-protected') === 'all', 5);
		assert.isTrue(dataProtectedSetB, 'data-protected attribute should be synced');

		// Protected mode is only enabled after a reload.
		await Promise.all([pageA.reload({ waitUntil: 'networkidle2' }),
			pageB.reload({ waitUntil: 'networkidle2' })]);

		// Puppeteer polls waitForFunction with timers inside the page, and Chrome suspends
		// timers in background tabs — so bring each page to the front while waiting on it, and
		// keep pageB (the page the test waits on) in front for the test itself.
		await pageA.bringToFront();
		await util.waitForFunction(pageA, () => window.webstrate && window.webstrate.loaded, 5);
		await pageB.bringToFront();
		await util.waitForFunction(pageB, () => window.webstrate && window.webstrate.loaded, 5);
	});

	after(async () => {
		await pageA.goto(url + '?delete', { waitUntil: 'domcontentloaded' });

		await browser.close();
	});

	it('should be possible to set an attribute with capital letters on an approved element',
		async () => {
			await pageA.evaluate(() => {
				const div = document.createElement('div', { approved: true });
				div.setAttribute('myAttr', 'value');
				document.body.appendChild(div);
			});

			// The div arrives on pageB asynchronously, so the element may not exist (yet) when
			// waitForFunction first runs its predicate — checking for null avoids throwing in
			// the predicate before the div has been inserted.
			const attributeGetsSetB = await util.waitForFunction(pageB, () => {
				const div = document.body.firstElementChild;
				return div && div.getAttribute('myAttr') === 'value';
			}, 8);
			assert.isTrue(attributeGetsSetB,
				'attribute with capital letters should be visible on other client');
		});
});