import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from './asyncHandler.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  clearAuthCookies,
  clearSessionCookie,
  createSession,
  destroySession,
  ensureCsrfCookie,
  pruneExpiredSessions,
  readBearer,
  resolveSession,
} from '../auth/session.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const authRouter = Router();

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters.')
  .max(40, 'Username must be 40 characters or fewer.')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Username may only contain letters, numbers, hyphens and underscores.');

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must be 254 characters or fewer.')
  .email('Enter a valid email address.');

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must be 128 characters or fewer.');

const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.').max(128, 'Password is 128 characters or fewer.'),
});

function publicUser(user: { id: string; username: string; email: string; createdAt: Date }) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function validationError(messages: string[]) {
  return { error: { code: 'VALIDATION_ERROR', message: messages.join(' ') } };
}

/** Registration and login share a tight per-IP budget to slow credential stuffing. */
const registerLimiter = rateLimit({ keyPrefix: 'auth:register', windowMs: 15 * 60_000, max: 30 });
const loginLimiter = rateLimit({
  keyPrefix: 'auth:login',
  windowMs: 15 * 60_000,
  max: 10,
  key: (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''),
});

/**
 * Issue a readable CSRF token. The SPA calls this before its first mutation and
 * echoes the value in the X-CSRF-Token header.
 */
authRouter.get('/csrf', (req, res) => {
  const csrfToken = ensureCsrfCookie(req, res);
  res.json({ data: { csrfToken } });
});

authRouter.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(validationError(parsed.error.errors.map((error) => error.message)));
  }

  const { username, email, password } = parsed.data;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true, username: true },
  });
  if (existing) {
    if (existing.email === email) {
      return res.status(409).json({
        error: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists. Try signing in instead.' },
      });
    }
    return res.status(409).json({
      error: { code: 'USERNAME_TAKEN', message: 'That username is already taken. Please choose another.' },
    });
  }

  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.user.create({
      data: { username, email, passwordHash },
      select: { id: true, username: true, email: true, createdAt: true },
    });

    await pruneExpiredSessions(user.id);
    const session = await createSession(user.id);
    // The token is returned to the tab and stored in its sessionStorage. It is
    // never placed in a cookie because cookies are shared by all tabs.
    clearSessionCookie(res);
    ensureCsrfCookie(req, res);

    return res.status(201).json({
      data: {
        user: publicUser(user),
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    // A concurrent registration can win the unique check between our lookup and
    // insert. Map it to the same friendly response instead of a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(',') : String(error.meta?.target ?? '');
      if (target.includes('email')) {
        return res.status(409).json({
          error: { code: 'EMAIL_TAKEN', message: 'An account with that email already exists. Try signing in instead.' },
        });
      }
      return res.status(409).json({
        error: { code: 'USERNAME_TAKEN', message: 'That username is already taken. Please choose another.' },
      });
    }
    throw error;
  }
}));

authRouter.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(validationError(parsed.error.errors.map((error) => error.message)));
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true, email: true, createdAt: true, passwordHash: true },
  });

  // Always perform one Argon2 verification so response timing does not reveal
  // whether the email exists.
  const valid = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
  if (!user || !valid) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password. Please try again.' },
    });
  }

  await pruneExpiredSessions(user.id);
  const session = await createSession(user.id);
  clearSessionCookie(res);
  ensureCsrfCookie(req, res);

  return res.json({
    data: {
      user: publicUser(user),
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    },
  });
}));

/**
 * Logout is intentionally idempotent: it clears cookies even if the session has
 * already expired, and never reveals whether a session existed.
 */
authRouter.post('/logout', asyncHandler(async (req, res) => {
  // Only the caller's own bearer session is destroyed. Sessions belonging to
  // another tab or browser are untouched.
  const token = readBearer(req);
  if (token) {
    const session = await resolveSession(token);
    if (session) await destroySession(session.id);
  }
  clearAuthCookies(res);
  return res.status(204).end();
}));

authRouter.get('/me', requireAuth, (req, res) => {
  return res.json({ data: { user: publicUser(req.auth!.user) } });
});
