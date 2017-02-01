Webstrates
==========

Webstrates is a research prototype enabling collaborative editing of websites through DOM manipulations realized by [Operational Transformation](http://en.wikipedia.org/wiki/Operational_transformation) using [ShareDB](https://github.com/share/sharedb). Webstrates observes changes to the DOM using [MutationObservers](https://developer.mozilla.org/en/docs/Web/API/MutationObserver).

Webstrates itself is a webserver and transparent web client that persists and synchronizes any changes done to the Document Object Model (DOM) of any page served between clients of the same page, including changes to inlined JavaScript or CSS. By using [transclusions](https://en.wikipedia.org/wiki/Transclusion) through iframes, we achieve an application-to-document-like relationship between two webstrates. With examples built upon Webstrates, we have demonstrated how transclusion combined with the use of CSS injection and the principles of [instrumental interaction](https://www.lri.fr/~mbl/INSTR/eintroduction.html) can allow multiple users to collaborate on the same webstrate through highly personalized and extensible editors. You can find the academic paper and videos of Webstrates in action at [webstrates.net](http://www.webstrates.net).

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

Note: If you are updating from the ShareJS version of Webstrates, you may want to [migrate the database](https://github.com/Webstrates/sharedb-migration-tool).

Basic Usage
===========
Webstrates serves (and creates) any named webpage you ask for. Simply navigate your browser* to `http://localhost:7007/<webstrateId>`. To have the server generate a webstrate with a random id, instead navigate to `http://<localhost:7007>/new`.

Now, any changes you apply to the DOM, either through JavaScript or the developer tools, will be persisted on the server and distributed to any other clients that have the page open.

See the [tutorial](https://github.com/Webstrates/tutorials) for an introduction to developing with Webstrates.

### Compatibility table

|   Google Chrome   |       Opera       |          Apple Safari (OS X)           | Apple Safari (iOS)  |   Mozilla Firefox   |    Microsoft Edge   |
|:-----------------:|:-----------------:|:--------------------------------------:|:-------------------:|:-------------------:|:-------------------:|
| Compatible (51.0) | Compatible (38.0) | Compatible (9.1.2, Technology Preview) |  Compatible (9.0)   | Incompatible (46.0) | Incompatible (15.1) |

\* Safari is only compatible when using [Babel](https://babeljs.io/). It is therefore important to do `npm run build-babel` before starting the server.

### jQuery

The Webstrates client includes jQuery 1.7.2 for backwards compatibility. This will be removed in future version of Webstrates and should therefore not be relied on. The user should include all their own libraries in each webstrate.

Advanced Usage
==============

Advanced creation of webstrates
-------------------------------

* GET on `http://<hostname>/<webstrateId>/?copy` will create a new webstrate with a random id using the webstrate `<webstrateId>` as prototype.
* GET on `http://<hostname>/<webstrateId>?copy=<newWebstrateId>` will create a new webstrate with id `<newWebstrateId>` using the webstrate `<webstrateId>` as prototype.
* GET on `http://<hostname>/<webstrateId>/<versionOrTag>/?copy=<newWebstrateId>` will create a new webstrate with id `<newWebstrateId>` using version or tag `<versionOrTag>` of the webstrate `<webstrateId>` as prototype. If the `?copy` value is left out, a random id will be generated.

**Legacy operations**

The below operations are still supported, but may disappear at any time.

* GET on `http://<hostname>/new?prototype=<webstrateId>` will create a new webstrate with a random id using the webstrate `<webstrateId>` as prototype.
* GET on `http://<hostname>/new?prototype=<webstrateId>&id=<newWebstrateId>` will create a new webstrate with id `<newWebstrateId>` using the webstrate `<webstrateId>` as prototype.
* GET on `http://<hostname>/new?prototype=<webstrateId>&v=<version>&id=<newWebstrateId>` will create a new webstrate with id `<newWebstrateId>` using version `<version>` of the webstrate `<webstrateId>` as prototype. If the `?id` value is left out, a random id will be generated.

Accessing the history of a webstrate
------------------------------------
* GET on `http://<hostname>/<webstrateId>/?v` will return the version number of `<webstrateId>`.
* GET on `http://<hostname>/<webstrateId>?tags` will return a list of tags associated with `<webstrateId>`.
* GET on `http://<hostname>/<webstrateId>?ops` will return a list of all operations applied to `<webstrateId>` (Beware: this can be a huge list).
* GET on `http://<hostname>/<webstrateId>/?static` will return a static version of webstrate `<webstrateId>`.
* GET on `http://<hostname>/<webstrateId>/<versionOrTag>/` will return a static version of webstrate `<webstrateId>` at version or tag `<versionOrTag>`.
* GET on `http://<hostname>/<webstrateId>/?raw` will return a raw version of webstrate `<webstrateId>`.
* GET on `http://<hostname>/<webstrateId>/<versionOrTag>/?raw` will return a raw version of webstrate `<webstrateId>` at version or tag `<versionOrTag>`.

**A note on static and raw**

On normal requests, the Webstrates server serves a static `client.html` with JavaScripts that replace the DOM with the content of the webstrate. When using the `raw` parameter, the Webstrates server instead serves the raw HTML. No JavaScript Webstrates JavaScript is executed on the client side, and no WebSocket connection is established. This also means that DOM elements do not have attached `webstrate` objects, and as a result you cannot listen for Webstrate events.

When accessing a `static` version of a document, Webstrates serves `client.html` as per usual, and the webstrate requested is also generated on the client similar to how it is done for normal requests. Any changes made to the webstrate, however, are not persisted or shared between clients.

Restoring a webstrate
---------------------
* GET on `http://<hostname>/<webstrateId>?restore=<versionOrTag>` restores the document to look like it did in version or tag `<versionOrTag>` and redirects the user to `/<webstrateId>`. This will apply operations on the current verison until the desired version is reached and will therefore not break the operations log or remove from it, but only add additional operations.

Alternatively, a Webstrate can be restored by calling `webstrate.restore(versionOrTag, fn)`. `fn` is a function callback that takes two arguments, a potential error (or null) and the new version:

```javascript
webstrate.restore(versionOrTag, function(error, newVersion) {
  if (error) {
    // Handle error.
  } else {
    // Otherwise, document is now at newVersion, identical to
    // the document at versionOrTag.
});
```

When calling `webstrate.restore` in a static webstrate, the static webstrate is restored to the requested version, but the changes are not persisted.

Deletion of a webstrate
-----------------------
* GET on `http://<hostname>/<webstrateId>?delete` will delete the document and redirect all connected users to the server root. The document data including all assets will be cometeply removed from the server.

Events
------
The user may subscribe to certain events triggered by Webstrates using `webstrate.on(event, function)` (the webstrate instance) or `DOMElement.webstrate.on(event, function)` (the webstrate object attached to every DOM element). When an event occurs, the attached function will be triggered with potential arguments.

### Trigger event when a webstrate has finished loading

When the Webstrates client has finished loading a webstrate, it will trigger a `loaded` event on the Webstrate instance. Using the default `client.html` and `client.js`,  the webstrate instance will be attached to the window element as `window.webstrate`. Thus, a user may attach events to `webstrate.on`:

```javascript
webstrate.on("loaded", function(webstrateId, clientId, user) {
  // The Webstrates client has now finished loading.
});
```

If a webstrate has been transcluded (i.e. loaded in an iframe), a `transcluded` event will be triggered, both within the transcluded iframe, but also on the iframe element itself:

```javascript
var myIframe = document.createElement("iframe");
myIframe.src = "/some_webstrate";
myIframe.webstrate.on("transcluded", function(webstrateId, clientId, user) {
  // The webstrate client in the iframe has now finished loading.
});
document.body.appendChild(myIframe);
```

If the client is logged in using a passport provider (like GitHub), `user` will be an object containinig a `userId`, `username`, `provider` and `displayName`. This object is also available on the global `webstrate` instance as `webstrate.user`.

### Events on text nodes

Webstrates does fine-grained synchronization on text nodes and attributes, however, to update a text node or attribute in the browser, the whole text is replaced. To allow more fine-grained interaction with text, Webstrates also dispatches text insertion and deletion events on text nodes and element nodes:

```javascript
textNode.webstrate.on("insertText", function(position, value) {
  // Some text has just been inserted into textNode.
});

textNode.webstrate.on("deleteText", function(position, value) {
  // Some text has just been deleted from textNode.
});

elementNode.webstrate.on("insertText", function(position, value, attributeName) {
  // Some text has just been inserted into an attribute on elementNode.
});

elementNode.webstrate.on("deleteText", function(position, value, attributeName) {
  // Some text has just been deleted from an attribute on textNode.
});
```

### Added and removed nodes

Listening for added or removed nodes can be done using `nodeAdded` and `nodeRemoved`:

```javascript
parentElement.webstrate.on("nodeAdded", function(node, local) {
  // Some node was added.
});

parentElement.webstrate.on("nodeRemoved", function(node, local) {
  // Some node was removed
});
```

`local` will be true if the change originated in the current browser, or false if it originated elsewhere.

### Changing attributes

Attribute changes will trigger `attributeChanged`:

```javascript
childElement.webstrate.on("attributeChanged", function(attributeName, oldValue, newValue, local) {
  // Some attribute changed.
});
```

If the attribute has just been added, `oldValue` will be `undefined`. If an attribute has just been removed, `newValue` will be `undefined`. If an attribute has just been updated, `oldValue` and `newValue` will contain what you'd expect.

`local` will be true if the change originated in the current browser, or false if it originated elsewhere.

#### Full list of `on` events

| Event                  | Arguments                                | Triggered when:                                               |
|------------------------|------------------------------------------|---------------------------------------------------------------|
| `loaded`               | webstrateId, clientId, user              | The document has finished loading.                            |
| `transcluded`          | webstrateId, clientId, user              | The document has been transcluded and has finished loading.   |
| `clientJoin`           | clientId                                 | A client joins the document.                                  |
| `clientPart`           | clientId                                 | A client leaves the document.                                 |
| `insertText`           | position, value [, attributeName]        | A text has been inserted into a text node or attribute.       |
| `deleteText`           | position, value [, attributeName]        | A text has been deleted from a text node or attribute.        |
| `nodeAdded`            | node, local                              | A node has been added to the document.                        |
| `nodeRemoved`          | node, local                              | A node has been removed from the document.                    |
| `attributeChanged`     | attributeName, newValue, oldValue, local | An attribute has added/modified/removed on an element.        |
| `cookieUpdateHere`     | key, value                               | A "here" cookie has been added/modified.                      |
| `cookieUpdateAnywhere` | key, value                               | An "anywhere" cookie has been added/modified.                 |
| `signal`               | message, senderId, node                  | A client (senderId) signals on a DOM node.                    |
| `tag`                  | version, label                           | A tag has been added to the webstrate.                        |
| `untag`                | version                                  | A tag has been removed from the webstrate.                    |
| `asset`                | asset object (version, file name, etc.)  | An asset has been added to the webstrate.                     |
| `permissionsChanged`   | newPermissions, oldPermissions           | The user's document permissions has changed.                  |
| `disconnect`           |                                          | The user has been disconnected from the Webstrates server.    |
| `reconnect `           |                                          | The user reconnects after having been disconnected.           |

All the events can also be unregistered using `off`, e.g.:

```javascript
webstrate.on("loaded", function loadedFunction() {
  // Work here...
  webstrate.off("loaded", loadedFunction);
});
```
For backwards compatibility, `loaded` and `transcluded` events are also fired as regular DOM events on `document`, and likewise, `insertText` and `deleteText` events are being fired on the appropriate text nodes.

All the events can also be unregistered using `off`, e.g.:

```javascript
webstrate.on("loaded", function loadedFunction() {
  // Work here...
  webstrate.off("loaded", loadedFunction);
});
```
For backwards compatibility, `loaded` and `transcluded` events are also fired as regular DOM events on `document`, and likewise, `insertText` and `deleteText` events are being fired on the appropriate text nodes.


Cookies
-------
Webstrates has a built-in cookie mechanism that allows logged in users to persist JavaScript objects across devices. There are two kinds of cookies: "anywhere" cookies, which may be accessed and modified from any webstrate the user is accessing, and document-bound cookies ("here"), only available from the webstrate they were created in.

The cookies are simple key-value stores persisted on the server and distributed to the user's connected clients. Any serializable JavaScript object can be stored in cookies. To set an "anywhere" cookie `foo` with the value `bar`, call:

    webstrate.user.cookies.anywhere.set("foo", "bar");

To retrieve it again (possibly in another webstrate, from another device the user is logged in to), the application/user may call:

    webstrate.user.cookies.anywhere.get("foo");

and get back `bar`. "here" cookies are managed in a similar fashion through `webstrate.cookies.here.set()` and `webstrate.cookies.here.get()`.

To retrieve all cookies, call `get()` without any parameters on the appropriate object.

Cookies can only be saved for logged-in users, hence their placement on the `webstrate.user` object, which won't exist for non-logged in users.

Listening for cookie updates can be done by subscribing to `cookieUpdateHere` and `cookieUpdateAnywhere` events, e.g.:

    webstrate.on("cookieUpdateHere", function(key, value) {
      // A cookie key-value pair was added/updated.
    });

Note that contrary to HTTP cookies, the cookies' contents are stored on the server; only the session token (the user's credentials) are stored in an actual HTTP cookie. Setting a value on one client will therefore be persisted to all of the user's other connected clients.

Assets
------
Webstrates supports the attachment of assets (files). Files can be attached to a Webstrate by performing a POST with a file `file` to the Webstrate's address:

```html
<form action="" method="post" enctype="multipart/form-data">
  <input type="file" name="file">
  <input type="submit" value="Upload">
</form>
```

The `action` attribute in the above is the empty string (`""`), meaning the form will submit to itself. When adding the above code to a webstrate at `/myWebstrate/`, and submitting the form with a file, the request will be made to `/myWebstrate/` and the file added to myWebstrate. Submitting to another webstrate is also possible by changing the `action` attribute. Note that forms *must* have `enctype="multipart/form-data"` to be accepted.

### Adding assets

Uploading an asset will attach it to the current version of the document, but may also be accessed by future versions, assuming no other asset has been added with the same name since. For instance, uploading `cow.jpg` at version 1 to myWebstrate will make it possible to access it at `/myWebstrate/cow.jpg`, `/myWebstrate/1/cow.jpg`, `/myWebstrate/2/cow.jpg` etc., assuming those versions exist. If, however, another `cow.jpg` is uploaded at version 3, any requests to `/myWebstrate/3/cow.jpg`, `/myWebstrate/4/cow.jpg` and so forth will refer to the new `cow.jpg`, but any requests to previous versions will still refer to the old `cow.jpg`. Accessing `/myWebstrate/cow.jpg` will naturally always point to the newest version of `cow.jpg`.

Copying and restoring Webstrates will also take the assets into account and perform as expected: Copying a webstrate will also copy over the assets to the new webstrate, so deleting the source webstrate won't result in the assets in the new webstrate disappearing. Restoring a webstrate will bump the version of the older assets (e.g. the first version of `cow.jpg`) to the version of the restored webstrate.

When submitting an asset, the server will return a JSON object representing the asset, e.g.:

```javascript
{
  v: 128,
  fileName: "cow.jpg",
  fileSize: 138666,
  mimeType: "image/jpg"
}
```

In the above example, we have uploaded an image `cow.jpg` with a size of 135 KB (138666 bytes) to version 128 of the document (the current version).

Note that an asset is always attached to the newest version of a webstrate, because the philosophy of Webstrates is to never modify the history of a document, but only append to it. For the same reason, restoring a webstrate also doesn't modify the history, but only appends to it. Assets cannot be deleted, except by deleting the entire document.

### Accessing assets

All assets for a webstrate can be listed by making a GET request to `/<webstrateId>/?assets` or by calling `webstrate.assets()`. Additionally, it is possible to get notified whenever an asset is added to the webstrate. This is done by listening for the `asset` event:

```javascript
webstrate.on("asset", function(asset) {
  // Asset was added to the webstrate.
});
```
The asset object will be similar to the one shown above.

Signaling
---------
Subscribe to signals on DOM elements and receive messages from other clients sending signals on the DOM element. Useful especially for huge amounts of data that will be expensive to continuously publish through the DOM (e.g. sensor data).

Listen for messages on `elementNode`:

```javascript
elementNode.webstrate.on("signal", function(message, senderId, node) {
  // Received message from senderId on node.
});
```

`node` will always equal `elementNode`, but may be useful if the node is no longer in scope.

Send messages on `elementNode`:

```javascript
elementNode.webstrate.signal(message, [recipients]);
```

An optional array of Client IDs (`recipients`) can be passed in. If recipients is not defined, all subscribers will recieve the message, otherwise only the clients in `recipients` will. Recipients are never aware of who else has received the signal.

Instead of listening for specific signals on DOM nodes, it is also possible to listen for all events using the webstrate instance.

```javascript
webstrate.on("signal", function(message, senderId, node) {
  if (node) {
    // Signal sent on node.
  } else {
    // Signal sent on webstrate instance.
  }
});
```

If the signal was sent on the webstrate instance (`webstrate.signal(message, [recipients])`), `node` will be undefined, otherwise `node` will be the DOM element the signal was sent on.

Listening on the webstrate instance does not circumvent the recipients mechanism -- subscribers will still not recieve signals specifically addressed to other clients.

Tagging
-------
For easier navigation through document revisions, Webstrate includes tagging. A tag is a label applied to a specific version of the document.

All tags for a document can be seen by either accessing `http://<hostname>/<webstrateId>?tags` or calling `webstrate.tags()` in the Webstrate. The current tag can also be seen by calling `webstrate.tag()`.

Listening for tagging and untagging can be done using the two events `tag` and `untag`:

```javascript
webstrate.on("tag", function(version, label) {
  // A version has been tagged with a label.
});
```

Subscribing to untagging is done in a similar fashion, except only a `version` parameter will be given.

#### Manual tagging
Tagging can be done by calling `webstrate.tag(label, [version])`. If no version is supplied, the current version will be used. A label can be any text string that does not begin with a number.

Restoring a document from a tag can be achieved by calling `webstrate.restore(label)`.

A tag can be removed by calling `webstrate.untag(label)` or `webstrate.untag(version)`.

All labels are unique for each Webstrate (i.e. no two versions of the same document can carry the same label), and likewise each version can only have one label. Adding a label to a version that is already tagged will overwrite the existing tag. Adding a label that already exists on another version will move the tag to the new version.

#### Auto-tagging

In addition to manual tagging, Webstrates also automatically creates tags when a user starts modifying a document after a set period of inactivity. By default, the inactivity period is defined to be 3600 seconds (60 minutes). This can be modified by changing `autotagInterval` in `config.json`. Tags are labeled with the current timestamp, making it easy to track when changes were made to a document.


Transient data
--------------
Webstrates comes with a custom HTML element `<transient>`. This lets users create DOM trees that are not being synced by Webstrates. That is to say, any changes made to the children of a `<transient>` element (or to the element itself) will not be persisted or shared among the other clients. Useful especially for storing data received through signaling.

```html
<html>
<body>
  This content will be saved on the server and synchronized to all connected users as per usual.
  <transient>This tag and its contents will only be visible to the user who created the tag.</transient>
</body>
</html>
```
Disclaimer: If a user reloads a webstrate in which they had transient data, the data will be unrecoverable.

Connected clients
-----------------
Other than detecting when clients connect and disconnect through the `clientJoin` and `clientPart` events described previously, the webstrate instance also holds a list of client IDs of connected clients access through `webstrate.clients`.

Handling user connection
------------------------
The user's current connection status is stored in `webstrate.connectionState`. The variable holds the [Websocket ready state constant](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#Ready_state_constants):

| Constant     | Value | Description                                      |
|--------------|-------|--------------------------------------------------|
| `CONNECTING` | 0     | The connection is not yet open.                  |
| `OPEN`       | 1     | The connection is open and ready to communicate. |
| `CLOSING`    | 2     | The connection is in the process of closing.     |
| `CLOSED`     | 3     | The connection is closed or couldn't be opened.  |

Listening for disconnects and reconnects can be dong using the two events `disconnect` and `reconnect`. `reconnect` does not trigger on the initial connection, but only followed by a `disconnect`. For the initial connection, the `loaded` event should be used.

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
  "providers": {
    "github": {
      "node_module": "passport-github",
      "config": {
        "clientID": "<github client id>",
        "clientSecret": "<github secret>",
        "callbackURL": "http://<hostname>/auth/github/callback"
      }
    }
  }
}
```

Access rights are added to a webstrate as a `data-auth` attribute on the `<html>` tag:

```html
<html data-auth="[{"username": "cklokmose", "provider": "github", "permissions": "rw"},
  {"username": "anonymous", "provider": "", "permissions": "r"}]">
...
</html>
```

The above example provides the user with GitHub username *cklokmose* permissions to read and write (`rw`), while anonymous users only have read `r` access.

Users can log in by accessing `http://<hostname>/auth/github`.

In the future, more authentication providers will be supported.

#### Default permissions

It is also possible to set default permissions. Adding the following under the `auth` section in `config.json` will apply the same permissions as above to all webstrates without a `data-auth` property.

```javascript
"defaultPermissions": [
  {"username": "cklokmose", "provider": "github", "permissions": "rw"}
  {"username": "anonymous", "provider": "", "permissions": "r"}
]
```

#### Accessing permissions in a webstrate

The user's permissions (defined by `data-auth` or default permissions) is accessible on `webstrate.user.permissions`. Calling `webstrate.user.permissions` as *cklokmose*, for instance, will return `rw`.

Listening for changes to the user's permissions can be done using the `permissionsChanged` event:

```javascript
webstrate.on("permissionsChanged", function(newPermissions, oldPermissions) {
  // Permissions have changed.
});
```

### A note on Quirks Mode and Standards Mode

Previous versions of Webstrates have run in [Quirks Mode](http://www.quirksmode.org/css/quirksmode.html). However, the current version ships with "strict mode". The user is encouraged to conform to the standard, but if quirks mode is required (for compliance with legacy code), the line including the doctype (`<!doctype html>`) can be removed from the top of file`static/client.html`.

Disclaimer
==========
Webstrates is a work-in-progress and the mapping between the DOM and the ShareDB document may not be perfect.
After each set of DOM manipulations, Webstrates checks the integrity of the mapping between the DOM and the ShareDB document, and may throw an exception if something is off. If this happens, just reload the page.

License
=======
This work is licenced under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).
