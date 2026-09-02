export interface Session {
  userId: string;
  token: string;
  expiresAt: Date;
  refreshToken: string;
  lastActivity: Date;
  deviceId: string;
}

const SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function createSession(userId: string, deviceId: string): Session {
  const now = new Date();
  return {
    userId,
    token: generateToken(),
    expiresAt: new Date(now.getTime() + SESSION_DURATION_MS),
    refreshToken: generateToken(),
    lastActivity: now,
    deviceId,
  };
}

export function isSessionValid(session: Session): boolean {
  const now = new Date();
  if (now >= session.expiresAt) return false;
  const idleTime = now.getTime() - session.lastActivity.getTime();
  return idleTime < IDLE_TIMEOUT_MS;
}

export function touchSession(session: Session): Session {
  return { ...session, lastActivity: new Date() };
}

export function refreshSession(session: Session): Session {
  if (!isSessionValid(session)) {
    throw new Error("Cannot refresh expired session");
  }
  return createSession(session.userId, session.deviceId);
}

function generateToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
