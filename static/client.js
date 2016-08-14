/*
Copyright 2016 Clemens Nylandsted Klokmose, Aarhus University

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
(function() {
	"use strict";
	document.addEventListener("DOMContentLoaded", function(event) {
		// Get the Webstrates ID from the URL path.
		var webstrateId = location.pathname.substring(1);
		if (!webstrateId) {
			throw "Error: No webstrate ID provided.";
		}

		// Determine websocket protocol based on http/https protocol.
		var protocol = location.protocol;
		var wsProtocol = protocol === 'http:' ? 'ws:' : 'wss:';

		// Establish a WebSocket connection to the server to be used by Webstrates.
		var websocket = new ReconnectingWebSocket(`${wsProtocol}//${location.host}/ws/`);

		// Set up a webstrate.
		window.webstrate = new webstrates.Webstrate(websocket, webstrateId);
	});
})();