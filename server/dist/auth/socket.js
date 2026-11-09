import { env } from '../config/env.js';
import { readBearerToken, resolveSession } from './session.js';
// A Socket.IO server may be shared by several feature modules (collaboration,
// chat, ...). Authentication must only be installed once per server.
const configuredServers = new WeakSet();
/**
 * Authenticate every Socket.IO connection with the per-tab bearer token sent in
 * the handshake `auth` payload (or an Authorization header for non-browser
 * clients). Each tab opens its own socket, so identities never bleed between
 * tabs. The handshake never accepts a user ID or project role from the client.
 */
export function applySocketAuthentication(io) {
    if (configuredServers.has(io))
        return;
    configuredServers.add(io);
    io.use((socket, next) => {
        void (async () => {
            try {
                const origin = socket.handshake.headers.origin;
                if (origin && origin !== env.CLIENT_ORIGIN) {
                    next(new Error('INVALID_ORIGIN'));
                    return;
                }
                const handshakeAuth = socket.handshake.auth;
                const token = typeof handshakeAuth?.token === 'string' && handshakeAuth.token.length > 0
                    ? handshakeAuth.token
                    : readBearerToken(socket.handshake.headers.authorization);
                if (!token) {
                    next(new Error('UNAUTHENTICATED'));
                    return;
                }
                const session = await resolveSession(token);
                if (!session) {
                    next(new Error('SESSION_EXPIRED'));
                    return;
                }
                const data = socket.data;
                data.user = { id: session.user.id, username: session.user.username };
                data.sessionId = session.id;
                data.sessionExpiresAt = session.expiresAt.getTime();
                next();
            }
            catch {
                next(new Error('AUTH_FAILED'));
            }
        })();
    });
}
export function socketAuthData(socket) {
    return socket.data.user
        ? socket.data
        : null;
}
