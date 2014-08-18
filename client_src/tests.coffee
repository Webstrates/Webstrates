root = exports ? window

#TEST LIST
# X Add element to DOM
# X Remove element from DOM
# X Set attribute
# - reparent element in DOM

compareJsonPaths = (p1, p2) ->
    if p1.length != p2.length 
        return false
    equal = true
    for i in [0..p1.length - 1]
        equal = equal and (p1[i] == p2[i])
    return equal

async = (func) ->
    setTimeout(func, 0)
        
load = () ->
    stop()
    $('body').append('<div id="testfixture"></div>')
    openDoc "test" + new Date().getTime(), $('#testfixture').get(0), (error, doc, div) ->
        root._testdoc = doc
        root._rootDiv = $(div)
        ok not error?, "No errors when loading document"
        root._testContext = doc.createContext()
        start()
        
close = () ->
    console.log _observer
    _testContext.destroy()
    closeDoc()
    $('#testfixture').remove()

module "DOM to JSON", {setup: load, teardown: close}

test "Load a new document", () ->
    ok _observer?, "Observer running"
    ok _testdoc?, "Document was loaded"
    ok _rootDiv?, "Content installed in DOM"

test "Add element to DOM", () ->
    newElement = $('<div someattr="foo"></div>')
    stop()
    ops = []
    
    _doc.on "op", (op) ->
        ops = op
        
    onTimeout = () ->
        start()
        console.log ops
        ok ops.length == 1
        op = ops[0]
        ok op?, "Update received"
        ok op.li?, "Op was list insert"
        ok compareJsonPaths(op.p, newElement[0].__path), "op path match computed element path"
        equal op.li[0], 'DIV', "The element from op match the one inserted"
        ok op.li[1].someattr?, "Element from op has attr from DOM div"
        equal op.li[1].someattr, "foo", "Value of element attribute match value of attribute in op"

    async () -> _rootDiv.append(newElement)
    
    setTimeout onTimeout, 500
    
    
test "Add element before another DOM element", () ->
    firstElement = $('<div id="bar"></div>')
    _rootDiv.append(firstElement)
    secondElement = $('<div id="foo"></div>')
    stop()
    ops = []
    
    _doc.on "after op", (op) ->
        ops.push op
        
    onTimeout = () ->
        start()
        ok ops.length == 2, "We get the correct amount of ops"
        fooOp = ops[1][0]
        barOp = ops[0][0]
        fooElem = $('#foo')[0]
        barElem = $('#bar')[0]
        
        ok barOp.p.join() != barElem.__path.join(), "Path of bar does not match op path, as the element is moved"
        ok fooOp.p.join() == fooElem.__path.join(), "Path of foo element does match as it is prepended to the list"

    async () -> _rootDiv.prepend(secondElement)
    
    setTimeout onTimeout, 500
    
test "Remove element from DOM", () ->
    _rootDiv.append('<div id="foo"></div>')
    stop()
    _testdoc.on "op", (ops) ->
        if ops[0].li?
            return
        start()
        ok ops?, "Update received"
        ok ops.length == 1
        op = ops[0]
        ok op.ld?, "Op was list delete"
        ok op.ld[0] == 'DIV', "Op is removing a div"
        ok op.ld[1].id == 'foo', "The div as id foo"
        ok op.p[0] == 2, "Path is correct"
    async ->
      $('#foo').remove()
    
test "Set attribute", () ->
    stop()
    newElement = $('<iframe src="http://www.cs.au.dk"></iframe>')
    _doc.on "op", (ops) ->
        op = ops[0]
        if op.oi?
            start()
            ok op?, "Recived attribute op"
            equal op.oi, "bar", "Set attribute had the correct value"
    _rootDiv.append(newElement)
    async () ->
        newElement.attr('someattr', 'bar')
    
test "Add iFrame", () ->
    newElement = $('<iframe src="http://www.cs.au.dk"></iframe>')
    stop()
    _doc.on "op", (ops) ->
        start()
        op = ops[0]
        ok op?, "Update received"
        ok op.li?, "Op was list insert"
        ok compareJsonPaths(op.p, newElement.jsonMLPath(_rootDiv)), "op path match computed element path"
        equal op.li[0], 'IFRAME', "The element from op match the one inserted"
        ok op.li[1].src?, "Element from op has attr from DOM div"
        equal op.li[1].src, "http://www.cs.au.dk", "Value of element attribute match value of attribute in op"
        
    _rootDiv.append(newElement)

test "Add span around plain text", () ->
    stop()
    _doc.on "op", (ops) ->
        start()
        ok ops[0].li?, "Something is added"
        ok ops[0].li[0] == "SPAN", "That something is a span"
        ok ops.length == 1, "There is only a single operation"

    _rootDiv.append("Foo")
    
