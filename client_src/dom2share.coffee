root = exports ? window

class root.DOM2Share
    
    constructor: (@doc, @targetDiv, callback = ->) ->
        if not @doc.type
            console.log "Creating new doc", @doc.name
            @doc.create 'json0'
        if @doc.type.name != 'json0'
            console.log "WRONG TYPE"
            return
        if not @doc.getSnapshot()
            body = ["div",{id:"doc_"+@doc.name, class:"document"}]
            @doc.submitOp([{"p":[], "oi":body}])
        @loadDocIntoDOM()
        callback @doc, @rootDiv
        
    loadDocIntoDOM: () ->
        @targetDiv.appendChild($.jqml(@doc.getSnapshot())[0])
    
        @rootDiv = $(@targetDiv).children()[0]
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
        if !@doc?
            return
        idmap = []
        reparented = {}
        removed = []
        for mutation in mutations
            if mutation.type == "attributes"
                path = util.getJsonMLPathFromPathNode util.getPathNode(mutation.target)
                path.push 1
                path.push mutation.attributeName
                value = $(mutation.target).attr(mutation.attributeName)
                if not value?
                    value = ""
                op = {p:path, oi:value}
                @context.submitOp op
            else if mutation.type == "characterData"
                changedPath = util.getJsonMLPathFromPathNode util.getPathNode(mutation.target)
                oldText = mutation.oldValue
                newText = mutation.target.data
                if util.elementAtPath(@context.getSnapshot(), changedPath) != oldText
                    #This should not happen (but will if a text node is inserted and then the text is altered right after)
                    continue
                op = util.patch_to_ot changedPath, @dmp.patch_make(oldText, newText)
                @context.submitOp op
            else if mutation.type == "childList"
                for added in mutation.addedNodes
                    if added.__pathNodes? and added.__pathNodes.length > 0
                        addedPathNode = util.getPathNode(added, mutation.target)
                        targetPathNode = util.getPathNode(mutation.target)
                        if targetPathNode.id == addedPathNode.parent.id
                            continue    
                    #add to pathTree
                    newPathNode = util.createPathTree added, util.getPathNode(mutation.target)
                    targetPathNode = util.getPathNode(mutation.target)
                    if mutation.previousSibling?
                        siblingPathNode = util.getPathNode(mutation.previousSibling, mutation.target)
                        prevSiblingIndex = targetPathNode.children.indexOf siblingPathNode
                        targetPathNode.children = (targetPathNode.children[0..prevSiblingIndex].concat [newPathNode]).concat targetPathNode.children[prevSiblingIndex+1...targetPathNode.children.length]
                    else if mutation.nextSibling?
                        targetPathNode.children = [newPathNode].concat targetPathNode.children
                    else
                        targetPathNode.children.push newPathNode
                    insertPath = util.getJsonMLPathFromPathNode util.getPathNode(added, mutation.target)
                    op = {p:insertPath, li:JsonML.parseDOM(added, null, false)}
                    @context.submitOp op
                for removed in mutation.removedNodes
                    pathNode = util.getPathNode(removed, mutation.target)
                    #if not pathNode?
                    #    continue
                    targetPathNode = util.getPathNode(mutation.target)
                    path = util.getJsonMLPathFromPathNode pathNode
                    element = util.elementAtPath(@context.getSnapshot(), path)
                    op = {p:path , ld:element}
                    @context.submitOp op
                    #Remove from pathTree
                    childIndex = targetPathNode.children.indexOf pathNode
                    targetPathNode.children.splice childIndex, 1
                    util.removePathNodes removed, targetPathNode
                
        util.check(@rootDiv, @pathTree)