export interface AppConfig {
  appName: string;
  version: string;
  environment: "development" | "staging" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  timeout: number;
  locale: string;
}

export const defaultConfig: AppConfig = {
  appName: "Trunk Conflict",
  version: "2.0.0-beta",
  environment: "development",
  logLevel: "debug",
  timeout: 10000,
  locale: "en",
};

export function mergeConfig(
  base: AppConfig,
  overrides: Partial<AppConfig>,
): AppConfig {
  return { ...base, ...overrides };
}

export function isProduction(config: AppConfig): boolean {
  return config.environment === "production";
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.appName) errors.push("appName is required");
  if (config.timeout <= 0) errors.push("timeout must be positive");
  if (!["development", "staging", "production"].includes(config.environment)) {
    errors.push("invalid environment");
  }
  return errors;
}