test "Enclose element in tag", () ->
    stop()
    _rootDiv.append('<div id="bar"></div>');

    ops = []
    _doc.on "after op", (op) ->
        ops.push op
        
    onTimeout = () ->
        start()
        console.log ops
        ok ops.length == 3, "Should generate three (four) operations"
        ok ops[0][0].li?, "First op is a li"
        ok ops[0][0].li[1].id == "bar", "First op inserts bar"
        ok ops[1][0].li?, "Second op is a li"
        ok ops[1][0].li[1].id == "foo", "Second op inserts foo"
        ok ops[1][0].p.join() == "2", "Second op inserts foo at [2]"
        ok ops[2][0].li?, "Third op is a li"
        ok ops[2][0].li[1].id == "bar", "Third op inserts bar again"
        ok ops[2][0].p.join() == "2,2", "Third op inserts foo at [2,2]"
        ok ops[2][1].ld?, "Fourth op is a ld"
        console.log ops[2][1]
        ok ops[2][1].ld[1].id == "bar", "Fourth op deletes bar"
        ok ops[2][1].p.join() == "3", "Fourth op deletes bar at [3]"

    async () -> $('#bar').wrap('<div id="foo"/>')
    
    setTimeout onTimeout, 500
    #console.log $('#bar')
    
test "Reparent element in DOM", () ->
    newElement = $('<div id="parent"><div id="foo"><div id="bar"></div></div></div>')
    _rootDiv.append(newElement)
    stop()
    ops = []
    _doc.on "after op", (op) ->
        ops.push op
        
    onTimeout = () ->    
        start()
        ok ops[3][0].li?, "First something is inserted"
        ok ops[3][0].li[0] == "DIV", "It is a DIV that is added"
        ok ops[3][0].li[1].id == "bar", "The added div has id bar"
        ok ops[3][0].p.join() == "2,3", "The added div has the correct path"
        ok ops[3][1].ld?, "Then something is deleted"
        ok ops[3][1].ld[0] == "DIV", "It is a DIV that is deleted"
        ok ops[3][1].ld[1].id == "bar", "The deleted div has id bar"
        ok ops[3][1].p.join() == "2,2,2", "The deleted div has the correct path"
    async () ->
        $("#bar").appendTo("#parent")
        
    setTimeout onTimeout, 500
    
    
test "Reparent element in DOM on elements path", () ->
    newElement = $('<div id="parent"><div id="foo"><div id="bar"></div></div></div>')
    _rootDiv.append(newElement)
    stop()
    ops = []
    _doc.on "after op", (op) ->
        ops.push op
        
    onTimeout = () ->    
        start()
        ok ops[3][0].li?, "First something is inserted"
        ok ops[3][0].li[0] == "DIV", "It is a DIV that is added"
        ok ops[3][0].li[1].id == "bar", "The added div has id bar"
        ok ops[3][0].p.join() == "2,2", "The added div has the correct path"
        ok ops[3][1].ld?, "Then something is deleted"
        ok ops[3][1].ld[0] == "DIV", "It is a DIV that is deleted"
        ok ops[3][1].ld[1].id == "bar", "The deleted div has id bar"
        ok ops[3][1].p.join() == "2,3,2", "The deleted div has the correct path"
    async () ->
        $("#bar").prependTo("#parent")
        
    setTimeout onTimeout, 500
#test "Add mixed html", () ->
#    stop()
#    ops = []
#    _doc.on "op", (op) ->
#        ops.push op
        
#    onTimeout = () ->
#        start()
#        ok ops.length == 5, "We got five operations"
#        ok ops[0][0].li.length == 2, "The length of the first op should be 2"
        #More oks
    
    
    

    
#test "Remove iFrame", () ->
#    newElement = $('<iframe id="foo" src="http://www.cs.au.dk"></iframe>')
#    _rootDiv.append(newElement)
#    stop()
#    _doc.on 'change', (ops) ->
#        start()
#        op = ops[0]
#        ok op?, "Update received"
        #ok op.li?, "Op was list insert"
        #ok compareJsonPaths(op.p, newElement.jsonMLPath(_rootDiv)), "op path match computed element path"
        #equal op.li[0], 'IFRAME', "The element from op match the one inserted"
        #ok op.li[1].src?, "Element from op has attr from DOM div"
        #equal op.li[1].src, "http://www.cs.au.dk", "Value of element attribute match value of attribute in op"
        
    #newElement.remove()
    
    
# test "a basic test example", () ->
#   ok true, "this test is fine"
#   value = "hello"
#   equal value, "hello", "We expect value to be hello"
# 
# module "Module A"
# 
# test "first test within module", () ->
#    ok true, "all pass"
# 
#  
# test "second test within module", () ->
#    ok true, "all pass"
# 
#  
# module "Module B"
#  
# test "some other test", () ->
#    expect 2
#    equal true, false, "failing test" 
#    equal true, true, "passing test"