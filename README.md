Webstrate
=========

Webstrate is part of the Instrument Interaction For The Web (IIFTW) research project. IIFTW is a research project on applying instrumental interaction as a paradigm for collaborative editing on the web.
IIFTW consists of two things 
 * A website with a server backend (this)
 * A browser plugin for Chrome for managing user instruments

The idea of IIFTW is to let editing of content be a matter of manipulating the DOM of a website. 
Hence, we can decouple interaction logic and interaction techniques (instruments) from content. 
Instruments are then provided through a browser extension, meaning that users can define their own interaction with content.

Webstrate server
----------------
Webstrate runs on [node.js](http://nodejs.org/) using [share.js](http://sharejs.org/) for concurrent editing.
To run the server:

	# coffee webstrate.coffee
	
Now head to localhost:8000 in your browser and you should see a message to provide a document id.
To get a document go to localhost:8000/mydocument and now a document is created on the server named mydocument that anyone can access by going to that URL.

Any changes that are now applied to the DOM is persisted and shared with anyone who have the same document open in their browser.

There are three modes the server can run in. Starting it with the above command will only keep the documents in memory until the server is restarted.
To provide persistance across restarts of the server it is possible to start the server with [redis](http://redis.io/) support

	# coffee server.coffee redis
	
This requires that the redis in-memory database is running on the local host.

To provide full persistance the server can use [couchdb](http://couchdb.apache.org/)

	# coffee server.coffee couchdb
	
This requires a running couchdb database that has been bootstrapped for share.js.
To bootstrap the server, create a database named sharejs, and go to _node\_modules/share/bin_ and execute the script _setup\_couch_.

