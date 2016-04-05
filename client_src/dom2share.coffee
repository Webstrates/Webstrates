###
Copyright 2014 Clemens Nylandsted Klokmose, Aarhus University

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

root = exports ? window

# This class creates a two way mapping between a DOM element and a ShareJS document
class root.DOM2Share

    # @doc: The ShareJS document
    # @targetDOMElement: The DOM element
    # callback: Called when setup is completed
    constructor: (@doc, @targetDOMElement, callback = ->) ->
        if not @doc.type
            # The doc does not exist on the server so we create one
            console.log "Creating new doc", @doc.name
            @doc.create 'json0'
        if @doc.type.name != 'json0'
            # The doc is not a json document
            console.log "WRONG TYPE"
            return
        if @targetDOMElement.parentNode?
            # Its not the document root
            if not @doc.getSnapshot()
                # If the document is empty we crate some data
                body = ["div",{id:"doc_"+@doc.name, class:"document"}]
                @doc.submitOp([{"p":[], "oi":body}])
        else
            # Its the document root
            if not @doc.getSnapshot()
                # If the document is empty we create some data
                body = ["html", {}, ['body', {}]]
                @doc.submitOp([{"p":[], "oi":body}])
        @loadDocIntoDOM()
        callback @doc, @rootElement
        
    loadDocIntoDOM: () ->
        # Take the data snapshot from the doc object, convert it from JsonML to HTML and append it to the target DOM element
        @targetDOMElement.appendChild($.jqml(@doc.getSnapshot())[0])
        
        @rootElement = $(@targetDOMElement).children()[0]

        # Create an path tree object
        # The path tree is used to compute absolute paths to DOM nodes when a mutation is observed in the DOM 
        @pathTree = util.createPathTree @rootElement, null, true

        # Initialize a diff_match_patch object used to diff strings
        @dmp = new diff_match_patch()

        # Setup a ShareJS editing context
        @context = @doc.createContext()

        # Setup a callback when a remote operation is received on the ShareJS document
        @context._onOp = (ops) =>
            #Disconnect the mutation observer while we process the operation
            @observer.disconnect()
            for op in ops
                ot2dom.applyOp op, @rootElement
            # Make an integrity check of the DOM
            util.check(@rootElement, @pathTree)
            # Reconnect the mutation observer
            @observer.observe @rootElement, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }

        # Setup the mutation observer and its callback
        @observer = new MutationObserver (mutations) => @handleMutations(mutations)
        # Make it observe everything that happens on the root element and its children
        @observer.observe @rootElement, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }

    # On a disconnect from the server disconnect the mutation observer and destroy the editing context
    disconnect: () ->
        @observer.disconnect()
        @context.destroy()

    # The callback function for the mutation observer
    handleMutations: (mutations) ->
        if not @doc?
            # The doc has not been setup yet?
            return
        for mutation in mutations
            # Get the path node of the target node of the mutation
            targetPathNode = util.getPathNode(mutation.target)
            if not targetPathNode?
                continue
            # Handle changes to an attribute
            if mutation.type == "attributes"
                # Get the JsonML path of the target node
                path = util.getJsonMLPathFromPathNode targetPathNode
                # Add the index of the attributes object
                path.push 1
                # Add the key of the attribute
                # Example the path of the attr foo in <html><div foo="bar"/></html> would be [0, 2, "foo"]
                # because the equivalent JsonML is ['html', {}, ['div', {"foo": "bar"}]]
                path.push mutation.attributeName
                # Get the value of the changed attribute
                value = $(mutation.target).attr(mutation.attributeName)
                if not value?
                    value = ""
                # Create the operation with the path and an object insertion
                # TODO: implement using a diff with the old value as with characterData
                op = {p:path, oi:value}
                try
                    # Submit the operation
                    @context.submitOp op
                catch error
                    window.alert "Webstrates has encountered an error. Please reload the page."
                    throw error
            # Handle a change to character data that is changes to a text node
            else if mutation.type == "characterData"
                # Check if we are dealing with a comment
                isComment = mutation.target.nodeType == 8
                # Get the changed path
                changedPath = util.getJsonMLPathFromPathNode targetPathNode
                # Get the new and the old value
                oldText = mutation.oldValue
                newText = mutation.target.data
                if !isComment and util.elementAtPath(@context.getSnapshot(), changedPath) != oldText
                    #This should not happen (but will if a text node is inserted and then the text is altered right after)
                    continue
                # Create a patch from the new and the old text and convert it to an operation
                op = util.patch_to_ot changedPath, @dmp.patch_make(oldText, newText)
                # Update the path of the op with an extra element, as the target element is ["!", "some comment"] rather than ["some text"]
                if isComment 
                    p = op[0].p
                    op[0].p = p[0...p.length-1].concat([1]).concat([p[p.length-1]])
                try
                    @context.submitOp op
                catch error
                    window.alert "Webstrates has encountered an error. Please reload the page."
                    throw error
            # Handle a change to the child list of a node
            else if mutation.type == "childList"
                # Get the previous sibling of the inserted node
                # The previous sibling is the node the new node is inserted right after in the parent child list
                previousSibling = mutation.previousSibling 
                # Handle added nodes
                for added in mutation.addedNodes
                    # Check if this node already has been added (e.g. together with its parent)
                    if added.__pathNodes? and added.__pathNodes.length > 0
                        addedPathNode = util.getPathNode(added, mutation.target)
                        if targetPathNode.id == addedPathNode.parent.id
                            continue    
                    # Add the new node to the path tree
                    newPathNode = util.createPathTree added, targetPathNode
                    # Check if the previousSibling is not null
                    if previousSibling?
                        # Update the child list of the target node in the path tree
                        # Set previous sibling to the inserted node (if there are more added nodes to the list)
                        siblingPathNode = util.getPathNode(previousSibling, mutation.target)
                        prevSiblingIndex = targetPathNode.children.indexOf siblingPathNode
                        targetPathNode.children = (targetPathNode.children[0..prevSiblingIndex].concat [newPathNode]).concat targetPathNode.children[prevSiblingIndex+1...targetPathNode.children.length]
                        previousSibling = added
                    # If the inserted node didn't have a previous sibling, check if it has a next sibling
                    else if mutation.nextSibling?
                        # Update the child list of the targtet path node in the path tree
                        targetPathNode.children = [newPathNode].concat targetPathNode.children
                    else
                        # The child list is empty
                        targetPathNode.children.push newPathNode
                    # Get the path the insertion from the updated path tree
                    insertPath = util.getJsonMLPathFromPathNode util.getPathNode(added, mutation.target)
                    # Create and submit the op
                    op = {p:insertPath, li:JsonML.fromHTML(added)}
                    try
                        @context.submitOp op
                    catch error
                        window.alert "Webstrates has encountered an error. Please reload the page."
                        throw error
                # Handle removed nodes
                for removed in mutation.removedNodes
                    # Get the removed node's pathnode
                    removedPathNode = util.getPathNode(removed, mutation.target)
                    if not removedPathNode?
                        continue
                    # Get the path and the JsonML for the element and generate an op
                    path = util.getJsonMLPathFromPathNode removedPathNode
                    element = util.elementAtPath(@context.getSnapshot(), path)
                    op = {p:path , ld:element}
                    try
                        @context.submitOp op
                    catch error
                        window.alert "Webstrates has encountered an error. Please reload the page."
                        throw error
                    # Remove the deleted node from the path tree
                    childIndex = removedPathNode.parent.children.indexOf removedPathNode
                    removedPathNode.parent.children.splice(childIndex, 1)
                    root.util.removePathNode removedPathNode
                
        util.check(@rootElement, @pathTree)
