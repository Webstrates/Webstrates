###
Copyright 2014 Clemens Nylandsted Klokmose, Aarhus University

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
###

root = exports ? window
root.ot2dom = {}

applyOp = (op, div) ->
    path = op.p
    htmlPath = []
    attributePath = false
    #TODO: Refactor and document code below
    if path.length > 0
        if op.si? or op.sd?
            charIndex = op.p.pop()
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
            setAttribute $(div), htmlPath, op.oi
    if op.li? #list insertion
        if not attributePath
            insert $(div), htmlPath, htmlPath, op.li
    if op.ld? #list deletion
        if not attributePath
            deleteNode $(div), htmlPath
    if op.lm? #list rearrangement
        throw "op.lm not currently supported!"
        #if not attributePath
        #    reorder $(div), htmlPath, op.lm-2
    if op.si? #String insertion
        if not attributePath
            insertInText $(div), htmlPath, charIndex, op.si
    if op.sd? #String deletion
        if not attributePath
            deleteInText $(div), htmlPath, charIndex, op.sd
            
insertInText = (element, path, charIndex, value) ->
    if path.length > 1
        insertInText element.contents().eq(path[0]), path[1..path.length], charIndex, value
    else
        textNode = element.contents().eq(path[0])[0]
        oldString = textNode.wholeText
        newString = oldString.substring(0, charIndex) + value + oldString.substring(charIndex, oldString.length)
        textNode.replaceWholeText newString
        
deleteInText = (element, path, charIndex, value) ->
    if path.length > 1
        deleteInText element.contents().eq(path[0]), path[1..path.length], charIndex, value
    else
        textNode = element.contents().eq(path[0])[0]
        oldString = textNode.wholeText
        newString = oldString.substring(0, charIndex) + oldString.substring(charIndex + value.length, oldString.length)
        if newString.length == 0 #Hack to avoid that the browser removes the empty text node
            newString = '&nbsp;'
        textNode.replaceWholeText newString
        
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
        sibling = element.contents().eq(relativePath[0])
        if sibling.length > 0
            html.insertBefore(element.contents().eq(relativePath[0]))
        else if html[0].tagName? and html[0].tagName.toLowerCase() == "script" 
            element[0].appendChild(html[0])
        else
            element.append(html)
        parentPathNode = util.getPathNode(element[0])
        newPathNode = util.createPathTree html[0], parentPathNode, true
       
        siblings = parentPathNode.children
        parentPathNode.children = (siblings[0...relativePath[0]].concat [newPathNode]).concat siblings[relativePath[0]...siblings.length]
        
deleteNode = (element, path) ->
    if path.length > 1
        deleteNode element.contents().eq(path[0]), path[1..path.length]
    if path.length == 1
        toRemove = element.contents().eq(path[0])
        parentPathNode = util.getPathNode element[0]
        toRemovePathNode = util.getPathNode toRemove[0], parentPathNode
        childIndex = parentPathNode.children.indexOf toRemovePathNode 
        parentPathNode.children.splice childIndex, 1
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
    #Update path tree

root.ot2dom.applyOp = applyOp