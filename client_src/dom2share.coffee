root = exports ? window

elementAtPath = (doc, path) ->
    if path.length > 0 and typeof path[path.length-1] == 'string'
        console.log 1
        return null
    if path.length == 0 
        console.log 2, doc
        return doc
    else
        console.log 3, doc
        return elementAtPath(doc[path[0]], path[1..path.length])
 
populateNodeMap = (map, elem, root, stop = null) ->
    if elem instanceof jQuery
        elem = elem[0]
    jsonPath = $(elem).jsonMLPath($(root))
    map.set(elem, jsonPath)
    console.log "Setting", elem, jsonPath
    if stop? and elem.isEqualNode(stop)
        return
    if elem.tagName == 'IFRAME'
        return
    for child in $(elem).contents()
        populateNodeMap map, child, root, stop
        
cleanNodeMap = (map, elem) ->
    if elem instanceof jQuery
        elem = elem[0]
    map.delete elem
    if elem.tagName == 'IFRAME'
        return
    for child in $(elem).contents()
        cleanNodeMap map, child
    
setAttribute = (element, path, value) ->
    if path.length > 1
        setAttribute element.contents().eq(path[0]), path[1..path.length], value
    else
        element.attr(path[0], value)

insert = (element, path, value, map) ->
    if path.length > 1
        insert element.contents().eq(path[0]), path[1..path.length], value, map
    if path.length == 1
        if typeof value == 'string'
            html = $(document.createTextNode(value))
        else
            html = $.jqml(value)
        sibling = element.contents().eq(path[0])
        if sibling.length > 0
            html.insertBefore(element.contents().eq(path[0]))
        else element.append(html)
        cleanNodeMap(map, element.get(0))
        populateNodeMap(map, element.get(0), _rootDiv)
        
deleteNode = (element, path, map) ->
    if path.length > 1
        deleteNode element.contents().eq(path[0]), path[1..path.length], map
    if path.length == 1
        toRemove = element.contents().eq(path[0])
        cleanNodeMap(map, toRemove.get(0))
        toRemove.remove()
        
reorder = (element, path, index, map) ->
    if path.length > 1
        reorder element.contents().eq(path[0]), path[1..path.length], index, map
    if path.length == 1
        toMove = element.contents().eq(path[0])
        target = element.contents().eq(index)
        if (index < path[0])
            toMove.insertBefore(target)
        else
            toMove.insertAfter(target)
        cleanNodeMap(map, element.get(0))
        populateNodeMap(map, element.get(0), _rootDiv)

addChildrenToIdMap = (element, idmap) ->
    for child in element.childNodes
        idmap.push child.__mutation_summary_node_map_id__
        addChildrenToIdMap(child, idmap)

