{exec} = require 'child_process'

task 'build', 'Build the .js files', (options) ->
	exec "coffee --compile --bare --output lib/ client_src/", (err, stdout, stderr) ->
		if err
		    throw err
		else
		    console.log stdout + stderr
		    console.log "Compiled client coffeescript files to javascript!"
		