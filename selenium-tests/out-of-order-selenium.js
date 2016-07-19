"use strict";

var webdriver = require('selenium-webdriver');
var browser = new webdriver.Builder().usingServer(/*'http://localhost:4444/wd/hub'*/).withCapabilities({'browserName': 'chrome' }).build();

var fs = require('fs');
var outOfOrderScript = fs.readFileSync("./out-of-order-client.js", "utf8");

browser.get('http://localhost:7007/test-out-of-order');
browser.executeScript(outOfOrderScript);