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