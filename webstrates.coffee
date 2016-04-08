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


{Duplex} = require 'stream'
express = require 'express'
argv = require('optimist').argv
livedb = require('livedb')
livedbMongo = require 'livedb-mongo'
ot = require 'livedb/lib/ot'
jsonml = require 'jsonml-tools'
http_auth = require 'http-auth'
shortId = require 'shortid'
WebSocketServer = require('ws').Server
http = require 'http'
passport = require 'passport'
sessions = require "client-sessions"
fs = require "fs"
util = require "./util.coffee"

try
  require 'heapdump'

sharejs = require 'share'

# Setup MongoDB connection for the session log
MongoClient = require('mongodb').MongoClient
sessionLog = null;
MongoClient.connect 'mongodb://127.0.0.1:27017/log', (err, db) ->
    sessionLog = db.collection 'sessionLog'

# Create express app and websocket server
app = express()
app.server = http.createServer app
wss = new WebSocketServer {server: app.server}

# Serve all static files (including source coffee files)
app.use('/client_src', express.static('client_src'));
app.use(express.static('html'))
app.use(express.static('webclient'))
app.use(express.static(sharejs.scriptsDir))

# Setup connection to MongoDB for ShareJS
mongo = livedbMongo('mongodb://localhost:27017/webstrate?auto_reconnect', {safe:true});

# Setup livedb to use MongoDB as backend
backend = livedb.client(mongo);

# Setup ShareJS to use LiveDB as backend
share = sharejs.server.createClient {backend}

# Load configuration
try
    fs.statSync 'config.json'
catch err
    console.log "No config file present, creating one now."
    fs.writeFileSync 'config.json', "{}"
config = JSON.parse(fs.readFileSync('config.json', 'utf8'))

# Setup basic auth if configured in the config file
if config.basic_auth?
    console.log "Basic auth enabled"
    basic = http_auth.basic {
                realm: config.basic_auth.realm,
            }, (username, password, callback) ->
                callback username == config.basic_auth.username and password == config.basic_auth.password
    app.use(http_auth.connect(basic))

# Setup Webstrates authentication if configured in the config file (currently only tested with GitHub as provider)
auth = false
permissionCache = {}
if config.auth?
    secret = config.auth.secret
    app.use sessions {
        cookieName: 'session',
        secret: secret,
        duration: config.auth.cookieDuration
    }

    passport.serializeUser (user, done) ->
        done null, user

    passport.deserializeUser (obj, done) ->
        done null, obj

    # Iterate auth providers and initialize their strategies.
    for key of config.auth.providers
        PassportStrategy = require(config.auth.providers[key].node_module).Strategy
        passport.use new PassportStrategy config.auth.providers[key].config,
        (accessToken, refreshToken, profile, done) ->
            process.nextTick () ->
                return done null, profile

    app.use passport.initialize()
    app.use passport.session()

    # Setup login and callback URLs
    for provider of config.auth.providers
        app.get '/auth/'+provider,
            passport.authenticate(provider), (req, res) ->

        app.get '/auth/'+provider+'/callback',
            passport.authenticate(provider, { failureRedirect: '/auth/'+provider }), (req, res) ->
                res.redirect '/'

        console.log provider + " based authentication enabled"

    app.get '/auth/logout', (req, res) ->
        req.logout()
        res.redirect '/'

    auth = true

# Decode a cookie into a JSON object
decodeCookie = (cookie) ->
    if !cookie?
        return null
    if cookie['session']?
        return sessions.util.decode({cookieName: 'session', secret:secret}, cookie['session']).content;
    return null

# Handle permissions for requests to ShareJS (over Websockets)
share.use (request, next) ->
    if auth
        session = decodeCookie(util.parseCookie request.agent.stream.headers.cookie)
    if auth and session? and session.passport? and session.passport.user?
        provider = session.passport.user.provider
        username = session.passport.user.username
    else
        username = "anonymous"
        provider = ""
    userId = username + ":" + provider
    if request.action == "connect"
        #Log connection
        logItem = {sessionId: request.agent.sessionId, userId: userId, connectTime: request.agent.connectTime, remoteAddress: request.stream.remoteAddress}
        sessionLog.insert logItem, (err, db) ->
            if err
                throw err
        next()
        return
    if not permissionCache[userId]?
        # This happens if the client has not actually opened a page
        next("Forbidden")
        return
    permissions = permissionCache[userId]
    if request.action in ["fetch", "bulk fetch", "getOps", "query"]
        # Check for read permissions
        if request.docName?
            requestedWebstrate = request.docName
        else if request.requests? and request.requests.webstrates[0]?
            requestedWebstrate = request.requests.webstrates[0]
        if permissions[requestedWebstrate]?
            if permissions[requestedWebstrate].indexOf("r") > -1
                next()
                return
        next('Forbidden')
    else if request.action == "submit"
        # Check for write permissions
        webstrate = request.docName
        if permissions[webstrate]?
            if permissions[webstrate].indexOf("w") > -1
                next()
                return
        next('Forbidden')
    else if request.action == "delete"
        next("Forbidden")
    else
        next()

