// This wrapper is necessary for the coreDOM module to function. We pass in a variable named
// document that replaces  the regular document object with a proxied document. This proxy allows
// coreDOM to override property on the document internally, thus allowing other modules to change
// the behaviour of `document.createElement` internally, for instance.
const documentProxyObj = {};
const documentProxy = new Proxy(document, documentProxyObj);

(function(document, _document, documentProxyObj) {
/* Here, all the webpacked webstrate client code goes.
})(documentProxy, document, documentProxyObj);
And then it gets closed by the above line (found in wrapper-footer.js). */
