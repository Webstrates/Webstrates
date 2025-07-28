'use strict';
/* Middleware for inviting users to your webstrate */

const db = require(APP_PATH + '/helpers/database.js');
const crypto = require('crypto');
const permissionManager = require(APP_PATH + '/helpers/PermissionManager.js');

exports.onmessage = async (ws, req, data, next) => {
	const adminAPI = {
		createInvite: async ()=>{
			const inviteKey = crypto.randomBytes(32).toString('hex'); // Generate a random hex key
			const expiresAt = new Date();
			const maxAge = 3600; // STUB: limit range, use data.options.maxAge
			const invitePermissions = data.options.permissions;
			expiresAt.setSeconds(expiresAt.getSeconds() + maxAge); // Set expiration X days from now
			
			const inviteDocument = {
				key: inviteKey,
				webstrateId: webstrateId,
				permissions: invitePermissions,
				expiresAt: expiresAt,
				createdAt: new Date(),
				createdBy: {username: req.user.username, provider: req.user.provider}
			};
			
			await db.invites.insertOne(inviteDocument);
			return inviteDocument;			
		},
		getInvites: async ()=>{
			return await db.invites.find({
				webstrateId: webstrateId,
				'createdBy.username': req.user.username,
				'createdBy.provider': req.user.provider,
			}).toArray();
		},
		removeInvite: async ()=>{
			let result = await db.invites.deleteMany({
				webstrateId: webstrateId,
				key: data.options.key,
				'createdBy.username': req.user.username,
				'createdBy.provider': req.user.provider,
			});
			if (result.deletedCount!=1) throw new Error("Unable to delete invite");
			return result;
		}		
	}

	// Check if request is for this module
	if ((!data.wa)||!Object.keys(adminAPI).includes(data.wa)) return next();

	// Expire all out-of-date invites
	const deleteResult = await db.invites.deleteMany({
		expiresAt: {
			$lte: new Date()
		}
	});	

	// Check admin user 
	const webstrateId = data.d;
	const permissions = await permissionManager.getUserPermissions(req.user.username, req.user.provider,
		webstrateId);
	if (!permissions.includes('a')) return ws.send(JSON.stringify({...responseObj,
		error: 'Need admin permissions to handle invites'
	}));

	// Send reply
	const responseObj = {
		wa: 'reply',
		token: data.token
	}
	return ws.send(JSON.stringify({...responseObj,
		reply: await adminAPI[data.wa]()
	}));
};