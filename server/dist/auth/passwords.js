import { hash, verify } from '@node-rs/argon2';
/**
 * Argon2id with the OWASP-recommended minimum profile
 * (19 MiB memory, 2 iterations, 1 lane).
 */
const ARGON2_OPTIONS = {
    algorithm: 2 /* Algorithm.Argon2id */,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
};
export function hashPassword(password) {
    return hash(password, ARGON2_OPTIONS);
}
export async function verifyPassword(passwordHash, password) {
    try {
        return await verify(passwordHash, password);
    }
    catch {
        // Malformed/unknown hashes must never authenticate a request.
        return false;
    }
}
/**
 * Verified against when the email does not exist, so a missing account and a
 * wrong password cost roughly the same amount of time.
 */
export const DUMMY_PASSWORD_HASH = await hash('codetogether-dummy-password', ARGON2_OPTIONS);
