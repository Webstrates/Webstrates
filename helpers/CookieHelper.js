"use strict";

var sessions = require('client-sessions');

/**
 * CookieHelper constructor.
 * @param {json} cookieConfig
 * @constructor
 */
module.exports = function(cookieConfig) {
	var module = {};

	/**
	 * Decode cookie.
	 * @param  {string} cookie Cookie string.
	 * @return {json}          Decoded cookie object.
	 * @public
	 */
	module.decodeCookie = function(cookie) {
		if (!cookie) {
			return null;
		}

		cookie = parseCookie(cookie);

		if (cookie[cookieConfig.cookieName]) {
			return sessions.util.decode(cookieConfig, cookie[cookieConfig.cookieName]).content;
		}

		return null;
	};

	/**
	 * Parse cookie string.
	 * @param  {string} cookie Cookie string.
	 * @return {json}          Cookie object.
	 * @private
	 */
	function parseCookie(cookie) {
		var obj = {};
		var pairs = cookie.split(/[;,] */);

		pairs.forEach(function(pair) {
			var eqIdx = pair.indexOf('=');
			if (eqIdx === -1) {
				return;
			}

			var key = pair.substr(0, eqIdx).trim();
			var val = pair.substr(eqIdx + 1).trim();

			if (obj[key]) {
				return;
			}

			if (val[0] === '"') {
				val = val.slice(1, -1);
			}

			try {
				obj[key] = decodeURIComponent(val);
			} catch (error) {
				obj[key] = val;
			}

		});

		return obj;
	}

	return module;
};