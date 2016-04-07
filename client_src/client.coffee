###
Copyright 2016 Clemens Nylandsted Klokmose, Aarhus University

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
###

$(document).ready () =>
    # Get the ID of the webstrate from the location
    webstrate = window.location.pathname[1..window.location.pathname.length]
    document.title = "Webstrate - " + webstrate
    if webstrate.length == 0
        throw "Error: No webstrate id provided"

    # Establish a websocket connection to the server
    wshost = 'ws://' + window.location.host + '/ws/'
    ws = new ReconnectingWebSocket wshost

    # Hand the websocket over to ShareJS
    window._sjs = new sharejs.Connection ws

    # Get the ShareJS doc representing the webstrate
    doc = _sjs.get 'webstrates', webstrate

    # Subscribe to remote operations
    doc.subscribe()

    # After half a second show that we are loading for the impatient.
    ready = false
    setTimeout (() ->
        if not ready
            $('body').append("Loading...")),
        500

    # Setup a callback for ShareJS having finished loading the doc
    doc.whenReady () ->
        # When ready first empty the current DOM completely
        $(document).empty()
        ready = true
        # Setup a mapping between the ShareJS document and the DOM
        window.dom2shareInstance = new DOM2Share doc, document, () ->
            # When everything is setup trigger a loaded event on the document
            document.dispatchEvent(new CustomEvent "loaded")
            window.loaded = true
            if parent == window
                return
            # Tell the outer window that loading is finished (e.g. if embedded in an iFrame)
            parent.postMessage "loaded", '*' 
            referrerDomain = util.extractDomain document.referrer
            domain = util.extractDomain location.href
            # If we are in an iframe and the referrer domain and this domain does not match, we assume the parent frame is from a different domain and we return to not violate cross-domain restrictions on iframes
            if referrerDomain != domain 
                return
            # If webstrate is transcluded in an iFrame raise an event on the frame element in the parent doc
            if window.frameElement? 
                event = new CustomEvent "transcluded", {detail: {name: webstrate}, bubbles: true, cancelable: true}
                window.frameElement.dispatchEvent event
            
