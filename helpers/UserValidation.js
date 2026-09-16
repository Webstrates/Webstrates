'use strict';

/*
	Username validation

	Usernames are written into documents' data-auth attributes as part of JSON permission lists
	(e.g. by setUserPermissions), and both the server (helpers/PermissionManager.js,
	getPermissionsFromSnapshot) and the client (client/webstrates/permissions.js) parse that
	attribute leniently — the attribute may be written single-quoted and HTML-escaped, so the
	parser rewrites every apostrophe in the attribute to a double quote (and &quot; to ", and
	&amp; to &) before JSON.parsing it. A username cannot containing ', " or &.	
*/

// The characters that make a username invalid: the three characters the lenient data-auth
// parsing rewrites (apostrophe, double quote, ampersand). The empty string is equally useless
// as a username and is rejected as well.
const INVALID_USERNAME_CHARACTERS = /['"&]/;

/**
 * Whether a username is valid in this system: a non-empty string containing no apostrophes,
 * double quotes or ampersands.
 * @param  {mixed}  username Username.
 * @return {boolean}         Whether the username is valid.
 * @public
 */
module.exports.isValidUsername = (username) =>
	typeof username === 'string' && username.length > 0
		&& !INVALID_USERNAME_CHARACTERS.test(username);

/**
 * Whether a candidate can serve as a username. Strings have to be valid usernames; any other
 * value can — e.g. numeric user ids from passport profiles have always worked as usernames and
 * cannot corrupt the data-auth attribute. Falsy values (null, undefined, 0, '') cannot.
 * @param  {mixed}  candidate Username candidate.
 * @return {boolean}          Whether the candidate can serve as a username.
 * @public
 */
module.exports.canBeUsername = (candidate) => !!candidate
	&& (typeof candidate !== 'string' || !INVALID_USERNAME_CHARACTERS.test(candidate));

/**
 * Determine the username to establish for a user object: the first of the user's username,
 * email or id that can serve as a username, or 'anonymous' if none can. Candidates that are
 * not valid usernames are skipped as if they were absent — an identity with an invalid
 * username does not exist in this system, so we fall through to the next candidate rather than
 * ever establishing an invalid username.
 * @param  {object} user User object (request user, passport profile or stored session).
 * @return {mixed}      Username (a string, or the candidate value, e.g. a numeric id).
 * @public
 */
module.exports.getEffectiveUsername = (user) =>
	(user && module.exports.canBeUsername(user.username) && user.username)
	|| (user && module.exports.canBeUsername(user.email) && user.email)
	|| (user && module.exports.canBeUsername(user.id) && user.id)
	|| 'anonymous';
