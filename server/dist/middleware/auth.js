import { env } from '../config/env.js';
import { CSRF_COOKIE, CSRF_HEADER, clearSessionCookie, constantTimeEqual, readBearer, readCookie, resolveSession, touchSession, } from '../auth/session.js';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Resolve the per-tab bearer token into `req.auth`. User identity always comes
 * from the database row, never from client-supplied user IDs or body fields.
 * Cookies are deliberately ignored: a shared cookie would let one tab replace
 * another tab's identity.
 */
export const requireAuth = (req, res, next) => {
    void (async () => {
        const token = readBearer(req);
        if (!token) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' } });
            return;
        }
        const session = await resolveSession(token);
        if (!session) {
            // Clear a legacy shared cookie if one is still present, but never use it
            // as an authentication source.
            clearSessionCookie(res);
            res.status(401).json({
                error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' },
            });
            return;
        }
        // Sliding expiration is persisted in MySQL. The token itself never needs to
        // be refreshed or written to a shared cookie.
        await touchSession(session);
        req.auth = {
            sessionId: session.id,
            user: session.user,
        };
        next();
    })().catch(next);
};
/**
 * Cross-site request forgery defence for mutations authenticated by a per-tab
 * bearer token. Compares the readable CSRF cookie with the X-CSRF-Token header.
 * The CSRF cookie is not an identity source.
 */
export const csrfProtection = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
        next();
        return;
    }
    const cookie = readCookie(req, CSRF_COOKIE);
    const header = req.get(CSRF_HEADER);
    if (!cookie || !header || !constantTimeEqual(cookie, header)) {
        res.status(403).json({
            error: { code: 'CSRF_INVALID', message: 'Security token missing or invalid. Refresh the page and try again.' },
        });
        return;
    }
    next();
};
/** Reject state-changing requests that explicitly come from another origin. */
export const originProtection = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
        next();
        return;
    }
    const origin = req.get('origin');
    if (origin && origin !== env.CLIENT_ORIGIN) {
        res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } });
        return;
    }
    next();
};
