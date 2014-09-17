$(document).ready () =>
    sharejsDoc = window.location.pathname[1..window.location.pathname.length]
    document.title = "Webstrate - " + sharejsDoc
    if sharejsDoc.length == 0
        throw "Error: No document id provided"
    
    socket = new BCSocket null, {reconnect: true}
    window._sjs = new sharejs.Connection socket
    
    doc = _sjs.get 'docs', sharejsDoc 
    
    doc.subscribe()
    doc.whenReady () ->
        window.dom2shareInstance = new DOM2Share doc, $('body').get(0), () ->
            event = new CustomEvent "loaded", { "detail": "The share.js document has finished loading" }
            document.dispatchEvent event