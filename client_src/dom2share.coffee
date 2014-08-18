root = exports ? window

elementAtPath = (doc, path) ->
    if path.length > 0 and typeof path[path.length-1] == 'string'
        return null
    if path.length == 0 
        return doc
    else
        return elementAtPath(doc[path[0]], path[1..path.length])
 
setPaths = (elem, root, stop = null) ->
    if elem instanceof jQuery
        elem = elem[0]
    jsonPath = $(elem).jsonMLPath($(root))
    elem.__path = jsonPath
    if stop? and elem.isEqualNode(stop)
        return
    if elem.tagName == 'IFRAME'
        return
    for child in $(elem).contents()
        setPaths child, root, stop
        
setAttribute = (element, path, value) ->
    if path.length > 1
        setAttribute element.contents().eq(path[0]), path[1..path.length], value
    else
        element.attr(path[0], value)

insert = (element, relativePath, actualPath, value) ->
    if relativePath.length > 1
        insert element.contents().eq(relativePath[0]), relativePath[1..relativePath.length], actualPath, value
    if relativePath.length == 1
        if typeof value == 'string'
            html = $(document.createTextNode(value))
        else
            html = $.jqml(value)
        html.__path = actualPath
        sibling = element.contents().eq(relativePath[0])
        if sibling.length > 0
            html.insertBefore(element.contents().eq(relativePath[0]))
        else element.append(html)
        setPaths element.get(0), _rootDiv
        
deleteNode = (element, path) ->
    if path.length > 1
        deleteNode element.contents().eq(path[0]), path[1..path.length]
    if path.length == 1
        toRemove = element.contents().eq(path[0])
        toRemove.remove()
        
reorder = (element, path, index) ->
    if path.length > 1
        reorder element.contents().eq(path[0]), path[1..path.length], index
    if path.length == 1
        toMove = element.contents().eq(path[0])
        target = element.contents().eq(index)
        if (index < path[0])
            toMove.insertBefore(target)
        else
            toMove.insertAfter(target)
        setPaths element.get(0), _rootDiv

addChildrenToIdMap = (element, idmap) ->
    for child in element.childNodes
        idmap.push child.__mutation_summary_node_map_id__
        addChildrenToIdMap(child, idmap)

handleChanges = (changes) ->
    if !_doc?
        return
    idmap = []
    for change in changes
        if change.attributeChanged?
            for attribute, element of change.attributeChanged
                path = $(element).jsonMLPath($(_rootDiv), attribute)
                op = {p:path, oi:$(element).attr(attribute)}
                root._context.submitOp op
        if change.characterDataChanged? and change.characterDataChanged.length > 0
            #TODO: Implement support for collaborative editing of the same text element using sharejs magic
            changed = change.characterDataChanged[0]
            changedPath = $(changed).jsonMLPath($(_rootDiv))
            oldText = elementAtPath(_doc.snapshot, changedPath)
            newText = changed.data
            if changedPath.length == 0
                break
            op = [{p:changedPath, ld:oldText}, {p:changedPath, li:newText}]
            root._context.submitOp op
        if change.added? and change.added.length > 0
            for added in change.added
                addedPath = $(added).jsonMLPath($(_rootDiv))
                if addedPath.length == 0
                    break
                jsonMl = JsonML.parseDOM(added, null, true)
                op = {p:addedPath, li:jsonMl}
                root._context.submitOp op
                parent = $(added).parent()
                setPaths parent, $(_rootDiv), added
        if change.removed? and change.removed.length > 0
            for removed in change.removed
                path = removed.__path
                op = {p:path, ld:elementAtPath(_doc.snapshot, path)}
                oldParent = change.getOldParentNode(removed)
                root._context.submitOp op
                setPaths oldParent , $(_rootDiv), added
        if change.reordered? and change.reordered.length > 0
            for reordered in change.reordered
                newPath = $(reordered).jsonMLPath($(_rootDiv))
                oldPath = reordered.__path
                op = {p:oldPath, lm:newPath[newPath.length-1]}
                root._context.submitOp op
                parent = $(reordered).parent()[0]
                setPaths parent, $(_rootDiv)
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
                #Special cases if new path changes something on the old path
                #Case 1: Element is reparented onto old path
                if oldPath.length > newPath.length and oldPath[0..newPath.length-1].join() == newPath.join()
                    oldPath[newPath.length-1] = oldPath[newPath.length-1] + 1
                #Case 2: Element is reparented into element at the endpoint of oldpath (ie element must have been replaces as you cannot reparent into your self)
                else if oldPath.length < newPath.length and newPath[0..oldPath.length-1].join() == oldPath.join()
                    oldPath[oldPath.length-1] = oldPath[oldPath.length-1] + 1
                reparentedElement = JsonML.parseDOM(reparented, null)
                
                op = [{p:newPath, li:reparentedElement}, {p:oldPath, ld:reparentedElement}]
                oldParent = change.getOldParentNode(reparented)
                newParent = $(reparented).parent()[0]
                root._context.submitOp op
                setPaths oldParent, $(_rootDiv)
                setPaths newParent, $(_rootDiv)

loadDoc = (doc, targetDiv) ->
    root._doc = doc
    $(targetDiv).append($.jqml(doc.getSnapshot()))
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    setPaths _rootDiv, _rootDiv

    root._context = doc.createContext()
    root._context._onOp = (ops) =>
        _observer.disconnect()
        for op in ops
            path = op.p
            htmlPath = []
            attributePath = false
            #TODO: Refactor and document code below
            if path.length > 0
                if typeof path[path.length-1] == 'string' #attribute change
                    attributePath = true
                    if path.length > 2
                        for index in op.p[0..path.length-3]
                            htmlPath.push index-2
                        htmlPath.push path[path.length-1]
                    else
                        htmlPath.push(path[1])
                else
                    for index in op.p
                        htmlPath.push index-2
            if op.oi? #object insertion
                if attributePath
                    setAttribute $(_rootDiv), htmlPath, op.oi
            if op.li? #list insertion
                if not attributePath
                    insert $(_rootDiv), htmlPath, htmlPath, op.li
            if op.ld? #list deletion
                if not attributePath
                    deleteNode $(_rootDiv), htmlPath
            if op.lm? #list rearrangement
                if not attributePath
                    reorder $(_rootDiv), htmlPath, op.lm-2
        
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
        rootDiv = loadDoc doc, targetDiv
        callback null, doc, rootDiv

closeDoc = () ->
    root._observer.disconnect()
    root._observer= null
    root._doc.del()
    root._doc.destroy()

root.openDoc = openDoc
root.closeDoc = closeDoc