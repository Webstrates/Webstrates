// Instruction to ESLint that 'describe', 'before', 'after' and 'it' actually has been defined.
/* global describe before after it */
import puppeteer from 'puppeteer';
import { assert, expect } from 'chai';
import config from '../config.js';
import util from '../util.js';

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

const IMAGE_DATA = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFzGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNS41LjAiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iCiAgICB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIKICAgZXhpZjpDb2xvclNwYWNlPSIxIgogICBleGlmOlBpeGVsWERpbWVuc2lvbj0iMzIiCiAgIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSIzMiIKICAgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIKICAgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIgogICB0aWZmOkltYWdlTGVuZ3RoPSIzMiIKICAgdGlmZjpJbWFnZVdpZHRoPSIzMiIKICAgdGlmZjpSZXNvbHV0aW9uVW5pdD0iMiIKICAgdGlmZjpYUmVzb2x1dGlvbj0iNzIvMSIKICAgdGlmZjpZUmVzb2x1dGlvbj0iNzIvMSIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNS0wOC0xOFQxMjo0MTo0MyswMjowMCIKICAgeG1wOk1vZGlmeURhdGU9IjIwMjUtMDgtMThUMTI6NDE6NDMrMDI6MDAiPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgeG1wTU06YWN0aW9uPSJwcm9kdWNlZCIKICAgICAgeG1wTU06c29mdHdhcmVBZ2VudD0iQWZmaW5pdHkgRGVzaWduZXIgMS4xMC41IgogICAgICB4bXBNTTp3aGVuPSIyMDIyLTA4LTExVDEwOjU5OjI5KzAyOjAwIi8+CiAgICAgPHJkZjpsaQogICAgICB4bXBNTTphY3Rpb249InByb2R1Y2VkIgogICAgICB4bXBNTTpzb2Z0d2FyZUFnZW50PSJBZmZpbml0eSBQaG90byAxLjEwLjUiCiAgICAgIHhtcE1NOndoZW49IjIwMjItMDgtMTFUMTU6MDc6MDMrMDI6MDAiLz4KICAgICA8cmRmOmxpCiAgICAgIHN0RXZ0OmFjdGlvbj0icHJvZHVjZWQiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFmZmluaXR5IFBob3RvIDIgMi42LjMiCiAgICAgIHN0RXZ0OndoZW49IjIwMjUtMDgtMThUMTI6NDE6NDMrMDI6MDAiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogIDwvcmRmOkRlc2NyaXB0aW9uPgogPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KPD94cGFja2V0IGVuZD0iciI/PvZnu+8AAAGCaUNDUHNSR0IgSUVDNjE5NjYtMi4xAAAokXWRzytEURTHPzOIxmiEhYXFpCGLGTFqsFFm0lCTpjHKr83MMz/U/Hi9N9Jkq2wVJTZ+LfgL2CprpYiUrNkSG/ScZ9RMMud27vnc773ndO+5YI1mlKxe2wfZXEGLBP3Omdk5Z/0zDbRgo4fBmKKro+FwiKr2fovFjNces1b1c/9a42JCV8DSIDyiqFpBeFw4tFJQTd4SblPSsUXhE2G3JhcUvjH1eImfTE6V+NNkLRoJgLVZ2Jmq4HgFK2ktKywvx5XNLCu/9zFfYk/kpqckdop3oBMhiB8nE4wRwEc/wzL78OClV1ZUye/7yZ8kL7mKzCpFNJZIkaaAW9RlqZ6QmBQ9ISND0ez/377qyQFvqbrdD3WPhvHaBfWb8LVhGB8HhvF1CDUPcJ4r5+f3YehN9I2y5toDxxqcXpS1+DacrUP7vRrTYj9Sjbg1mYSXY2iahdYrsM2Xeva7z9EdRFflqy5hZxe65bxj4Ruejmf/iAWTSgAAAAlwSFlzAAALEwAACxMBAJqcGAAAAmxJREFUWIXtlt+LTVEUxz9z75Dp5ncuZcp48uuBFA/Kg19RyqPhYfDkR8xfoIaUSPJChJKm/MqDvMjPJ7pJYe4TKYQYZcyYGt0rcx0P+5xa1l3rnFNe76pd9+z92eu79rp77b2hZS371+YAZ4FB4BcwAlSAdf/ptwd4AdSAH8AdoEtDJeADEBltHFiTIlAGNsRtrhrb6Ph8CRQluMwBk3bdEd8O/BZcA9gvxg+k+NwmHbUBZ1Lgu4b4LMLfpNkBwUwFvjg+TxYEGMXRnnZW+tHoOwhMM/rfiN+jwEXHZ6lgdFYduKK+u4C9DntefT9yuIlWZz/NqWoQKiSLi4Dnhs+yw17Q4ATguwE+VtzyOCjLabezUos9rsEtDihT3QY8cbh3QLsRQIfD92jwpgHVgBmC2ek4i4BeQxxggcH+ATolNB2oG+BVwcwGhhzxUcJhZtkOg3+qoT2O4/WCuZWyer3zpd0w+KYKqhjQeyAp1d0p4hGwyhEv05zZYWCKhBY5Tg/F4ysIe8ETHxKBajtq8H0aOmFADWAe4XL5lLH6+454J/BTsZ/16ovYZ/UDwjlezRCPgMuGeAG4Z7BbNbjWcdpLOIBk31fgmcH2GwEcMbgrVpqs9EfAW/U9BqwErhmsvD/agWMG8wqV+sRuOwHIVgc2xfwph7lE2FyvjbFBjBdQYg8zxGvAZsF35whYb7rFnnhWBkaA1YovEeo4j/gAMD9NHGCfM7kKLHTmeKdm0sYJD5uOLHEI5XKOcDlEwDfgMDApY94umst3jHB3LM0jDOFqTWwmMJlw6DRyzi8CSwhvw2HCTq/nFW9ZywD+Al9yhORsjkEmAAAAAElFTkSuQmCC`;

describe.only('Assets', function () {
	this.timeout(10000);

	const webstrateId = 'test-' + util.randomString();
	const url = config.server_address + webstrateId;

	let browser, page;
	let testDir;
	let testAssets = [];

	before(async () => {
		browser = await puppeteer.launch();
		page = await browser.newPage();
		await page.goto(url, { waitUntil: 'domcontentloaded' });

		// Create test folder and files
		testDir = path.join(process.cwd(), 'tests', 'test-assets');
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}

		// Create a simple text file
		const textFile = path.join(testDir, 'test.txt');
		fs.writeFileSync(textFile, 'This is a test file for asset testing.');
		testAssets.push(textFile);

		// Create a simple CSV file for searchable assets
		const csvFile = path.join(testDir, 'test.csv');
		fs.writeFileSync(csvFile, 'name,age,city\nJohn,25,New York\nJane,30,Los Angeles\nBob,35,Chicago');
		testAssets.push(csvFile);

		// Create an image file
		const imageFile = path.join(testDir, 'test.png');
		fs.writeFileSync(imageFile, Buffer.from(IMAGE_DATA.split(',')[1], 'base64'));
		testAssets.push(imageFile);


		// Create ZIP file using a Promise to ensure it completes before continuing
		// Create a simple ZIP with the above files
		const zipFile = path.join(testDir, 'test.zip');
		await new Promise((resolve, reject) => {
			const output = fs.createWriteStream(zipFile);
			const archive = archiver('zip');

			output.on('close', () => {
				resolve();
			});
			archive.on('error', (err) => {
				reject(err);
			});

			// Add files to the archive
			archive.pipe(output);
			archive.file(textFile, { name: 'test.txt' });
			archive.file(csvFile, { name: 'test.csv' });
			archive.file(imageFile, { name: 'test.png' });
			archive.finalize();
		});
		testAssets.push(zipFile);
	});

	after(async () => {
		// Clean up test files
		testAssets.forEach(file => {
			if (fs.existsSync(file)) {
				fs.unlinkSync(file);
			}
		});
		if (fs.existsSync(testDir)) {
			fs.rmdirSync(testDir);
		}

		await page.goto(url + '?delete', { waitUntil: 'domcontentloaded' });
		await browser.close();
	});

	it('Users should be able to upload assets', async () => {

	});

	it('Assets should be accessible from their URL', async () => {

	});

	it('Assets should be accessible from the API', async () => {

	});

	it('Assets should be able to be deleted', async () => {

	});

	it('Files within ZIP archives should be listable', async () => {

	});

	it('Files within ZIP archives should be directly accessible via their URL', async () => {

	});

	// TODO: Searchable CSVs?
});