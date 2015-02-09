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
passport = require 'passport'
GitHubStrategy = require('passport-github').Strategy
sessions = require "client-sessions"
fs = require "fs"

try
  require 'heapdump'

sharejs = require 'share'


MongoClient = require('mongodb').MongoClient

sessionLog = null;
MongoClient.connect 'mongodb://127.0.0.1:27017/log', (err, db) ->
    sessionLog = db.collection 'sessionLog'

basic = auth.basic {
        realm: "Webstrate"
    }, (username, password, callback) ->
        callback username == "webstrate" and password == "webstrate"

app = express()
app.server = http.createServer app
wss = new WebSocketServer {server: app.server}

app.use serveStatic("#{__dirname}/html")
app.use serveStatic("#{__dirname}/lib")
app.use serveStatic(sharejs.scriptsDir)
app.use(auth.connect(basic))
auth = false
permissionCache = {}

try 
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    
    # Passport stuff
    secret = config.auth.secret
    app.use sessions {
        cookieName: 'session',
        secret: secret,
        duration: config.auth.cookieDuration    
    }

    GITHUB_CLIENT_ID = config.auth.providers.github.GITHUB_CLIENT_ID
    GITHUB_CLIENT_SECRET = config.auth.providers.github.GITHUB_CLIENT_SECRET
    callback_url = config.auth.providers.github.callback_url

    passport.serializeUser (user, done) ->
      done null, user

    passport.deserializeUser (obj, done) ->
      done null, obj

    passport.use new GitHubStrategy {
        clientID: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        callbackURL: callback_url
      },
      (accessToken, refreshToken, profile, done) ->
        process.nextTick () ->
          return done null, profile
      
    app.use passport.initialize()
    app.use passport.session()
    
    app.get '/auth/github',
      passport.authenticate('github'),
      (req, res) ->

    app.get '/auth/github/callback', 
      passport.authenticate('github', { failureRedirect: '/login' }),
      (req, res) ->
        res.redirect '/'

    app.get '/auth/logout', (req, res) ->
      req.logout()
      res.redirect '/'
    
    auth = true
catch error
    console.log "Authentication configuration mission or incomplete, starting Webstrates with authentication disabled."

parseCookie = (str, opt) ->
    if not str?
        return null;
    opt = opt || {}
    obj = {}
    pairs = str.split(/[;,] */)
    dec = opt.decode || decodeURIComponent;
 
    pairs.forEach (pair) ->
        eq_idx = pair.indexOf('=')
 
        if eq_idx < 0
            return
 
        key = pair.substr(0, eq_idx).trim()
        val = pair.substr(++eq_idx, pair.length).trim();
 
        if '"' == val[0]
            val = val.slice(1, -1)
        
 
        if undefined == obj[key]
            try 
                obj[key] = dec(val);
            catch e 
                obj[key] = val;
 
    return obj

mongo = livedbMongo('mongodb://localhost:27017/webstrate?auto_reconnect', {safe:true});
backend = livedb.client(mongo);

backend.addProjection '_users', 'users', 'json0', {x:true}

share = sharejs.server.createClient {backend}

decodeCookie = (cookie) ->
    if !cookie?
        return null
    if cookie['session']?
        return sessions.util.decode({cookieName: 'session', secret:secret}, cookie['session']).content;
    return null
    
share.use (request, next) ->
    if auth
        session = decodeCookie(parseCookie request.agent.stream.headers.cookie)
    if auth and session? and session.passport? and session.passport.user?
        provider = session.passport.user.provider
        username = session.passport.user.username
    else
        username = "anonymous"
        provider = ""
    userId = username + ":" + provider
    if request.action == "connect"
        logItem = {sessionId: request.agent.sessionId, userId: userId, connectTime: request.agent.connectTime, remoteAddress: request.stream.remoteAddress}
        sessionLog.insert logItem, (err, db) ->
            if err
                throw err
        next()
        return
    if not permissionCache[userId]?
        next("Forbidden")
        return
    permissions = permissionCache[userId]
    if request.action in ["fetch", "bulk fetch", "getOps", "query"]
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
    res.send("", 404)

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
                permissionCache[userId][webstrate] = getPermissionsForWebstrate username, provider, webstrate, snapshot
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
