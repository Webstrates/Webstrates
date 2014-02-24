express = require 'express'
shareserver = require('share').server

shareApp = express()
shareApp.use (req, res, next) ->
    res.header 'Access-Control-Allow-Origin', '*'
    next()
shareApp.use(express.static(__dirname+'/html'))
shareApp.use(express.static(__dirname+'/lib'))
shareApp.get '/:id', (req, res) ->
    if req.params.id.length > 0
        res.sendfile(__dirname+'/html/_client.html')
    else
        res.send("Please provide a document id!")

if process.argv[2]
    type = process.argv[2]
if type == 'couchdb'
    options = { db: { type: 'couchdb', uri: process.env.COUCHDB_SERVICE_URI }, port: 5984 }
if type == 'redis'
    options = {}
else
    options = {db: {type: 'none'}}
shareserver.attach(shareApp, options)

shareApp.listen(8000)