var WebSocketClient = require('websocket').client;
var readline = require("readline");
var chalk = require("chalk");

var rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

var client = new WebSocketClient();

client.on('connectFailed', function(error) {
	console.log('Connect Error: ' + error.toString());
});

client.on('connect', function(connection) {

	var version;

	function send(msg) {
		console.log(chalk.blue(msg));
		connection.sendUTF(msg);
	}

	connection.on('error', function(error) {
		console.log("Connection Error: ", error);
	});

	connection.on('close', function() {
		console.log("Connection closed.");
		process.exit();
	});

	connection.on('message', function(message) {
		var response = JSON.parse(message.utf8Data);

		console.log(chalk.green(JSON.stringify(response)));
		if (response.a === "init") {
			rl.question("WebstrateId: ", function(webstrateId) {
				webstrateId = webstrateId || "contenteditable";
				send(JSON.stringify({
					a: "s", c: "webstrates",
					d: webstrateId
				}));

				var seq = 1;
				var questionLoop = function() {
					rl.question("", function(answer) {
						if (!answer) {
							return questionLoop();
						}
						var command = answer.split(" ")[0];
						var args = answer.substring(command.length + 1);
						args = args.replace(/(['"])?([a-z0-9A-Z_]+)(['"])?:/g, '"$2": '); // Add quotes around key
						switch (command) {
							case "op":
							var op = JSON.parse(args);
								send(JSON.stringify({
									a: "op", c: "webstrates", d: webstrateId, v: version, v: version, seq: seq++, op: op
								}));
								break;
							case "raw":
								var raw = JSON.parse(args);
								send(JSON.stringify(raw));
								break;
							default:
								console.log(chalk.red("Unknown command:"), command);
								break;
						}
						questionLoop();
					});
				};

				questionLoop();
			});
		}

		if (response.data) {
			version = response.data.v;
		} else if (response.v) {
			version = response.v;
		}

	});
});

client.connect('ws://localhost:7007/ws/');