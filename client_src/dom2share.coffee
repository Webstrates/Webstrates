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
    if domNode instanceof jQuery
        domNode = domNode[0]
    if domNode.__pathNode.id != pathNode.id
        console.log domNode, pathNode
        throw "No id match"
    if domNode.childNodes.length != pathNode.children.length
        console.log domNode, pathNode
        throw "Different amount of children"
    for i in [0...domNode.childNodes.length]
        check(domNode.childNodes[i], pathNode.children[i])

addPathNodes = (node, parent, mutationEvent, reparented) ->
    if node.__pathNode?
        oldPathNode = node.__pathNode
    pathNode = {id: util.generateUUID(), children: [], parent: parent, DOMNode: node}
    node.__pathNode = pathNode
    node.__mutationEvent = mutationEvent
    if oldPathNode?
        reparented[pathNode.id] = oldPathNode
    for child in node.childNodes
        pathNode.children.push(addPathNodes(child, pathNode, mutationEvent, reparented))
    return pathNode
    
handleMutations = (mutations) ->
    if !_doc?
        return
    idmap = []
    root._mutationEvent += 1
    reparented = {}
    removed = []
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
            if elementAtPath(_doc.getSnapshot(), changedPath) != oldText
                #This should not happen (but will if a text node is inserted and then the text is altered right after)
                continue
            op = util.patch_to_ot changedPath, dmp.patch_make(oldText, newText)
            root._context.submitOp op
        else if mutation.type == "childList"
            for added in mutation.addedNodes
                if added.__mutationEvent == root._mutationEvent
                    continue
                #add to pathTree
                newPathNode = addPathNodes added, mutation.target.__pathNode, root._mutationEvent, reparented
                if mutation.previousSibling?
                    siblingPathNode = mutation.previousSibling.__pathNode
                    prevSiblingIndex = mutation.target.__pathNode.children.indexOf siblingPathNode
                    mutation.target.__pathNode.children = (mutation.target.__pathNode.children[0..prevSiblingIndex].concat [newPathNode]).concat mutation.target.__pathNode.children[prevSiblingIndex+1...mutation.target.__pathNode.children.length]
                else if mutation.nextSibling?
                    mutation.target.__pathNode.children = [newPathNode].concat mutation.target.__pathNode.children
                else
                    mutation.target.__pathNode.children.push newPathNode
                insertPath = util.getJsonMLPathFromPathNode added.__pathNode
                op = {p:insertPath, li:JsonML.parseDOM(added, null, false)}
                root._context.submitOp op
            for removed in mutation.removedNodes
                if reparented[removed.__pathNode.id]? 
                    pathNode = reparented[removed.__pathNode.id]
                    reparented[removed.__pathNode.id] = null
                else 
                    pathNode = removed.__pathNode
                path = util.getJsonMLPathFromPathNode pathNode
                element = elementAtPath(_doc.getSnapshot(), path)
                op = {p:path , ld:element}
                root._context.submitOp op
                #Remove from pathTree
                childIndex = mutation.target.__pathNode.children.indexOf pathNode
                mutation.target.__pathNode.children.splice childIndex, 1
    check(_rootDiv, pathTree)

loadDocIntoDOM = (doc, targetDiv) ->
    root._doc = doc
    targetDiv.appendChild($.jqml(doc.getSnapshot())[0])
    
    root._rootDiv = rootDiv = $(targetDiv).children()[0]
    root.pathTree = util.createPathTree _rootDiv
    
    root.dmp = new diff_match_patch()

    root._context = doc.createContext()
    root._context._onOp = (ops) =>
        _observer.disconnect()
        for op in ops
            ot2dom.applyOp op, _rootDiv
        check(_rootDiv, pathTree)
        
        _observer.observe root._rootDiv, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }
    
    root._mutationEvent = 0
    root._observer = new MutationObserver handleMutations
    root._observer.observe root._rootDiv, { childList: true, subtree: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }
    
    return rootDiv

openDoc = (docName, targetDiv, callback = ->) ->
    socket = new BCSocket null, {reconnect: true}
    root._sjs = new sharejs.Connection socket
    
    doc = _sjs.get 'docs', docName
    
    doc.subscribe()
    
    doc.whenReady () ->
        if not doc.type
            console.log "Creating new doc", docName
            doc.create 'json0'
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
    root._sjs.disconnect()

root.openDoc = openDoc
root.closeDoc = closeDoc
root.elementAtPath = elementAtPath
root.check = check