Webstrates
=========

Webstrates is a research prototype enabling collaborative editing of websites through DOM manipulations realized by [Operational Transformation](http://en.wikipedia.org/wiki/Operational_transformation) using [ShareJS](https://github.com/share/ShareJS). Webstrates observes changes to the DOM using [MutationObservers](https://developer.mozilla.org/en/docs/Web/API/MutationObserver).

Webstrates itself is a webserver and transparent web client  that persists and synchronizes any changes done to the Document Object Model (DOM) of any page served between clients of the same page, including changes to inlined JavaScript or CSS. By using [transclusions](https://en.wikipedia.org/wiki/Transclusion) through iFrames we achieve an application-to-document like relationship between two webstrates. The 'application', however, is a malleable and collaborative object as well, as any change to its DOM will persist and be shared between clients. With examples built upon Webstrates we have demonstrated how transclusion combined with the use of CSS injection and the principles of [instrumental interaction](https://www.lri.fr/~mbl/INSTR/eintroduction.html) can allow multiple users to collaborate same webstrate through highly personalized and extensible editors. You can find the academic paper and videos of Webstrates in action at [webstrates.net](http://www.webstrates.net).

Installation
============
Requirements:
 * [MongoDB](http://www.mongodb.org)
 * [NodeJS](http://nodejs.org)
 * [CoffeeScript](http://coffeescript.org)

To install:
 * Clone this repository
 * From the repository root do:
    * npm install
    * cake build
    * coffee webstrates.coffee
	
Alternatively [use Vagrant](utils/vagrant) to create and run a VM configured with Webstrates.
 
Basic Usage
===========
Webstrates serves (and creates) any named webpage you ask for.<br>
Simply navigate your browser* to http://localhost:7007/[some_page_name].<br>
Now any changes you make to the DOM either through JavaScript or the developer tools will be persisted and distributed to any other clients that may have the page open.

\* Webstrates is currently only tested under Chrome

Advanced Use
============

Advanced creation of webstrates
-------------------------------
 * GET on *http://localhost:7007/new* will create a new webstrate with a random id
 * GET on *http://localhost:7007/new?prototype=foo* will create a new webstrate with a random id using the webstrate *foo* as prototype
 * GET on *http://localhost:7007/new?prototype=foo&id=bar* will create a new webstrate with id *bar* using the webstrate *foo* as prototype
 * GET on *http://localhost:7007/new?prototype=foo&v=10&id=bar* will create a new webstrate with id *bar* using version 10 of the webstrate *foo* as prototype

Accessing the history of a webstrate
------------------------------------
 * GET on *http://localhost:7007/some\_webstrate?v* will return the version number of *some\_webstrate*
 * GET on *http://localhost:7007/some\_webstrate?v=10* will return the raw HTML of version 10 of *some\_webstrate*
 * GET on *http://localhost:7007/some\_webstrate?v=head* will return the raw HTML of the current version of *some\_webstrate*
 * GET on *http://localhost:7007/some\_webstrate?ops* will return a list of all operations applied to *some\_webstrate* (beware: can be a huge list)

DOM events
----------
Webstrates triggers a few events on the DOM.

###Events when a webstrate has finished loading
When the Webstrates client has finished loading a webstrate it will trigger a *loaded* event on the *document*.

```javascript
document.addEventListener('loaded', function(e) {
	//The Webstrates client has now finished loading data from the server
});
````
	
If the webstrate is transcluded in an iframe the webstrate will trigger a *transcluded* event on the *iframe* element in the parent webstrate.

```javascript
some_iframe.addEventListener('transcluded', function(e) {
	//The transcluded webstrate has finished loading data from the server
});
```

###Events on text nodes
Webstrates does finegrained synchronization on text nodes, however to update a textnode in the browser, the whole text is replaces. To allow more finegrained interaction with text Webstrates raises the following two events on textnodes: 

```javascript
textNode.addEventListener("insertText", function(e) {
	e.detail.value; //Stores the inserted text
	e.detail.position; //Stores the position of the insert
});
textNode.addEventListener("deleteText", function(e) {
	e.detail.value; //Stores the deleted text
	e.detail.position; //Stores the position of the delete
});
```
	
###Authentication

####Server level basic authentication
To enable basic authentication on the Webstrates server add the following to *config.json*:
```javascript
"basic_auth": {
	"realm": "Webstrates",
	"username": "some_username",
	"password": "some_password"
}
```
	
####Per webstrate access rights (VERY EXPERIMENTAL)
It is possible to enable per webstrate access rights using [GitHub](https://github.com) as authentication provider. 
This requires registering an OAuth application with GitHub [here](https://github.com/settings/applications/new).

Add the following to your *config.json*:

```javascript
"auth": {
	"secret": "This is a secrret",
	"cookieDuration": 31536000000,
	"providers": {
		"github": {
			"GITHUB_CLIENT_ID": "YOUR GITHUB CLIENT ID",
			"GITHUB_CLIENT_SECRET": "YOUR GITHUB CLIENT SECRET",
			"callback_url": "http://localhost:7007/auth/github/callback"
		}
	}
}
```
	
Access rights are added to a webstrate as an attribute on the *HTML* tag.

```html
<html data-auth="[{"username": "cklokmose", "provider": "github", "permissions": "rw"}, {"username": "anonymous", "provider": "", "permissions": "r"}]">
...
</html>
```

The above example provides the user *cklokmose* authenticated using GitHub permissions to read and write, while anonymous users only have read access.

Users can log in through http://localhost:7007/auth/github

In the future more authentication providers will be supported.

Disclaimer
==========
Webstrates is work-in-progress and the mapping between the DOM to a ShareJS document is not 100% water proof yet.
After each set of DOM manipulations Webstrate checks the integrity of the mapping between DOM and ShareJS document, and may throw an exception if something is off. If this happens just reload the page.

License
=======

This work is licenced under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)
