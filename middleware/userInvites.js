'use strict';
/* Middleware for inviting users to your webstrate */

const db = require(APP_PATH + '/helpers/database.js');
const crypto = require('crypto');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');

exports.admin = {
    /**
     * Checks if a user has admin permissions on a given webstrate.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {object} user The user to check.
     * @throws {Error} If the user does not have admin permissions.
     */
    checkIsAdmin: async (webstrateId, user) => {
        const currentUserPermissions = await permissionManager.getUserPermissions(user.username, user.provider, webstrateId);
        if (!currentUserPermissions.includes('a')) {
            throw new Error(`Need admin permissions to manage invites. User only has ${currentUserPermissions} on ${webstrateId}.`);
        }
    },

    /**
     * Creates a new invite key for the given webstrate with specified permissions and maximum lifetime.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {object} options Options including permissions and maxAge.
     * @param {object} user The user creating the invite.
     * @returns {Promise<object>} An object containing the new invite.
     */
    createInvite: async (webstrateId, options, user) => {
        await exports.admin.checkIsAdmin(webstrateId, user); // First, check if the user is an admin
        const inviteKey = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();
        const ageLimit = 3600 * 24 * 30; // One-month limit
        const maxAge = Math.min(options.maxAge, ageLimit);
        const invitePermissions = options.permissions;
        expiresAt.setSeconds(expiresAt.getSeconds() + maxAge);

        const inviteDocument = {
            key: inviteKey,
            webstrateId: webstrateId,
            permissions: invitePermissions,
            expiresAt: expiresAt,
            createdAt: new Date(),
            createdBy: {
                username: user.username,
                provider: user.provider
            }
        };

        await db.invites.insertOne(inviteDocument);
        return inviteDocument;
    },

    /**
     * Retrieves all active invites created by a specific user for a given webstrate.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {object} user The user who created the invites.
     * @returns {Promise<Array<object>>} A list of invite objects.
     */
    getInvites: async (webstrateId, user) => {
        await exports.admin.checkIsAdmin(webstrateId, user); // First, check if the user is an admin
        const invites = await db.invites.find({
            webstrateId: webstrateId,
            'createdBy.username': user.username,
            'createdBy.provider': user.provider,
        }).toArray();
        invites.forEach((invite) => {
            delete invite._id;
        });
        return invites;
    },

    /**
     * Deletes an invite by key, but only if it was created by the specified user.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {string} key The invite key to remove.
     * @param {object} user The user attempting to remove the invite.
     * @returns {Promise<object>} The result of the deletion.
     * @throws {Error} If the invite cannot be deleted.
     */
    removeInvite: async (webstrateId, key, user) => {
        await exports.admin.checkIsAdmin(webstrateId, user); // First, check if the user is an admin
        let result = await db.invites.deleteMany({
            webstrateId: webstrateId,
            key: key,
            'createdBy.username': user.username,
            'createdBy.provider': user.provider,
        });
        if (result.deletedCount !== 1) {
            throw new Error("Unable to delete invite");
        }
        return result;
    }
};

exports.invitee = {
    /**
     * Validates an invite key.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {string} key The invite key to check.
     * @returns {Promise<object>} The valid invite document.
     * @throws {Error} If the invite is invalid or the inviter is no longer an admin.
     */
    checkInvite: async (webstrateId, key) => {
        let invite = await db.invites.findOne({
            webstrateId: webstrateId,
            key: key,
        });
        if (!invite) {
            throw new Error("Invalid invitation key");
        }

        // Check if the inviting admin is still an admin
        const inviterPermissions = await permissionManager.getUserPermissions(
            invite.createdBy.username, invite.createdBy.provider, webstrateId);
        if (!inviterPermissions.includes('a')) {
            throw new Error("Inviter is no longer admin on the webstrate, invitation invalid");
        }

        return invite;
    },

    /**
     * Accepts an invitation, adding the current user to the webstrate with the granted permissions.
     * @param {string} webstrateId The ID of the webstrate.
     * @param {string} key The invite key to accept.
     * @param {object} user The user accepting the invite.
     * @returns {Promise<string>} The new permissions string for the user.
     */
    acceptInvite: async (webstrateId, key, user) => {
        const invite = await exports.invitee.checkInvite(webstrateId, key);
        const currentUserPermissions = await permissionManager.getUserPermissions(
            user.username, user.provider, webstrateId);

        // Update existing invitee permissions by merging with the granted permissions
        const newPermissions = [...new Set(currentUserPermissions + invite.permissions)].join('');
        await permissionManager.setUserPermissions(user.username, user.provider,
            newPermissions, webstrateId, `${invite.createdBy.username}:${invite.createdBy.provider}`);

        return newPermissions;
    }
};

exports.prepareAPIAccess = async (user)=>{
	// Ensure user is logged in
	if (!user || !user.provider) {
		throw new Error("Must be logged in to handle invites");
	}
	
	// Clean old invite entries
	await db.invites.deleteMany({
		expiresAt: {
			$lte: new Date()
		}
	});
}

// --- Middleware handler for websockets ---
exports.onmessage = async (ws, req, data, next) => {
    // Check if the requested action is for this module
    const actions = [...Object.keys(exports.invitee), ...Object.keys(exports.admin)];
    if (!data.wa || !actions.includes(data.wa)) return next();

    const webstrateId = data.d;
    const responseObj = {
        wa: 'reply',
        token: data.token
    };

    try {
		await exports.prepareAPIAccess(req.user);

        // Call the appropriate API function and send the response
        let result;
        switch (data.wa) {
            case 'createInvite':
                result = await exports.admin.createInvite(webstrateId, data.options, req.user);
                break;
            case 'getInvites':
                result = await exports.admin.getInvites(webstrateId, req.user);
                break;
            case 'removeInvite':
                result = await exports.admin.removeInvite(webstrateId, data.options.key, req.user);
                break;
            case 'checkInvite':
                result = await exports.invitee.checkInvite(webstrateId, data.options.key);
                break;
            case 'acceptInvite':
                result = await exports.invitee.acceptInvite(webstrateId, data.options.key, req.user);
                break;
            default:
                throw new Error("Unknown action");
        }

        return ws.send(JSON.stringify({ ...responseObj, reply: result}));
    } catch (ex) {
		console.log(ex);
        return ws.send(JSON.stringify({ ...responseObj, error: ex.message}));
    }
};