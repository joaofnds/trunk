import { invoke } from "@tauri-apps/api/core";

// Tauri IPC errors arrive as raw strings, not Error objects.
// catch(e) { e.message } returns undefined — this wrapper fixes that.
export interface TrunkError {
  code: string;
  message: string;
}

export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e: unknown) {
    let parsed: TrunkError;
    try {
      parsed = JSON.parse(e as string) as TrunkError;
    } catch {
      parsed = {
        code: "unknown_error",
        message: typeof e === "string" ? e : "An unexpected error occurred",
      };
    }
    throw parsed;
  }
}
