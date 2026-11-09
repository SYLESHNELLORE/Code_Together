export interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: AuthUser;
  expiresAt: Date;
}
