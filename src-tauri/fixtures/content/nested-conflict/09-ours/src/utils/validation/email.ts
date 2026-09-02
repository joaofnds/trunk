const STRICT_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const BLOCKED_DOMAINS = ["spam.com", "fake.org", "trash-mail.com"];

export function validateEmail(email: string): boolean {
  return STRICT_EMAIL_REGEX.test(email);
}

export function isBlockedEmail(email: string): boolean {
  const domain = getDomain(email);
  return domain !== null && BLOCKED_DOMAINS.includes(domain);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getDomain(email: string): string | null {
  if (!validateEmail(email)) return null;
  return email.split("@")[1];
}

export function getLocalPart(email: string): string | null {
  if (!validateEmail(email)) return null;
  return email.split("@")[0];
}
