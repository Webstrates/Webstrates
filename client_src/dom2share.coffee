root = exports ? window

elementAtPath = (doc, path) ->
    if path.length > 0 and typeof path[path.length-1] == 'string'
        return null
    if path.length == 0 
        return doc
    else
        return elementAtPath(doc[path[0]], path[1..path.length])
 
isSubpath = (path, paths) ->
    if not paths? or paths.length == 0
        return false
    return paths.map((p1) -> return p1.join()).map((p2) -> return path.join().substring(0, p2.length) == p2).reduce((a, b)  -> return a or b)

handleChanges = (changes) ->
    if !_doc?
        return
    idmap = []
    for change in changes
        if change.removed? and change.removed.length > 0
            #Sort removed with longest path first (to avoid removing elements where an ancestor is already removed)
            change.removed.sort (a, b) ->
                return $(b).jsonMLPath($(_rootDiv)).length - $(a).jsonMLPath($(_rootDiv)).length
            removedPaths = [] #Used to make sure that we don't try to remove elements twice
            for removed in change.removed
                if isSubpath(removed.__path, removedPaths)
                    continue
                removedElement = elementAtPath(_doc.snapshot, removed.__path)
                op = {p:removed.__path, ld:removedElement}
                oldParent = change.getOldParentNode(removed)
                root._context.submitOp op
                #Check if parent is also removed
                if change.removed.map((x) -> x.__mutation_summary_node_map_id__).indexOf(oldParent.__mutation_summary_node_map_id__) < 0
                    ot2dom.setPaths oldParent, $(_rootDiv)
                removedPaths.push removed.__path
        if change.attributeChanged?
            for attribute, element of change.attributeChanged
                path = $(element).jsonMLPath($(_rootDiv), attribute)
                op = {p:path, oi:$(element).attr(attribute)}
                root._context.submitOp op
        if change.added? and change.added.length > 0
            #Sort added with shortest path first (to avoid adding into something that isnt added yet)
            change.added.sort (a, b) ->
                return $(a).jsonMLPath($(_rootDiv)).length - $(b).jsonMLPath($(_rootDiv)).length
            for added in change.added
                addedPath = $(added).jsonMLPath($(_rootDiv))
                if addedPath.length == 0
                    break
                jsonMl = JsonML.parseDOM(added, null, true)
                op = {p:addedPath, li:jsonMl}
                console.log "Submitting op", op
                root._context.submitOp op
                parent = $(added).parent()
                ot2dom.setPaths parent, $(_rootDiv), added
        if change.characterDataChanged? and change.characterDataChanged.length > 0
            #TODO: Implement support for collaborative editing of the same text element using sharejs magic
            #console.log "Character data changed", change
            changed = change.characterDataChanged[0]
            changedPath = $(changed).jsonMLPath($(_rootDiv))
            oldText = elementAtPath(_doc.snapshot, changedPath)
            newText = changed.data
            if changedPath.length == 0
                break
            op = util.patch_to_ot changedPath, dmp.patch_make(oldText, newText)
            #if oldText? and not isSubpath(changedPath, removedPaths)
            #    op.push {p:changedPath, ld:oldText}
            #op.push {p:changedPath, li:newText}
            root._context.submitOp op
        if change.reordered? and change.reordered.length > 0
            for reordered in change.reordered
                newPath = $(reordered).jsonMLPath($(_rootDiv))
                oldPath = reordered.__path
                op = {p:oldPath, lm:newPath[newPath.length-1]}
                root._context.submitOp op
                parent = $(reordered).parent()[0]
                ot2dom.setPaths parent, $(_rootDiv)
        if change.reparented? and change.reparented.length > 0
            for reparented in change.reparented
                snapshot = _doc.snapshot
                previousSibling = change.getOldPreviousSibling(reparented)
                previousParent = change.getOldParentNode(reparented)
                if previousSibling?
                    oldPath = previousSibling.__path.slice(0)
                    oldPath[oldPath.length-1] = oldPath[oldPath.length-1]+1
                else
                    oldPath = change.getOldParentNode(reparented).__path.slice(0)
                    oldPath.push 2
                newPath = $(reparented).jsonMLPath($(_rootDiv))
                reparentedElement = JsonML.parseDOM(reparented, null)
                op = [{p:newPath, li:reparentedElement}]
                #Check if oldPath is on a path that already has been deleted
                if not isSubpath(oldPath, removedPaths)
                    #Special cases if new path changes something on the old path
                    #Case 1: Element is reparented onto old path
                    if oldPath.length > newPath.length and oldPath[0..newPath.length-1].join() == newPath.join()
                        oldPath[newPath.length-1] = oldPath[newPath.length-1] + 1
                    #Case 2: Element is reparented into element at the endpoint of oldpath (ie element must have been replaces as you cannot reparent into your self)
                    else if oldPath.length < newPath.length and newPath[0..oldPath.length-1].join() == oldPath.join()
                        oldPath[oldPath.length-1] = oldPath[oldPath.length-1] + 1
                    op.push {p:oldPath, ld:reparentedElement}
                #Check if oldPath is on a path that already has been deleted
                oldParent = change.getOldParentNode(reparented)
                newParent = $(reparented).parent()[0]
                root._context.submitOp op
                ot2dom.setPaths oldParent, $(_rootDiv)
                ot2dom.setPaths newParent, $(_rootDiv)

loadDocIntoDOM = (doc, targetDiv) ->
    root._doc = doc
    targetDiv.appendChild($.jqml(doc.getSnapshot())[0])
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    ot2dom.setPaths _rootDiv, _rootDiv
    
    root.dmp = new diff_match_patch()

    root._context = doc.createContext()
    root._context._onOp = (ops) =>
        console.log "Received op", ops
        _observer.disconnect()
        for op in ops
            ot2dom.applyOp op _rootDiv
        
        _observer.reconnect()

    root._observer = new MutationSummary {
      oldPreviousSibling: true,
      callback: handleChanges, 
      rootNode: targetDiv,
      queries: [{ all: true }]
    }
    
    return rootDiv

openDoc = (docName, targetDiv, callback = ->) ->
    socket = new BCSocket null, {reconnect: true}
    sjs = new sharejs.Connection socket
    
    doc = sjs.get 'docs', docName
    
    doc.subscribe()
    
    doc.whenReady () ->
        if not doc.type
            console.log "Creating new doc", docName
            doc.create 'json0'
            console.log doc.type
        if doc.type.name != 'json0'
            console.log "WRONG TYPE"
            return
        if not doc.getSnapshot()
            body = ["div",{id:"doc_"+docName, class:"document"}]
            doc.submitOp([{"p":[], "oi":body}])
        rootDiv = loadDocIntoDOM doc, targetDiv
        callback null, doc, rootDiv

closeDoc = () ->
    root._observer.disconnect()
    root._observer= null
    root._doc.del()
    root._doc.destroy()

root.openDoc = openDoc
root.closeDoc = closeDoc