###
Copyright 2016 Clemens Nylandsted Klokmose, Aarhus University

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

# This function takes a (ShareJS) operation and applies it to a DOM element
applyOp = (op, element) ->
    path = op.p
    domPath = []
    attributePath = false
    # First convert from json path to domPath
    if path.length > 0
        if op.si? or op.sd? # Its a string manipulation
            charIndex = op.p.pop() 
        if typeof path[path.length-1] == 'string' # its an attribute path
            attributePath = true
            if path.length > 2
                # Push all indeces converted to DOM indeces (by substracting 2) up to the target node
                for index in op.p[0..path.length-3]
                    domPath.push index-2
                # Push the attribute key
                domPath.push path[path.length-1]
            else
                # Just push the attribute key
                domPath.push(path[1])
        else
            # Push all indeces converted to DOM indeces (by substracting 2)
            for index in op.p
                domPath.push index-2
    if op.oi? # Operation is an object insertion
        if attributePath
            setAttribute $(element), domPath, op.oi
    if op.li? # Operation is a list insertion
        if not attributePath
            insert $(element), domPath, domPath, op.li
    if op.ld? # Operation is a list deletion
        if not attributePath
            deleteNode $(element), domPath
    if op.si? # Operation is a string insertion
        if not attributePath
            insertInText $(element), domPath, charIndex, op.si
    if op.sd? # Operation is a string deletion
        if not attributePath
            deleteInText $(element), domPath, charIndex, op.sd
            
insertInText = (element, path, charIndex, value) ->
    if path.length > 1
        insertInText element.contents().eq(path[0]), path[1..path.length], charIndex, value
    else
        textNode = if element[0].nodeType == 8 then element[0] else element.contents().eq(path[0])[0]
        oldString = textNode.data
        newString = oldString.substring(0, charIndex) + value + oldString.substring(charIndex, oldString.length)
        textNode.data = newString
        event = new CustomEvent "insertText", {detail: {position: charIndex, value: value}}
        textNode.dispatchEvent event
        
deleteInText = (element, path, charIndex, value) ->
    if path.length > 1
        deleteInText element.contents().eq(path[0]), path[1..path.length], charIndex, value
    else
        textNode = element.contents().eq(path[0])[0]
        oldString = textNode.data
        newString = oldString.substring(0, charIndex) + oldString.substring(charIndex + value.length, oldString.length)
        if newString.length == 0 #Hack to avoid that the browser removes the empty text node
            newString = ''
        textNode.data = newString
        event = new CustomEvent "deleteText", {detail: {position: charIndex, value: value}}
        textNode.dispatchEvent event
        
        
setAttribute = (element, path, value) ->
    if path.length > 1
        # Recursively skip to the end of the path
        setAttribute element.contents().eq(path[0]), path[1..path.length], value
    else
        # Update the attribute
        element.attr(path[0], value)

insert = (element, relativePath, actualPath, value) ->
    if relativePath.length > 1
        # Recursively skip to the end of the path
        insert element.contents().eq(relativePath[0]), relativePath[1..relativePath.length], actualPath, value
    if relativePath.length == 1
        # Get the XML namespace of the target node
        ns = root.util.getNs element[0]
        # Convert the inserted JsonML 
        if typeof value == 'string'
            html = $(document.createTextNode(value))
        else
            html = $.jqml(value, ns)
        # Get the next sibling that the node should be inserted before
        sibling = element.contents().eq(relativePath[0])
        if sibling.length > 0
            # There is a sibling, we will insert the node before it
            element[0].insertBefore(html[0], sibling[0])
        # There's no sibling, so lets insert it (with a small hack to avoid JQuery not actually inserting a script node
        else if html[0].tagName? and html[0].tagName.toLowerCase() == "script" 
            element[0].appendChild(html[0])
        else
            element.append(html)
        # Update the path tree with the new node
        parentPathNode = util.getPathNode(element[0])
        newPathNode = util.createPathTree html[0], parentPathNode, true
        siblings = parentPathNode.children
        parentPathNode.children = (siblings[0...relativePath[0]].concat [newPathNode]).concat siblings[relativePath[0]...siblings.length]
        
deleteNode = (element, path) ->
    # Recursively skip to the end of the path
    if path.length > 1
        deleteNode element.contents().eq(path[0]), path[1..path.length]
    if path.length == 1
        # First remove the node from the path tree
        toRemove = element.contents().eq(path[0])
        parentPathNode = util.getPathNode element[0]
        toRemovePathNode = util.getPathNode toRemove[0], parentPathNode
        childIndex = parentPathNode.children.indexOf toRemovePathNode 
        parentPathNode.children.splice childIndex, 1
        # Now remove the node from the DOM
        toRemove.remove()
        
root.ot2dom.applyOp = applyOp
