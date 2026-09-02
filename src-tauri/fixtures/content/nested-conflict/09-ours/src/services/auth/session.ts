export interface Session {
  userId: string;
  token: string;
  expiresAt: Date;
  refreshToken: string;
  createdAt: Date;
  ipAddress: string;
}

const TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutes

export function createSession(userId: string, ipAddress: string): Session {
  const now = new Date();
  return {
    userId,
    token: generateToken(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    refreshToken: generateToken(),
    createdAt: now,
    ipAddress,
  };
}

export function isSessionValid(session: Session): boolean {
  return new Date() < session.expiresAt;
}

export function revokeSession(_session: Session): void {
  // In a real app, this would invalidate the token server-side
}

export function refreshSession(session: Session): Session {
  if (!isSessionValid(session)) {
    throw new Error("Session has expired. Please log in again.");
  }
  return createSession(session.userId, session.ipAddress);
}

function generateToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
