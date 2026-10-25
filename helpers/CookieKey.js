'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The session cookie is protected by two keys — a 64-byte HMAC-SHA512 signature key and a
// 32-byte AES-256 encryption key — that live in their own key file rather than in the
// configuration: the server generates them itself when no key file exists, the keys stay
// out of the configuration files that are shared between setups, and a container deployment
// can mount the key directory so that the keys survive restarts and image rebuilds. The key
// file holds one JSON object with both keys in lowercase hex:
//   { "signatureKey": "<128 hex chars>", "encryptionKey": "<64 hex chars>" }
// By default the file is read from <repo>/keys/cookie.key (the keys directory is created
// along with the file if needed); the WEBSTRATES_COOKIE_KEY_FILE environment variable
// points the server at another location, absolute or relative to the repo root (the
// docker-compose configuration uses it to map the key into the container).
const cookieKeyPath = () => {
	const envKeyPath = process.env.WEBSTRATES_COOKIE_KEY_FILE;
	if (envKeyPath) {
		return path.isAbsolute(envKeyPath) ? envKeyPath : path.resolve(APP_PATH, envKeyPath);
	}
	return path.join(APP_PATH, 'keys', 'cookie.key');
};

// The signature key is 512 bits of key material (the HMAC-SHA512 minimum), the encryption
// key 256 bits (AES-256 takes exactly that many key bits).
const SIGNATURE_KEY_BYTES = 64;
const ENCRYPTION_KEY_BYTES = 32;

const isHexOfLength = (value, bytes) =>
	typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);

// An Error marked invalidKeyFile describes a key file whose content (or very existence as
// a file) is not what it must be — the caller reports those loudly and specifically.
const invalidKeyFileError = (message) => {
	const err = new Error(message);
	err.invalidKeyFile = true;
	return err;
};

// Read the key file's content and its permission mode, treating an empty file as invalid.
// The file is opened without blocking and its type checked with fstat on the open
// descriptor, so that the type check, the read, and the permission mode all refer to the
// same file: opening a FIFO would otherwise block forever (the server would hang at boot
// instead of reporting the problem), and separate stat and read calls could each see a
// different file at the same path.
const readKeyFile = (keyPath) => {
	const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stats = fs.fstatSync(fd);
		if (!stats.isFile()) {
			throw invalidKeyFileError('the key file is not a regular file');
		}
		const raw = fs.readFileSync(fd, 'utf8').trim();
		if (!raw) {
			throw invalidKeyFileError('the key file exists but is empty');
		}
		return { raw, mode: stats.mode & 0o777 };
	} finally {
		fs.closeSync(fd);
	}
};

// Parse and validate the contents of a key file: anything that is not exactly the expected
// JSON object is invalid.
const parseKeyFile = (raw) => {
	let keyObject;
	try {
		keyObject = JSON.parse(raw);
	} catch (err) {
		throw invalidKeyFileError(`not valid JSON (${err.message})`);
	}
	if (keyObject === null || typeof keyObject !== 'object' || Array.isArray(keyObject)) {
		throw invalidKeyFileError('the file must hold a JSON object');
	}

	const problems = [];
	if (!isHexOfLength(keyObject.signatureKey, SIGNATURE_KEY_BYTES)) {
		problems.push(`signatureKey must be ${SIGNATURE_KEY_BYTES} bytes in hex ` +
			`(${SIGNATURE_KEY_BYTES * 2} hex characters)`);
	}
	if (!isHexOfLength(keyObject.encryptionKey, ENCRYPTION_KEY_BYTES)) {
		problems.push(`encryptionKey must be ${ENCRYPTION_KEY_BYTES} bytes in hex ` +
			`(${ENCRYPTION_KEY_BYTES * 2} hex characters)`);
	}
	if (problems.length > 0) {
		throw invalidKeyFileError(problems.join('; '));
	}
	return keyObject;
};

