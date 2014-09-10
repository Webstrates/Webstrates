root = exports ? window
root.util = {}

$.fn.extend {                
    jsonMLPath: (parent = null, attribute = null) -> #Her er der noget galt med text nodes
        elementPath = cssPath(this.get(0), parent.get(0)).map (el) -> el.childIndex
        jsonPath = []
        for i in elementPath
            jsonPath.push(i+2)
        if attribute?
            jsonPath.push(1)
            jsonPath.push(attribute)
        return jsonPath
}

root.util.patch_to_ot = (path, patches) ->
    ops = []
    for patch in patches
        insertionPoint = patch.start1
        for diff in patch.diffs
            if diff[0] == 0
                insertionPoint += diff[1].length
            if diff[0] == 1
                ops.push {si: diff[1], p: path.concat [insertionPoint]}
                insertionPoint += diff[1].length
            if diff[0] == -1
                ops.push {sd: diff[1], p: path.concat [insertionPoint]}
    return ops
    
root.util.generateUUID = ->
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) ->
    r = Math.random() * 16 | 0
    v = if c is 'x' then r else (r & 0x3|0x8)
    v.toString(16)
  )
  
        
root.util.getJsonMLPathFromPathNode = (node) ->
    if not node.parent?
        return []
    else
        childIndex = 2 #JsonML specific {name, attributes, children}
        for sibling in node.parent.children
            if sibling.id == node.id
                break
            childIndex += 1
        return util.getJsonMLPathFromPathNode(node.parent).concat [childIndex]
        
root.util.createPathTree = (node, parent=null, mutationEvent=-1) ->
    pathNode = {id: util.generateUUID(), children: [], parent: parent, DOMNode: node}
    node.__pathNode = pathNode
    node.__mutationEvent = mutationEvent
    for child in node.childNodes
        pathNode.children.push(util.createPathTree(child, pathNode, mutationEvent))
    return pathNode
        