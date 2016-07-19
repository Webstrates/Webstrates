/*
Out Of Order Script
This script modifies a list of elements in rapid succession in order to provoke an error from ShareJS.
*/
window.running = true;
(function() {
	"use strict";

	// Number of operations to perform before halting. A value of -1 makes the script run until manually terminated.
	var MAX_OPERATION_COUNT = -1;
	// Time in milliseconds between operations are performed on the document. You may be tempted to set this very low,
	// but PhantomJS will then thank you with a segmentation fault.
	var AVERAGE_MS_BETWEEN_OPERATIONS = 0;
	// The desired number of DOM elements in the document. This number will be used when deciding whether to
	// add, remove or move DOM elements.
	var DESIRED_DOCUMENT_SIZE = 1000;
	// Probability of performing random operation regardless of DESIRED_DOCUMENT_SIZE.
	var RANDOM_OPERATION_PROBABILITY = .3;

	var color = randomColor();
	var rootElement = document.createElement("div");
	document.body.appendChild(rootElement);

	function pickRandom(collection) {
		return collection[Math.floor(Math.random()*collection.length)];
	}

	function randomColor() {
		var color = "#";
		for (var i=0; i < 3; i++) {
			color += (Math.random() * 16 | 0).toString(16);
		}
		return color;
	}

	function addElement() {
		var element = document.createElement("div");
		element.style.backgroundColor = color; //randomColor();
		element.style.height = "10px";
		element.style.width = "10px";
		element.style.float = "left";
		var allElements = rootElement.getElementsByTagName("*");
		var destinationElement = pickRandom(allElements);
		rootElement.insertBefore(element, destinationElement);
	}

	function removeElement() {
		var allElements = rootElement.getElementsByTagName("*");
		var randomElement = pickRandom(allElements);
		randomElement.parentElement.removeChild(randomElement);
	}

	function run() {
		var iterationCounter = 0;
		function performOperation() {
				if (MAX_OPERATION_COUNT !== -1 && iterationCounter > MAX_OPERATION_COUNT) {
					return;
				}
				iterationCounter++;

				var delay = 1000;
				if (window.running) {
					var documentSize = rootElement.getElementsByTagName("*").length;

					if (documentSize > 2 && Math.random() <= RANDOM_OPERATION_PROBABILITY) {
						pickRandom([addElement, removeElement])();
					} else if (documentSize < DESIRED_DOCUMENT_SIZE) {
						addElement();
					} else {
						removeElement();
					}
					delay = Math.random() > 0.02 ? 2 : 1000;
				}
				setTimeout(performOperation, delay);
		}

		if (window.loaded) {
			performOperation();
		} else {
			document.addEventListener("loaded", performOperation);
		}
	}

	run();

})();