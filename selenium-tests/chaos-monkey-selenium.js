"use strict";

var webdriver = require('selenium-webdriver');
var browser = new webdriver.Builder().usingServer(/*'http://localhost:4444/wd/hub'*/)
	.withCapabilities({'browserName': 'chrome' }).build();

var fs = require('fs');
var chaosMonkeyScript = fs.readFileSync("./chaos-monkey-client.js", "utf8");

browser.get('http://web:strate@localhost:7007/test-chaos-monkey');
browser.executeScript(chaosMonkeyScript);