handleChanges = (changes) ->
    console.log changes
    if !_doc?
        return
    idmap = []
    for change in changes
        if change.attributeChanged?
            for attribute, element of change.attributeChanged
                path = $(element).jsonMLPath($(_rootDiv), attribute)
                op = {p:path, oi:$(element).attr(attribute)}
                root._context.submitOp op, (error, rev) ->
                    if error
                        console.log error
        if change.characterDataChanged? and change.characterDataChanged.length > 0
            #TODO: Implement support for collaborative editing of the same text element using sharejs magic
            changed = change.characterDataChanged[0]
            changedPath = $(changed).jsonMLPath($(_rootDiv))
            oldText = elementAtPath(_doc.snapshot, changedPath)
            newText = changed.data
            if changedPath.length == 0
                break
            op = [{p:changedPath, ld:oldText}, {p:changedPath, li:newText}]
            try
                root._context.submitOp op, (error, rev) ->
                    if error
                        console.log error
            catch e
                console.log e
        
        if change.added? and change.added.length > 0
            for added in change.added
                #if idmap.indexOf(added.__mutation_summary_node_map_id__) > -1
                #    continue
                if added.nodeType == 3
                    index = $(added).index()
                    parent = $(added).parent()
                    $(added).replaceWith('<span>'+added.nodeValue+'</span>')
                    added = parent.children(index)[0]
                addChildrenToIdMap(added, idmap)
                addedPath = $(added).jsonMLPath($(_rootDiv))
                if addedPath.length == 0
                    break
                jsonMl = JsonML.parseDOM(added, null, true)
                op = {p:addedPath, li:jsonMl}
                console.log op
                try
                    root._context.submitOp op, (error, rev) ->
                        if error
                            console.log error
                catch e
                    console.log e
                parent = $(added).parent()
                cleanNodeMap _nodeMap, parent
                populateNodeMap _nodeMap, parent, $(_rootDiv), added
        if change.removed? and change.removed.length > 0
            for removed in change.removed
                #if idmap.indexOf(removed.__mutation_summary_node_map_id__) > -1
                #    continue
                addChildrenToIdMap(removed, idmap)
                path = _nodeMap.get(removed)
                op = {p:path, ld:elementAtPath(_doc.snapshot, path)}
                oldParent = change.getOldParentNode(removed)
                root._context.submitOp op, (error, rev) ->
                    if error
                        console.log error
                cleanNodeMap _nodeMap, oldParent
        if change.reordered? and change.reordered.length > 0
            for reordered in change.reordered
                #if idmap.indexOf(reordered.__mutation_summary_node_map_id__) > -1
                #    continue
                addChildrenToIdMap(reordered, idmap)
                newPath = $(reordered).jsonMLPath($(_rootDiv))
                oldPath = _nodeMap.get(reordered)
                op = {p:oldPath, lm:newPath[newPath.length-1]}
                root._context.submitOp op, (error, rev) ->
                    if error
                        console.log error
                parent = $(reordered).parent()[0]
                cleanNodeMap _nodeMap, parent
                populateNodeMap _nodeMap, parent, $(_rootDiv)
        if change.reparented? and change.reparented.length > 0
            for reparented in change.reparented
                #if idmap.indexOf(reparented.__mutation_summary_node_map_id__) > -1
                #    path = _nodeMap.get(reparented)
                #    op = {p:path, ld:elementAtPath(_doc.snapshot, path)} #This doesn't work
                #    oldParent = change.getOldParentNode(reparented)
                #    root._context.submitOp op, (error, rev) ->
                #        if error
                #            console.log error
                #    cleanNodeMap _nodeMap, oldParent
                #    populateNodeMap _nodeMap, oldParent, $(_rootDiv)
                #    continue
                #addChildrenToIdMap(reparented, idmap)
                newPath = $(reparented).jsonMLPath($(_rootDiv))
                oldPath = _nodeMap.get(reparented)
                element = elementAtPath(_doc.snapshot, oldPath)
                #op = [{p:oldPath, ld:reparented}, {p:newPath, li:element}]
                newParent = $(reparented).parent()[0]
                oldParent = change.getOldParentNode(reparented)
                root._context.submitOp op, (error, rev) ->
                    if error
                        console.log error
                cleanNodeMap _nodeMap, reparented
                populateNodeMap _nodeMap, reparented, $(_rootDiv)

loadDoc = (doc, targetDiv) ->
    root._nodeMap = new MutationSummary.NodeMap()
    root._doc = doc
    $(targetDiv).append($.jqml(doc.getSnapshot()))
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    populateNodeMap _nodeMap, _rootDiv, _rootDiv

    root._context = doc.createContext()
    root._context._onOp = (ops) =>
        console.log "Received ops", ops
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
                    insert $(_rootDiv), htmlPath, op.li, _nodeMap
            if op.ld? #list deletion
                if not attributePath
                    deleteNode $(_rootDiv), htmlPath, _nodeMap
            if op.lm? #list rearrangement
                if not attributePath
                    reorder $(_rootDiv), htmlPath, op.lm-2, _nodeMap
        
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