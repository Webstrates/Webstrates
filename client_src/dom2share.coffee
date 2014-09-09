root = exports ? window

elementAtPath = (doc, path) ->
    console.log "DOC", doc, path
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

handleMutations = (mutations) ->
    if !_doc?
        return
    idmap = []
    for mutation in mutations
        console.log mutation
        if mutation.type == "attributes"
            path = mutation.target.__path
            path.push mutation.attributeName
            op = {p:path, oi:$(mutation.target).attr(mutation.attributeName)}
            root._context.submitOp op
        else if mutation.type == "characterData"
            changedPath = mutation.target.__path
            console.log "Changed Path", changedPath
            oldText = mutation.oldValue
            newText = mutation.target.data
            #op = util.patch_to_ot changedPath, dmp.patch_make(oldText, newText)
            #console.log "CharacterData", op
            op = {p:changedPath, ld:elementAtPath(_doc.snapshot, changedPath), li:newText}
            root._context.submitOp op
        else if mutation.type == "childList"
            for added in mutation.addedNodes
                root._context.submitOp {p:$(added).jsonMLPath($(_rootDiv)), li:JsonML.parseDOM(added, null, false)}
                parent = $(added).parent()
                ot2dom.setPaths parent, $(_rootDiv), added
            for removed in mutation.removedNodes
                op = {p:removed.__path, ld:elementAtPath(_doc.snapshot, removed.__path)}
                root._context.submitOp op
                ot2dom.setPaths mutation.target, $(_rootDiv)

loadDocIntoDOM = (doc, targetDiv) ->
    root._doc = doc
    targetDiv.appendChild($.jqml(doc.getSnapshot())[0])
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    ot2dom.setPaths _rootDiv, _rootDiv
    
    root.dmp = new diff_match_patch()

    root._context = doc.createContext()
    root._context._onOp = (ops) =>
        _observer.disconnect()
        for op in ops
            ot2dom.applyOp op, _rootDiv
        
        _observer.reconnect()
    
    root._observer = new MutationObserver handleMutations
    root._observer.observe root._rootDiv, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }
    
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
            body = ["div",{id:"doc_"+docName, class:"document", 'data-uuid': root.util.generateUUID()}]
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
root.elementAtPath = elementAtPath