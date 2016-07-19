Webstrates
=========

Webstrates is a research prototype enabling collaborative editing of websites through DOM manipulations realized by [Operational Transformation](http://en.wikipedia.org/wiki/Operational_transformation) using [ShareJS](https://github.com/share/ShareJS). Webstrates observes changes to the DOM using [MutationObservers](https://developer.mozilla.org/en/docs/Web/API/MutationObserver).

Webstrates itself is a webserver and transparent web client  that persists and synchronizes any changes done to the Document Object Model (DOM) of any page served between clients of the same page, including changes to inlined JavaScript or CSS. By using [transclusions](https://en.wikipedia.org/wiki/Transclusion) through iframes, we achieve an application-to-document-like relationship between two webstrates. With examples built upon Webstrates, we have demonstrated how transclusion combined with the use of CSS injection and the principles of [instrumental interaction](https://www.lri.fr/~mbl/INSTR/eintroduction.html) can allow multiple users to collaborate on the same webstrate through highly personalized and extensible editors. You can find the academic paper and videos of Webstrates in action at [webstrates.net](http://www.webstrates.net).

Installation
============
Requirements:

 * [MongoDB](http://www.mongodb.org)
 * [NodeJS](http://nodejs.org)

To install:

 * Clone this repository.
 * From the repository root:
    * Copy `config-sample.json` to `config.json` and modify it.
    * Run `npm install`.
    * Run `npm run build-babel`.
    * Run `npm start`.
    * Navigate to `http://localhost:7007/` in your browser and start using Webstrates!

Alternatively, [use Vagrant](utils/vagrant) to create and run a VM configured with Webstrates.

Basic Usage
===========
Webstrates serves (and creates) any named webpage you ask for. Simply navigate your browser* to `http://localhost:7007/<some_name>`.

Now, any changes you apply to the DOM, either through JavaScript or the developer tools, will be persisted and distributed to any other clients that have the page open.

See the [tutorial](docs/tutorial) for an introduction to developing with Webstrates.

### Compatibility table*

|   Google Chrome   |       Opera       |          Apple Safari (OS X)           | Apple Safari (iOS)  |   Mozilla Firefox   |    Microsoft Edge   |
|:-----------------:|:-----------------:|:--------------------------------------:|:-------------------:|:-------------------:|:-------------------:|
| Compatible (51.0) | Compatible (38.0) | Compatible (9.1.2, Technology Preview) |  Compatible (9.0)   | Incompatible (46.0) | Incompatible (15.1) |

Safari is only compatible when using [Babel](https://babeljs.io/). It is therefore important to do `npm run build-babel` before starting the server.

### jQuery

The Webstrates client includes jQuery 1.7.2 for backwards compatibility. This will be removed in future version of Webstrates and should therefore not be relied on. The user should include all their own libraries in each webstrate.

Advanced Usage
==============

Advanced creation of webstrates
-------------------------------
 * GET on `http://<server host>/new` will create a new webstrate with a random id.
 * GET on `http://<server host>/new?prototype=foo` will create a new webstrate with a random id using the webstrate `foo` as prototype.
 * GET on `http://<server host>/new?prototype=foo&id=bar` will create a new webstrate with id `bar` using the webstrate `foo` as prototype.
 * GET on `http://<server host>/new?prototype=foo&v=10&id=bar` will create a new webstrate with id `bar` using version 10 of the webstrate `foo` as prototype.

Accessing the history of a webstrate
------------------------------------
 * GET on `http://<server host>/<some_name>?v` will return the version number of `<some_name>`.
 * GET on `http://<server host>/<some_name>?v=10` will return the raw HTML of version 10 of `<some_name>`.
 * GET on `http://<server host>/<some_name>?v=head` will return the raw HTML of the current version of `<some_name>`.
 * GET on `http://<server host>/<some_name>?ops` will return a list of all operations applied to `<some_name>`. (beware: can be a huge list)

DOM events
----------
The user may subscribe to certain events triggered by Webstrates using `webstrates.on(event, function)`. When an event occurs, the attached function will be triggered with potential arguments.

### Trigger event when a webstrate has finished loading

When the Webstrates client has finished loading a webstrate, it will trigger `loaded` event on webstrate instance. Using the default `client.html` and `client.js`,  the webstrance instance will be attached to the point element as `window.webstrate`. Thus, a user may attach events to `webstrate.on`:

```javascript
webstrate.on('loaded', function(webstrateId, clientId) {
	// The Webstrates client has now finished loading.
});
```

If a webstrate has been transcluded (i.e. loaded in an iframe), a `transcluded` event will be triggered, both within the transcluded iframe, but also on the iframe element itself:

```javascript
var myIframe = document.createElement("iframe");
myIframe.src = "/some_webstrate";
myIframe.webstrate.on("transcluded", function(webstrateId, clientId) {
	// The webstrate client in the iframe has now finished loading.
});
```

### Events on text nodes

Webstrates does fine-grained synchronization on text nodes, however, to update a text node in the browser, the whole text is replaced. To allow more finegrained interaction with text, Webstrates also dispatches text insertion and deletion events on text nodes:

```javascript
textNode.webstrate.on("insertText", function(position, value) {
	// Some text has just been inserted into textNode.
});

textNode.webstrate.on("deleteText", function(position, value) {
	// Some text has just been deleted from textNode.
});
```

#### Full list of `on` events

| Event         | Arguments                 | Description                                                       |
|---------------|---------------------------|-------------------------------------------------------------------|
| `loaded`      | Webstrate Id, Client ID   | Triggered when the webstrate document has finished loading.       |
| `transcluded` | Webstrate Id, Client ID   | Triggered if a webstrate is transcluded and has finished loading. |
| `clientJoin`  | Client ID                 | Triggered when a client joins the document.                       |
| `clientPart`  | Client ID                 | Triggered when a client leaves the document.                      |
| `insertText`  | Position, Value           | Triggered when a text has been inserted into a Text Node.         |
| `deleteText`  | Position, Value           | Triggered when text has been deleted from a Text Node.            |

For backwards compatibility, `loaded` and `transcluded` events are also fired as regular DOM events on `document`, and likewise, `insertText` and `deleteText` events are being fired on the appropriate text nodes.

Authentication
--------------

#### Server level basic authentication
To enable basic HTTP authentication on the Webstrates server, add the following to `config.json`:

```javascript
"basic_auth": {
	"realm": "Webstrates",
	"username": "some_username",
	"password": "some_password"
}
```

#### Per-webstrate permissions
It is possible to enable per webstrate access rights using [GitHub](https://github.com) as authentication provider.
This requires [registering an OAuth application with GitHub](https://github.com/settings/applications/new). Afterwards, access to a specific webstrate may be restricted to a specific set of GitHub users.

Add the following to your `config.json`:

```javascript
"auth": {
	"secret": "This is a secret",
	"cookieDuration": 31536000000,
	"providers": {
		"github": {
            "node_module": "passport-github",
            "config": {
                "clientID": "<github client id>",
                "clientSecret": "<github Secret>",
                "callbackURL": "http://<server host>/auth/github/callback"
            }
		}
	}
}
```

Access rights are added to a webstrate as a `data-auth` attribute on the `<html>` tag:

```html
<html data-auth="[{"username": "cklokmose", "provider": "github", "permissions": "rw"}, {"username": "anonymous", "provider": "", "permissions": "r"}]">
...
</html>
```

The above example provides the user with GitHub username *cklokmose*  permissions to read and write (modify the webstrate), while anonymous users only have read access.

Users can log in by accessing `http://<server host>/auth/github`.

In the future, more authentication providers will be supported.

#### Default permissions

It is also possible to set default permissions. Adding the following under the `auth` section in `config.json` will apply the same permissions as above to all webstrates with a `data-auth` property.

```javascript
"defaultPermissions": [
	{"username": "cklokmose", "provider": "github", "permissions": "rw"}
	{"username": "anonymous", "provider": "", "permissions": "r"}
]
```

### A note on Quirks Mode and Standards Mode

Previous versions of Webstrates have run in [Quirks Mode](http://www.quirksmode.org/css/quirksmode.html). However, the current version ships with "strict mode". The user is encouraged to conform to the standard, but if quirks mode is required (for compliance with legacy code), the doctype (`<!doctype html>`) can be removed from the top of `static/client.html`.

Disclaimer
==========
Webstrates is a work-in-progress and the mapping between the DOM to a ShareDB document is not perfectly bulletproof.
After each set of DOM manipulations, Webstrate checks the integrity of the mapping between DOM and ShareDB document, and may throw an exception if something is off. If this happens just reload the page.

License
=======

This work is licenced under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).