app.get '/favicon.ico', (req, res) ->
    res.status(404).send("")

# /new creates a new webstrate.
# An id for the new webstrate can be provide, if not it is autogenerated
# A reference to a prototype can be given, and then the new webstrate will be a copy of the given prototype
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

# Extract permission data from a webstrate
getPermissionsForWebstrate = (username, provider, webstrate, snapshot) ->
    if snapshot.data? and snapshot.data[0]? and snapshot.data[0] == 'html'
        if snapshot.data[1]? and snapshot.data[1]['data-auth']?
            try 
                authData = JSON.parse snapshot.data[1]['data-auth']
                for user in authData
                    if user.username == username && user.provider == provider
                        return user.permissions
            catch error
    return "rw"

# Get a webstrate.
# ?v=10 will result in version 10 of the given webstrate (without the client loaded)
# ?v=head gives the newest version of the webstrate (without the client loaded)
# ?v returns the version number of head
# When a previous version is fetched, the server will convert JsonML from the backend to HTML for the browser
# GET on a webstrate will set the permissions in the permission cache for the given user, which is used when requests for ShareJS arrives over a websocket connection
app.get '/:id', (req, res) ->
    if req.params.id.length > 0
        session = req.session
        if auth and session? and session.passport? and session.passport.user?
            username = session.passport.user.username
            provider = session.passport.user.provider
        else
            username = "anonymous"
            provider = ""
        userId = username+":"+provider
        if req.query.v?
            backend.fetch 'webstrates', req.params.id, (err, snapshot) ->
                permissions = getPermissionsForWebstrate username, provider, req.params.id, snapshot
                if permissions.indexOf("r") < 0
                    res.send "Permission denied"
                    return
                if Number(req.query.v) > 0
                    if snapshot.v < req.query.v
                        res.status(404).send "'" + req.params.id + "' does not exist in version " + req.query.v + ". Highest version is " + snapshot.v + "."
                    else
                        backend.getOps 'webstrates', req.params.id, 0, Number(req.query.v), (err, ops) ->
                            ops.sort (a,b) ->
                                return a.v - b.v
                            data = {v:0}
                            for op in ops
                                ot.apply data, op
                            res.send (jsonml.toXML data.data, ["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem", "meta", "param", "source", "track", "wbr"])
                else if req.query.v == 'head'
                    res.send (jsonml.toXML snapshot.data, ["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem", "meta", "param", "source", "track", "wbr"])
                else if req.query.v == ''
                    console.log "Snapshot version", snapshot.v
                    res.send "" + snapshot.v
                else
                    res.send "Version must be a number or head"
        else if req.query.ops?
            backend.fetch 'webstrates', req.params.id, (err, snapshot) ->
                permissions = getPermissionsForWebstrate username, provider, req.params.id, snapshot
                if permissions.indexOf("r") < 0
                    res.send "Permission denied"
                    return
                backend.getOps 'webstrates', req.params.id, 0, null, (err, ops) ->
                    sessionsInOps = []
                    for op in ops
                        if op.src in sessionsInOps
                            continue
                        sessionsInOps.push op.src
                    userId = sessionLog.find({"sessionId": { $in: sessionsInOps }}).toArray (err, results) ->
                        for op in ops
                            for session in results
                                if op.src == session.sessionId
                                    op.session = session
                        res.send ops
        else
            if not permissionCache[userId]?
                permissionCache[userId] = {}
            backend.fetch 'webstrates', req.params.id, (err, snapshot) ->
                webstrate = req.params.id
                permissions = getPermissionsForWebstrate username, provider, webstrate, snapshot
                permissionCache[userId][webstrate] = permissions
                if permissions.indexOf("r") < 0
                        res.send "Permission denied"
                        return
                res.setHeader("Location", '/' + req.params.id)
                res.sendFile __dirname+'/html/_client.html'
    else
        res.redirect '/frontpage'
        
app.get '/', (req, res) ->
    res.redirect '/frontpage'

# Setup websocket connections and interaction with ShareJS
wss.on 'connection', (client) ->
  stream = new Duplex objectMode:yes
  stream._write = (chunk, encoding, callback) ->
    try
        client.send JSON.stringify chunk
    catch error
        console.log error
    callback()

  stream._read = -> # Ignore. 

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
