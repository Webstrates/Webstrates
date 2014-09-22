{Duplex} = require 'stream'
browserChannel = require('browserchannel').server
express = require 'express'
argv = require('optimist').argv
livedb = require('livedb')
livedbMongo = require 'livedb-mongo'
serveStatic = require 'serve-static'
ot = require 'livedb/lib/ot'
jsxml= require 'jsxml'
auth = require 'http-auth'
shortId = require 'shortid'

try
  require 'heapdump'

sharejs = require 'share'

basic = auth.basic {
        realm: "Webstrate"
    }, (username, password, callback) ->
        callback username == "webstrate" and password == "webstrate"

webserver = express()

webserver.use(serveStatic("#{__dirname}/html"))
webserver.use(serveStatic("#{__dirname}/lib"))
webserver.use(serveStatic(sharejs.scriptsDir))
webserver.use(auth.connect(basic))

mongo = livedbMongo('mongodb://localhost:27017/webstrate?auto_reconnect', {safe:true});
backend = livedb.client(mongo);

backend.addProjection '_users', 'users', 'json0', {x:true}

share = sharejs.server.createClient {backend}

share.use (request, next) ->
    next()

webserver.get '/new', (req, res) ->
    if req.query.prototype?
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
                            res.redirect '/' + webstrateId
            else
                backend.submit 'webstrates', webstrateId, {v:0, create:{type:'json0', data:prototypeSnapshot.data}}, (err) ->
                    res.redirect '/' + webstrateId
    else
        res.redirect '/' + shortId.generate()

webserver.get '/:id', (req, res) ->
    if req.params.id.length > 0
        if req.query.v?
            if Number(req.query.v) > 0
                backend.fetch 'webstrates', req.params.id, (err, snapshot) ->
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
            else
                res.send ""
        else
            res.sendFile __dirname+'/html/_client.html'
    else
        res.redirect '/frontpage'
        
webserver.get '/', (req, res) ->
    res.redirect '/frontpage'

###
share.use 'validate', (req, callback) ->
  err = 'noooo' if req.snapshot.data?.match /x/
  callback err

share.use 'connect', (req, callback) ->
  console.log req.agent
  callback()
###

numClients = 0

webserver.use browserChannel {webserver, sessionTimeoutInterval:5000}, (client) ->
  numClients++
  stream = new Duplex objectMode:yes
  stream._write = (chunk, encoding, callback) ->
    #console.log 's->c ', JSON.stringify(chunk)
    if client.state isnt 'closed' # silently drop messages after the session is closed
      client.send chunk
    callback()

  stream._read = -> # Ignore. You can't control the information, man!

  stream.headers = client.headers
  stream.remoteAddress = stream.address

  client.on 'message', (data) ->
    #console.log 'c->s ', JSON.stringify(data)
    stream.push data

  stream.on 'error', (msg) ->
    client.stop()

  client.on 'close', (reason) ->
    stream.push null
    stream.emit 'close'

    numClients--
    console.log 'client went away', numClients

  stream.on 'end', ->
    client.close()

  # ... and give the stream to ShareJS.
  share.listen stream

webserver.use '/doc', share.rest()

port = argv.p or 7007
webserver.listen port
console.log "Listening on http://localhost:#{port}/"
