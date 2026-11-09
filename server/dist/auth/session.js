import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
/**
 * Legacy cookie name. Session authentication now travels in the per-tab
 * Authorization header; the cookie is only cleared when an older browser still
 * carries one so it can never be mistaken for an identity source.
 */
export const SESSION_COOKIE = 'ct_session';
export const CSRF_COOKIE = 'ct_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_TTL_MS = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Opaque session identifiers are stored hashed, never in plain text. */
function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
function newToken() {
    return randomBytes(32).toString('base64url');
}
function baseCookieOptions() {
    return {
        httpOnly: true,
        // SameSite=Lax blocks cross-site form/XHR cookie sends. CSRF tokens add a
        // second, explicit layer for state-changing requests.
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: '/',
    };
}
export function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, baseCookieOptions());
}
export function setCsrfCookie(res, token) {
    res.cookie(CSRF_COOKIE, token, {
        // Readable by the SPA so it can echo it in the X-CSRF-Token header.
        ...baseCookieOptions(),
        httpOnly: false,
        maxAge: SESSION_TTL_MS,
    });
}
export function clearAuthCookies(res) {
    clearSessionCookie(res);
    res.clearCookie(CSRF_COOKIE, { ...baseCookieOptions(), httpOnly: false });
}
/** Parse a cookie from a raw `Cookie` header (HTTP requests and Socket.IO handshakes). */
export function readCookieHeader(header, name) {
    if (!header)
        return null;
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0)
            continue;
        if (part.slice(0, separator).trim() !== name)
            continue;
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        }
        catch {
            return null;
        }
    }
    return null;
}
export function readCookie(req, name) {
    return readCookieHeader(req.headers.cookie, name);
}
/**
 * Read an opaque session token from an `Authorization: Bearer <token>` header.
 * Each browser tab sends the token from its own sessionStorage, so two tabs can
 * safely authenticate as different users on the same origin.
 */
export function readBearerToken(header) {
    if (!header)
        return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match?.[1] ?? null;
}
export function readBearer(req) {
    return readBearerToken(req.headers.authorization);
}
/** Return the existing CSRF token or issue a fresh readable one. */
export function ensureCsrfCookie(req, res) {
    const existing = readCookie(req, CSRF_COOKIE);
    if (existing)
        return existing;
    const token = newToken();
    setCsrfCookie(res, token);
    return token;
}
export function constantTimeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
export async function createSession(userId) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({
        data: {
            tokenHash: hashToken(token),
            userId,
            expiresAt,
        },
    });
    return { token, expiresAt };
}
export async function resolveSession(token) {
    const session = await prisma.session.findUnique({
        where: { tokenHash: hashToken(token) },
        include: {
            user: {
                select: { id: true, username: true, email: true, createdAt: true },
            },
        },
    });
    if (!session)
        return null;
    if (session.expiresAt.getTime() <= Date.now()) {
        await prisma.session.deleteMany({ where: { id: session.id } });
        return null;
    }
    return { id: session.id, expiresAt: session.expiresAt, user: session.user };
}
/**
 * Sliding expiration: extend sessions that are more than halfway to expiry and
 * report the new expiry to the caller. The token itself never changes.
 */
export async function touchSession(session) {
    if (session.expiresAt.getTime() - Date.now() > SESSION_TTL_MS / 2) {
        return session.expiresAt;
    }
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
    return expiresAt;
}
export async function destroySession(sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
}
export async function pruneExpiredSessions(userId) {
    await prisma.session.deleteMany({
        where: { userId, expiresAt: { lte: new Date() } },
    });
}
