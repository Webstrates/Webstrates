{Duplex} = require 'stream'
express = require 'express'
argv = require('optimist').argv
livedb = require('livedb')
livedbMongo = require 'livedb-mongo'
serveStatic = require 'serve-static'
ot = require 'livedb/lib/ot'
jsxml= require 'jsxml'
auth = require 'http-auth'
shortId = require 'shortid'
WebSocketServer = require('ws').Server
http = require 'http'

try
  require 'heapdump'

sharejs = require 'share'

basic = auth.basic {
        realm: "Webstrate"
    }, (username, password, callback) ->
        callback username == "webstrate" and password == "webstrate"

app = express()
app.server = http.createServer app
wss = new WebSocketServer {server: app.server}

app.use(serveStatic("#{__dirname}/html"))
app.use(serveStatic("#{__dirname}/lib"))
app.use(serveStatic(sharejs.scriptsDir))
app.use(auth.connect(basic))

mongo = livedbMongo('mongodb://localhost:27017/webstrate?auto_reconnect', {safe:true});
backend = livedb.client(mongo);

backend.addProjection '_users', 'users', 'json0', {x:true}

share = sharejs.server.createClient {backend}

share.use (request, next) ->
    next()

app.get '/new', (req, res) ->
    if req.query.prototype?
        if req.query.id?
            webstrateId = req.query.id
        else
            webstrateId = shortId.generate()
        backend.fetch 'webstrates', req.query.prototype, (err, prototypeSnapshot) ->
            if req.query.v?
                if not req.query.v? or Number(prototypeSnapshot.v) < Number(req.query.v) or Number(req.query.v) == 0
                    version = prototypeSnapshot.v
                else
                    version = req.query.v
                backend.getOps 'webstrates', req.query.prototype, 0, Number(version), (err, ops) ->
                    ops.sort (a,b) ->
                        return a.v - b.v
                    data = {v:0}
                    for op in ops
                        ot.apply data, op
                    backend.submit 'webstrates', webstrateId, {v:0, create:{type:'json0', data:data.data}}, (err) ->
                            console.log err
                            if err?
                                res.status(409).send("Webstrate already exsist")
                            else
                                res.redirect '/' + webstrateId
            else
                backend.submit 'webstrates', webstrateId, {v:0, create:{type:'json0', data:prototypeSnapshot.data}}, (err) ->
                    console.log err
                    if err?
                        res.status(409).send("Webstrate already exsist")
                    else
                        res.redirect '/' + webstrateId
    else
        res.redirect '/' + shortId.generate()

app.get '/:id', (req, res) ->
    if req.params.id.length > 0
        if req.query.v?
            backend.fetch 'webstrates', req.params.id, (err, snapshot) ->
                if Number(req.query.v) > 0
                    if snapshot.v < req.query.v
                        res.send "'" + req.params.id + "' does not exist in version " + req.query.v + ". Highest version is " + snapshot.v + ".", 404
                    else
                        backend.getOps 'webstrates', req.params.id, 0, Number(req.query.v), (err, ops) ->
                            ops.sort (a,b) ->
                                return a.v - b.v
                            data = {v:0}
                            for op in ops
                                ot.apply data, op
                            res.send jsxml.toXml data.data
                else if req.query.v == 'head'
                    res.send jsxml.toXml snapshot.data
                else if req.query.v == ''
                    console.log "Snapshot version", snapshot.v
                    res.send "" + snapshot.v
                else
                    res.send "Version must be a number or head"
        else
            res.setHeader("Location", '/' + req.params.id)
            res.sendFile __dirname+'/html/_client.html'
    else
        res.redirect '/frontpage'
        
app.get '/', (req, res) ->
    res.redirect '/frontpage'

###
share.use 'validate', (req, callback) ->
  err = 'noooo' if req.snapshot.data?.match /x/
  callback err

share.use 'connect', (req, callback) ->
  console.log req.agent
  callback()
###

wss.on 'connection', (client) ->
  stream = new Duplex objectMode:yes
  stream._write = (chunk, encoding, callback) ->
    try
        client.send JSON.stringify chunk
    catch error
        console.log error
    callback()

  stream._read = -> # Ignore. You can't control the information, man!

  stream.headers = client.upgradeReq.headers
  stream.remoteAddress = client.upgradeReq.connection.remoteAddress

  client.on 'message', (data) ->
    stream.push JSON.parse data

  stream.on 'error', (msg) ->
    try
        client.close msg
    catch error
        console.log error

  client.on 'close', (reason) ->
    stream.push null
    stream.emit 'close'

    console.log 'client went away'
    try
        client.close reason
    catch error
        console.log error

  stream.on 'end', ->
    try
        client.close()
    catch error
        console.log error

  # ... and give the stream to ShareJS.
  share.listen stream

app.use '/_share', share.rest()

port = argv.p or 7007
app.server.listen port
console.log "Listening on http://localhost:#{port}/"
