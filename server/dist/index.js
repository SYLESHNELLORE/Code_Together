import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { app } from './app.js';
import { env } from './config/env.js';
import { attachCollaboration, shutdownCollaboration } from './collab/index.js';
import { attachChat, shutdownChat } from './chat/index.js';
import { executionCapabilities, recoverInterruptedExecutions, shutdownExecutions, } from './execution/service.js';
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
    // Yjs updates are binary and can approach the size of a 1 MB file after
    // encoding. Leave headroom above the file limit.
    maxHttpBufferSize: 2e6,
});
// Collaboration sockets authenticate with each tab's bearer token and authorize
// every project/file room before any document data is exchanged.
attachCollaboration(io);
// Project chat shares the same authenticated Socket.IO server.
attachChat(io);
async function start() {
    // Execution jobs cannot survive a restart: their sandbox handle lived only
    // in this process. Fail the stale rows and release the unique active slot.
    try {
        await recoverInterruptedExecutions();
    }
    catch (error) {
        console.error('Failed to recover interrupted executions:', error);
    }
    httpServer.listen(env.PORT, () => {
        console.log(`CodeTogether API listening on http://localhost:${env.PORT}`);
        // Report sandbox readiness once at startup so a missing runner, stopped
        // Docker daemon or missing image is visible in the server log without
        // opening the UI. This never blocks listening.
        void executionCapabilities()
            .then((capabilities) => {
            if (capabilities.enabled) {
                console.log(`[execution] sandbox ready (runner=${capabilities.runner}, image=${env.EXECUTION_SANDBOX_IMAGE})`);
            }
            else {
                console.warn(`[execution] sandbox unavailable: ${capabilities.reason}`);
            }
        })
            .catch((error) => {
            console.warn('[execution] could not check sandbox status:', error);
        });
    });
}
void start();
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    // Flush live Yjs documents before closing sockets so in-flight edits are not
    // lost when the process is restarted.
    try {
        await shutdownCollaboration();
    }
    catch (error) {
        console.error('Failed to flush collaboration documents on shutdown:', error);
    }
    shutdownChat();
    // Kill any sandbox containers and release their active-job slots so a
    // restarted instance is not blocked by a job from the previous process.
    try {
        await shutdownExecutions();
    }
    catch (error) {
        console.error('Failed to stop running executions during shutdown:', error);
    }
    io.close();
    httpServer.close(() => process.exit(0));
    // Do not wait forever for keep-alive connections to drain.
    setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
