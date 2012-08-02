getElementPath = (element) ->
    siblingNumber = () ->
        $this = $(this)
        count = 0
        tagName = this.nodeName
        for sibling in $this.parent().contents()
            if sibling == $this.get(0)
                break
            count++
        return count
    return $(element).parents().andSelf().map(siblingNumber).get()

$.fn.extend {                
    path: (parent = null) ->
        elementPath = getElementPath(this.get(0))
        parentIndex = 0
        if parent?
            parentPath = getElementPath(parent.get(0))
            parentIndex = parentPath.length
        return elementPath[parentIndex..elementPath.length]
    ,
    jsonMLPath: (parent = null, attribute = null) ->
        elementPath = this.path(parent)
        jsonPath = []
        for i in elementPath
            jsonPath.push(i+2)
        if attribute?
            jsonPath.push(1)
            jsonPath.push(attribute)
        return jsonPath
}