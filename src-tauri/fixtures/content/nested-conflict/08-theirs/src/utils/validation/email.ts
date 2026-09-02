const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const DISPOSABLE_DOMAINS = ["tempmail.com", "throwaway.email", "guerrillamail.com", "mailinator.com"];

export function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export function isDisposableEmail(email: string): boolean {
  const domain = getDomain(email);
  return domain !== null && DISPOSABLE_DOMAINS.includes(domain);
}

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const [local, domain] = trimmed.split("@");
  // Remove dots and plus aliases from local part for Gmail-style normalization
  const normalizedLocal = local.split("+")[0].replace(/\./g, "");
  return `${normalizedLocal}@${domain}`;
}

export function getDomain(email: string): string | null {
  if (!validateEmail(email)) return null;
  return email.split("@")[1].toLowerCase();
}
