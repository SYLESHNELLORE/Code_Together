import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Prisma } from '@prisma/client';
import { env } from './config/env.js';
import { authRouter } from './routes/auth.js';
import { projectRouter } from './routes/projects.js';
import { projectFilesRouter } from './routes/projectFiles.js';
import { projectMembersRouter } from './routes/projectMembers.js';
import { projectInvitationsRouter } from './routes/projectInvitations.js';
import { invitationRouter } from './routes/invitations.js';
import { projectChatRouter } from './routes/projectChat.js';
import { projectExecutionsRouter } from './routes/projectExecutions.js';
import { ensureCsrfCookie } from './auth/session.js';
import { csrfProtection, originProtection, requireAuth } from './middleware/auth.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
// A single file is limited to 1 MB of UTF-8 content; leave headroom for JSON
// escaping and the rest of the request body.
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'codetogether-api', timestamp: new Date().toISOString() });
});

// Every API response may establish the readable CSRF cookie. Mutations must
// send it back in the X-CSRF-Token header (double-submit cookie pattern).
app.use('/api', (req, res, next) => {
  ensureCsrfCookie(req, res);
  next();
});
app.use('/api', originProtection, csrfProtection);

app.use('/api/auth', authRouter);

// Project, member, invitation and file data is private: authentication is
// required for every request, and each route additionally enforces a project
// role through the `requireProjectRole` middleware.
app.use('/api/projects', requireAuth, projectRouter, projectMembersRouter, projectInvitationsRouter);
app.use('/api/invitations', requireAuth, invitationRouter);
app.use('/api', requireAuth, projectFilesRouter, projectChatRouter, projectExecutionsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Malformed JSON bodies are a client error, not a server error.
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with those unique values already exists.' } });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested record was not found.' } });
    }
    if (error.code === 'P2003') {
      return res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'A related record does not exist.' } });
    }
    console.error('[api-error:prisma]', error.code, error.meta);
    return res.status(500).json({ error: { code: 'DATABASE_ERROR', message: 'A database error occurred.' } });
  }

  console.error('[api-error]', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
});
