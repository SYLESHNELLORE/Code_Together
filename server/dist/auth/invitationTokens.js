import { createHash, randomBytes } from 'node:crypto';
/** 32 random bytes encoded as URL-safe text (~43 characters). */
export function createInvitationToken() {
    return randomBytes(32).toString('base64url');
}
/**
 * Invitation tokens are bearer secrets, so only their SHA-256 digest is stored.
 * Hex SHA-256 is exactly 64 characters, keeping the unique index and MySQL
 * VARCHAR bound small.
 */
export function hashInvitationToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
