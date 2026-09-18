// This wrapper is necessary for the coreDOM module to function. We pass in a variable named
// document that replaces  the regular document object with a proxied document. This proxy allows
// coreDOM to override property on the document internally, thus allowing other modules to change
// the behaviour of `document.createElement` internally, for instance.
// A default get trap is installed up front (coreDOM replaces it with its own once it loads):
// with an empty handler, native prototype getters on document (e.g. document.baseURI,
// document.currentScript) would be invoked with the proxy as their receiver and throw
// "Illegal invocation". Runtime code bundled before coreDOM loads (webpack's asset URL
// resolution) needs those getters to work.
const documentProxyObj = {
	get: (obj, prop) => {
		if (prop === 'PROXY_DOCUMENT') return true;
		return typeof obj[prop] === 'function' ? obj[prop].bind(obj) : obj[prop];
	}
};
const documentProxy = new Proxy(document, documentProxyObj);

(function(document, _document, documentProxyObj) {
/* Here, all the webpacked webstrate client code goes.
})(documentProxy, document, documentProxyObj);
And then it gets closed by the above line (found in wrapper-footer.js). */
