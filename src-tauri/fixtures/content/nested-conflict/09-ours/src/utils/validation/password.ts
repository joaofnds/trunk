export interface PasswordStrength {
  score: number;
  feedback: string[];
}

const WEAK_PASSWORDS = ["password", "123456789", "qwerty", "admin123", "letmein1"];

export function validatePassword(password: string): PasswordStrength {
  const feedback: string[] = [];
  let score = 0;

  if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
    return { score: 0, feedback: ["This password is too common"] };
  }

  if (password.length >= 8) score++;
  else feedback.push("Must be at least 8 characters");

  if (password.length >= 14) score += 2;
  else if (password.length >= 10) score++;

  if (/[A-Z]/.test(password)) score++;
  else feedback.push("Add an uppercase letter");

  if (/[a-z]/.test(password)) score++;
  else feedback.push("Add a lowercase letter");

  if (/\d/.test(password)) score++;
  else feedback.push("Add a number");

  if (/[!@#$%^&*()_+\-=\[\]{};:'",.<>?/\\|`~]/.test(password)) score++;
  else feedback.push("Add a special character");

  return { score, feedback };
}

export function isPasswordStrong(password: string): boolean {
  return validatePassword(password).score >= 4;
}
