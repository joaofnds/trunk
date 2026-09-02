export interface AppConfig {
  appName: string;
  version: string;
  debug: boolean;
  maxRetries: number;
  locale: string;
  theme: "light" | "dark" | "auto";
}

export const defaultConfig: AppConfig = {
  appName: "Trunk Conflict",
  version: "2.0.0",
  debug: false,
  maxRetries: 3,
  locale: "en-US",
  theme: "auto",
};

export function mergeConfig(
  overrides: Partial<AppConfig>,
): AppConfig {
  return { ...defaultConfig, ...overrides };
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.appName) errors.push("appName is required");
  if (config.maxRetries < 0) errors.push("maxRetries must be non-negative");
  if (config.version && !/^\d+\.\d+\.\d+$/.test(config.version)) {
    errors.push("version must be semver format");
  }
  return errors;
}
