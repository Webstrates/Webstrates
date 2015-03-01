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
root.util = {}

#Gets the element at a given path in a jsonml document
root.util.elementAtPath = (snapshot, path) ->
    if path.length > 0 and typeof path[path.length-1] == 'string'
        return null
    if path.length == 0 
        return snapshot
    else
        return util.elementAtPath(snapshot[path[0]], path[1..path.length])

#Used to make operations out of a set of string patches
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

#Generates a unique identifier    
root.util.generateUUID = ->
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) ->
    r = Math.random() * 16 | 0
    v = if c is 'x' then r else (r & 0x3|0x8)
    v.toString(16)
  )
  

#Given a pathnode, compute its JsonML path
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

#Creates a pathTree from a DOM element
#If a parent pathNode is provided the generated pathTree will be a subtree in the pathTree of the parent
#Per default multiple pathNodes can be added to a dom element
root.util.createPathTree = (DOMNode, parentPathNode, overwrite=false) ->
    pathNode = {id: util.generateUUID(), children: [], parent: parentPathNode, DOMNode: DOMNode}
    if overwrite
        DOMNode.__pathNodes = [pathNode]
    else
        if not DOMNode.__pathNodes?
            DOMNode.__pathNodes = []
        DOMNode.__pathNodes.push pathNode
    for child in DOMNode.childNodes
        pathNode.children.push(util.createPathTree(child, pathNode, overwrite))
    return pathNode

#Returns the last added pathNode of an element
#If a parent DOM element is provided, we search for the pathNode that matches on parent
root.util.getPathNode = (elem, parentElem) ->
    if parentElem? and parentElem.__pathNodes? and elem.__pathNodes?
        for parentPathNode in parentElem.__pathNodes
            for elemPathNode in elem.__pathNodes
                if elemPathNode.parent.id == parentPathNode.id
                    return elemPathNode
    if elem.__pathNodes? and elem.__pathNodes.length > 0
        return elem.__pathNodes[elem.__pathNodes.length - 1]
    return null

#Cleans up the DOM tree associated from a given pathNode
root.util.removePathNode = (pathNode) ->
    pathNode.parent = null
    #Remove from DOMNode
    pathNode.DOMNode.__pathNodes.splice (pathNode.DOMNode.__pathNodes.indexOf pathNode), 1
    for child in pathNode.children
        util.removePathNode child
    pathNode.children = null
    pathNode.DOMNode = null
    
#Checks consistency between a DOM tree and a pathTree        
root.util.check = (domNode, pathNode) ->
    if domNode instanceof jQuery
        domNode = domNode[0]
    if domNode.__pathNodes.length > 1
        console.log domNode, domNode.__pathNodes
        window.alert "Webstrates has encountered an error. Please reload the page."
        throw "Node has multiple paths"
    domNodePathNode = domNode.__pathNodes[0]
    if domNodePathNode.id != pathNode.id
        console.log domNode, pathNode
        window.alert "Webstrates has encountered an error. Please reload the page."
        throw "No id match"
    if domNode.childNodes.length != pathNode.children.length
        console.log domNode, pathNode
        window.alert "Webstrates has encountered an error. Please reload the page."
        throw "Different amount of children"
    for i in [0...domNode.childNodes.length]
        util.check(domNode.childNodes[i], pathNode.children[i])
        