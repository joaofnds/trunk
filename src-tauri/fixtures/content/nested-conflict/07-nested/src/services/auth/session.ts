export interface Session {
  userId: string;
  token: string;
  expiresAt: Date;
  refreshToken: string;
}

export function createSession(userId: string): Session {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
  return {
    userId,
    token: generateToken(),
    expiresAt,
    refreshToken: generateToken(),
  };
}

export function isSessionValid(session: Session): boolean {
  return new Date() < session.expiresAt;
}

export function refreshSession(session: Session): Session {
  if (!isSessionValid(session)) {
    throw new Error("Cannot refresh expired session");
  }
  return createSession(session.userId);
}

function generateToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
