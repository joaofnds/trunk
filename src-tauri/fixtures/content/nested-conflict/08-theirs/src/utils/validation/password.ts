export interface PasswordStrength {
  score: number;
  feedback: string[];
}

const COMMON_PASSWORDS = ["password", "12345678", "qwerty123", "letmein", "welcome1"];

export function validatePassword(password: string): PasswordStrength {
  const feedback: string[] = [];
  let score = 0;

  if (password.length >= 8) score++;
  else feedback.push("Must be at least 8 characters");

  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  if (/[A-Z]/.test(password)) score++;
  else feedback.push("Add an uppercase letter");

  if (/[a-z]/.test(password)) score++;
  else feedback.push("Add a lowercase letter");

  if (/[0-9]/.test(password)) score++;
  else feedback.push("Add a number");

  if (/[^A-Za-z0-9]/.test(password)) score++;
  else feedback.push("Add a special character");

  if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
    score = 0;
    feedback.unshift("This is a commonly used password");
  }

  return { score, feedback };
}

export function isPasswordStrong(password: string): boolean {
  return validatePassword(password).score >= 4;
}
