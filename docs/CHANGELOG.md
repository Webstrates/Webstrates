# Change Log
All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## 1.0.0 (July 19, 2016)

The entire Webstrates codebase has been rewritten to no longer depend on CoffeeScript, to use ShareDB instead of ShareJS, and a multitude of other improvements.

For developers who have previously been using the ShareJS version of Webstrates:

- The database will not be entirely compatible. Documents will work, but the document history and operations lists will not. To fix this, use the [migration tool](https://github.com/Webstrates/sharedb-migration-tool).
- The structure of `config.json` has changed slightly. Refer to `config-sample.json` and the documentation if you're experiencing issues.