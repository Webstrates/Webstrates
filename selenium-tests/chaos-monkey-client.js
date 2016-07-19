/*
Chaos Monkey Script
This script performs random operations on the DOM.
*/
(function() {
	"use strict";

	// Number of operations to perform before halting. A value of -1 makes the script run until manually terminated.
	var MAX_OPERATION_COUNT = 1000;
	// Time in milliseconds between operations are performed on the document. You may be tempted to set this very low,
	// but PhantomJS will then thank you with a segmentation fault.
	var AVERAGE_MS_BETWEEN_OPERATIONS = 500;
	// The desired number of DOM elements in the document. This number will be used when deciding whether to
	// add, remove or move DOM elements.
	var DESIRED_DOCUMENT_SIZE = 1000;
	// Probability that an element being added is a void element (i.e. self-closing element like `<br>`.
	var CREATE_VOID_ELEMENT_PROBABILITY = .2;
	// Probability that an element should have a child.
	var CREATE_CHILD_PROBABILITY = .8;
	// Probability that a child created should be a text note (as opposed to a regular node).
	var CHILD_IS_TEXT_NODE_PROBABILITY = .8;
	// Probability that a created element should have styles attached.
	var ELEMENT_SHOULD_HAVE_STYLE_PROBABILITY = 1;
	// Probability of performing random operation regardless of DESIRED_DOCUMENT_SIZE.
	var RANDOM_OPERATION_PROBABILITY = .3;
	// Probability of using `append` instead of `insertBefore` when adding elements.
	var APPEND_INSTEAD_OF_INSERT_BEFORE_PROBABILITY = .5;

	var normalElements = ["div", "span", "p", "h1", "h2", "h3", "em", "strong"];
	var voidElements = ["br", "hr"];
	var textNodes = ["Lorem Ipsum...", "Foo", "Bar"];
	var styles = {
		"color": {
			probability: .5,
			values: ["inherit", "initial", "rgba(0, 0, 0, .2)", "rgba(0, 255, 0, 1)", "red", "#00f", "#0088FF"]
		},
		"background": {
			probability: .2,
			values: ["inherit", "initial", "rgba(0, 0, 0, 1)", "rgba(0, 255, 0, 0.2)", "green", "#ff0", "#8800FF"]
		},
		"font-size": {
			probability: .5,
			values: ["inherit", "initial", "120%", "12pt", ".8em", "xx-small", "medium"]
		},
		"font-family": {
			probability: .8,
			values: ["inherit", "initial", "sans-serif", "monospace"]
		},
		"width": {
			probability: .3,
			values: ["inherit", "initial", "auto", "10px", "200px", "5cm", "8em", "1%", "200%"]
		},
		"height": {
			probability: .1,
			values: ["inherit", "initial", "auto", "10px", "200px", "5cm", "8em", "1%", "200%"]
		},
		"display": {
			probability: .2,
			values: ["inherit", "initial", "none", "inline", "block", "flex", "inline-block", "table", "run-in"]
		},
	};

	function pickRandom(collection) {
		return collection[Math.floor(Math.random()*collection.length)];
	}

	/*function elementToString(element) {
		var wrapper = document.createElement("div");
		wrapper.appendChild(element);
		return wrapper.innerHTML;
	}*/

	function createRandomTextNode() {
		var textContents = pickRandom(textNodes);
		return document.createTextNode(textContents + "\n");
	}

	function addRandomElement() {
		document.body.appendChild(createRandomElement());
	}

	function createRandomElement() {
		if (Math.random() <= CREATE_VOID_ELEMENT_PROBABILITY) {
			var rootElement = document.createElement(pickRandom(voidElements));
			return rootElement;
		}

		var rootElement = document.createElement(pickRandom(normalElements));
		if (Math.random() <= ELEMENT_SHOULD_HAVE_STYLE_PROBABILITY) {
			rootElement = addStylesToElement(rootElement);
		}

		while (Math.random() <= CREATE_CHILD_PROBABILITY) {
			var newElement = Math.random() <= CHILD_IS_TEXT_NODE_PROBABILITY
				? createRandomTextNode()
				: createRandomElement();
			rootElement.appendChild(newElement);
		}

		return rootElement;
	}

	function removeRandomElement() {
		var allElements = document.body.getElementsByTagName("*");
		var randomElement = pickRandom(allElements);
		randomElement.parentElement.removeChild(randomElement);
	}

	function moveRandomElementAround() {
		var allElements = document.body.getElementsByTagName("*");
		var destinationElement = pickRandom(allElements);

		// We want to make sure we are not adding an element to its own tree. Otherwise, it'll disappear.
		// After 10 tries, we give up.
		var attempts = 0;
		do {
			var targetElement = pickRandom(allElements);
		} while ((attempts++ < 10) && (targetElement === destinationElement || targetElement.contains(destinationElement)));

		if (Math.random() <= APPEND_INSTEAD_OF_INSERT_BEFORE_PROBABILITY) {
			destinationElement.appendChild(targetElement);
		} else {
			destinationElement.parentElement.insertBefore(targetElement, destinationElement);
		}
	}

	function addStylesToElement(element) {
		for (var styleId in styles) {
			if (Math.random() <= styles[styleId].probability) {
				element.style[styleId] = pickRandom(styles[styleId].values);
			}
		}

		return element;
	}

	function run() {
		var iterationCounter = 0;
		function performOperation() {
				if (MAX_OPERATION_COUNT !== -1 && iterationCounter > MAX_OPERATION_COUNT) {
					return;
				}
				iterationCounter++;

				var documentSize = document.body.getElementsByTagName("*").length;

				if (documentSize > 2 && Math.random() <= RANDOM_OPERATION_PROBABILITY) {
					pickRandom([addRandomElement, removeRandomElement, moveRandomElementAround])();
				} else if (documentSize === DESIRED_DOCUMENT_SIZE) {
					moveRandomElementAround();
				} else if (documentSize < DESIRED_DOCUMENT_SIZE) {
					addRandomElement();
				} else {
					removeRandomElement();
				}

				setTimeout(performOperation,
					Math.random() * 2 * AVERAGE_MS_BETWEEN_OPERATIONS);
		}

		document.addEventListener("loaded", performOperation);
	}

	run();

})();