root = exports ? window
root.util = {}

$.fn.extend {                
    jsonMLPath: (parent = null, attribute = null) ->
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