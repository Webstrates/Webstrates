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
    
check = (domNode, pathNode) ->
    if domNode.__pathNode.id != pathNode.id
        console.log domNode, pathNode
        throw "No id match"
    if domNode.childNodes.length != pathNode.children.length
        console.log domNode, pathNode
        throw "Different amount of children"
    for i in [0...domNode.childNodes.length]
        check(domNode.childNodes[i], pathNode.children[i])

handleMutations = (mutations) ->
    if !_doc?
        return
    idmap = []
    for mutation in mutations
        if mutation.type == "attributes"
            path = util.getJsonMLPathFromPathNode mutation.target.__pathNode
            path.push 1
            path.push mutation.attributeName
            op = {p:path, oi:$(mutation.target).attr(mutation.attributeName)}
            root._context.submitOp op
        else if mutation.type == "characterData"
            changedPath = util.getJsonMLPathFromPathNode mutation.target.__pathNode
            oldText = mutation.oldValue
            newText = mutation.target.data
            op = util.patch_to_ot changedPath, dmp.patch_make(oldText, newText)
            #console.log "CharacterData", op
            if elementAtPath(_doc.getSnapshot(), changedPath) != oldText
                #A fluke?
                continue
            #op = {p:changedPath, ld:elementAtPath(_doc.getSnapshot(), changedPath), li:newText}
            root._context.submitOp op
        else if mutation.type == "childList"
            for added in mutation.addedNodes
                if added.__pathNode?
                    continue
                #add to pathTree
                if mutation.previousSibling?
                    siblingPathNode = mutation.previousSibling.__pathNode
                    prevSiblingIndex = mutation.target.__pathNode.children.indexOf siblingPathNode
                    newPathNode = util.createPathTree added, mutation.target.__pathNode
                    mutation.target.__pathNode.children = (mutation.target.__pathNode.children[0..prevSiblingIndex].concat [newPathNode]).concat mutation.target.__pathNode.children[prevSiblingIndex+1...mutation.target.__pathNode.children.length]
                else
                    newPathNode = util.createPathTree added, mutation.target.__pathNode
                    mutation.target.__pathNode.children = [newPathNode].concat mutation.target.__pathNode.children
                insertPath = util.getJsonMLPathFromPathNode added.__pathNode
                root._context.submitOp {p:insertPath, li:JsonML.parseDOM(added, null, false)}
            for removed in mutation.removedNodes
                path = util.getJsonMLPathFromPathNode removed.__pathNode
                op = {p:path , ld:elementAtPath(_doc.getSnapshot(), path)}
                root._context.submitOp op
                #Remove from pathTree
                childIndex = mutation.target.__pathNode.children.indexOf removed.__pathNode
                mutation.target.__pathNode.children.splice childIndex, 1
    check(_rootDiv, pathTree)

loadDocIntoDOM = (doc, targetDiv) ->
    root._doc = doc
    targetDiv.appendChild($.jqml(doc.getSnapshot())[0])
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    #ot2dom.setPaths _rootDiv, _rootDiv
    root.pathTree = util.createPathTree _rootDiv
    
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
root.elementAtPath = elementAtPath
root.check = check