// Bring a key file into existence atomically: the keys are written to a temporary file that
// is then hard-linked into place. The link only succeeds when the key file does not exist
// yet, and the instant the file exists it is complete — a process that loses a generation
// race can simply read the winner's keys, with no window in which the file exists
// half-written. (A temporary file left behind by a crash is harmless, and so is a failed
// attempt to remove one.)
const installKeyFile = (keyPath, keyFileContents) => {
	const tmpPath = `${keyPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
	fs.writeFileSync(tmpPath, keyFileContents, { mode: 0o600, flag: 'wx' });
	try {
		fs.linkSync(tmpPath, keyPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch (cleanupError) {
			// A failed cleanup must not mask what actually went wrong.
			err.cleanupError = cleanupError;
		}
		throw err;
	}
	try {
		fs.unlinkSync(tmpPath);
	} catch (err) {
		// The temporary file only carried the content into the link; leaving it behind is
		// harmless, so a failed removal must not stop the server.
		console.warn('Could not remove temporary cookie key file:', err);
	}
};

/**
 * Read the session cookie keys from the key file, generating and storing cryptographically
 * random keys if the file does not exist yet. A key file that exists but does not hold the
 * expected keys — empty, unreadable, malformed — is a hard error: regenerating would
 * silently invalidate every outstanding session cookie, so the server reports the problem
 * and exits, and the operator can fix the file or remove it deliberately.
 * @return {{signatureKey: Buffer, encryptionKey: Buffer}} The session cookie keys.
 */
exports.getCookieKeys = () => {
	const keyPath = cookieKeyPath();
	let keyObject;
	try {
		if (fs.existsSync(keyPath)) {
			const { raw, mode } = readKeyFile(keyPath);
			keyObject = parseKeyFile(raw);
			// The file's permissions decide who else can read (and therefore forge session
			// cookies with) the keys, so loose ones are worth a warning even when the
			// content is fine.
			if (mode & 0o077) {
				console.warn(`Warning: the cookie key file ${keyPath} is accessible ` +
					`beyond its owner (mode ${mode.toString(8)}); restrict it with ` +
					'chmod 600.');
			}
		}

		if (!keyObject) {
			fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
			const generated = {
				signatureKey: crypto.randomBytes(SIGNATURE_KEY_BYTES).toString('hex'),
				encryptionKey: crypto.randomBytes(ENCRYPTION_KEY_BYTES).toString('hex')
			};
			const keyFileContents = `${JSON.stringify(generated, null, '\t')}\n`;
			try {
				installKeyFile(keyPath, keyFileContents);
				keyObject = generated;
				console.warn(`No cookie key file present, generating one now (${keyPath})`);
			} catch (err) {
				if (err.code !== 'EEXIST') {
					throw err;
				}
				// The file appeared between the initial check and the install: another
				// process brought a complete key file into existence, so its keys are used —
				// every process sharing the key file ends up with the same keys. The file is
				// read before this is announced, so that a path which is not a complete key
				// file (a symlink to a missing target, say) surfaces its real problem
				// instead of being reported as a concurrent creation.
				keyObject = parseKeyFile(readKeyFile(keyPath).raw);
				console.warn('Cookie key file was created concurrently, using it.');
			}
			// Permissions are enforced explicitly rather than left to the creation mode
			// alone, which a restrictive umask can mask down. A filesystem that refuses the
			// change must not stop the server over an otherwise working key file: loose
			// permissions are warned about on the next boot as well.
			try {
				fs.chmodSync(keyPath, 0o600);
			} catch (err) {
				console.warn('Could not restrict cookie key file permissions:', err);
			}
		}
	} catch (err) {
		if (err.invalidKeyFile) {
			console.error(`Invalid cookie key file (${keyPath}): ${err.message}`);
			console.error('The key file must hold a JSON object with a "signatureKey" of 64 ' +
				'bytes and an "encryptionKey" of 32 bytes, both in lowercase hex. Remove the ' +
				'file to have the server generate a new one; this invalidates all outstanding ' +
				'session cookies.');
		} else {
			console.error(`Unable to read or create the cookie key file (${keyPath}):`, err);
		}
		process.exit(1);
	}

	return {
		signatureKey: Buffer.from(keyObject.signatureKey, 'hex'),
		encryptionKey: Buffer.from(keyObject.encryptionKey, 'hex')
	};
};
