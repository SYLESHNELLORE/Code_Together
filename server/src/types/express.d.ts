import type { AuthUser } from '../auth/types.js';
import type { ProjectAccess } from '../middleware/projectAccess.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `requireAuth` middleware only. */
      auth?: {
        sessionId: string;
        user: AuthUser;
      };
      /** Populated by `requireProjectRole` after a successful role check. */
      projectAccess?: ProjectAccess;
    }
  }
}

export {};
