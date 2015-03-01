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

class root.DOM2Share
    
    constructor: (@doc, @targetDOMElement, callback = ->) ->
        if not @doc.type
            console.log "Creating new doc", @doc.name
            @doc.create 'json0'
        if @doc.type.name != 'json0'
            console.log "WRONG TYPE"
            return
        if @targetDOMElement.parentNode? #Its not the document root
            if not @doc.getSnapshot()
                body = ["div",{id:"doc_"+@doc.name, class:"document"}]
                @doc.submitOp([{"p":[], "oi":body}])
        else #Its the document root
            if not @doc.getSnapshot()
                body = ["html", {}, ['body', {}]]
                @doc.submitOp([{"p":[], "oi":body}])
        @loadDocIntoDOM()
        callback @doc, @rootDiv
        
    loadDocIntoDOM: () ->
        @targetDOMElement.appendChild($.jqml(@doc.getSnapshot())[0])
    
        @rootDiv = $(@targetDOMElement).children()[0]
        @pathTree = util.createPathTree @rootDiv, null, true
    
        @dmp = new diff_match_patch()

        @context = @doc.createContext()
        @context._onOp = (ops) =>
            @observer.disconnect()
            for op in ops
                ot2dom.applyOp op, @rootDiv
            util.check(@rootDiv, @pathTree)
        
            @observer.observe @rootDiv, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }
        
        @observer = new MutationObserver (mutations) => @handleMutations(mutations)
        @observer.observe @rootDiv, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }
        
    disconnect: () ->
        @observer.disconnect()
        @context.destroy()
        
    handleMutations: (mutations) ->
        if not @doc?
            return
        for mutation in mutations
            targetPathNode = util.getPathNode(mutation.target)
            if not targetPathNode?
                continue
            if mutation.type == "attributes"
                path = util.getJsonMLPathFromPathNode targetPathNode
                path.push 1
                path.push mutation.attributeName
                value = $(mutation.target).attr(mutation.attributeName)
                if not value?
                    value = ""
                op = {p:path, oi:value}
                try
                    @context.submitOp op
                catch error
                    window.alert "Webstrates has encountered an error. Please reload the page."
                    throw error
            else if mutation.type == "characterData"
                changedPath = util.getJsonMLPathFromPathNode targetPathNode
                oldText = mutation.oldValue
                newText = mutation.target.data
                if util.elementAtPath(@context.getSnapshot(), changedPath) != oldText
                    #This should not happen (but will if a text node is inserted and then the text is altered right after)
                    continue
                op = util.patch_to_ot changedPath, @dmp.patch_make(oldText, newText)
                try
                    @context.submitOp op
                catch error
                    window.alert "Webstrates has encountered an error. Please reload the page."
                    throw error
            else if mutation.type == "childList"
                previousSibling = mutation.previousSibling
                for added in mutation.addedNodes
                    #Check if this node already has been added (e.g. together with its parent)
                    if added.__pathNodes? and added.__pathNodes.length > 0
                        addedPathNode = util.getPathNode(added, mutation.target)
                        if targetPathNode.id == addedPathNode.parent.id
                            continue    
                    #Add the new node to the path tree
                    newPathNode = util.createPathTree added, targetPathNode
                    if previousSibling?
                        siblingPathNode = util.getPathNode(previousSibling, mutation.target)
                        prevSiblingIndex = targetPathNode.children.indexOf siblingPathNode
                        targetPathNode.children = (targetPathNode.children[0..prevSiblingIndex].concat [newPathNode]).concat targetPathNode.children[prevSiblingIndex+1...targetPathNode.children.length]
                        previousSibling = added
                    else if mutation.nextSibling?
                        targetPathNode.children = [newPathNode].concat targetPathNode.children
                    else
                        targetPathNode.children.push newPathNode
                    insertPath = util.getJsonMLPathFromPathNode util.getPathNode(added, mutation.target)
                    op = {p:insertPath, li:JsonML.parseDOM(added, null, false)}
                    try
                        @context.submitOp op
                    catch error
                        window.alert "Webstrates has encountered an error. Please reload the page."
                        throw error
                for removed in mutation.removedNodes
                    removedPathNode = util.getPathNode(removed, mutation.target)
                    if not removedPathNode?
                        continue
                    path = util.getJsonMLPathFromPathNode removedPathNode
                    element = util.elementAtPath(@context.getSnapshot(), path)
                    op = {p:path , ld:element}
                    try
                        @context.submitOp op
                    catch error
                        window.alert "Webstrates has encountered an error. Please reload the page."
                        throw error
                    #Remove from pathTree
                    childIndex = removedPathNode.parent.children.indexOf removedPathNode
                    removedPathNode.parent.children.splice(childIndex, 1)
                    root.util.removePathNode removedPathNode
                
        util.check(@rootDiv, @pathTree)