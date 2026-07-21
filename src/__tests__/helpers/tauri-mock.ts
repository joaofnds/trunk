import { vi } from "vitest";

// Mock @tauri-apps/api/core — the invoke function
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/plugin-dialog — open, ask, message
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	ask: vi.fn().mockResolvedValue(false),
	message: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/plugin-clipboard-manager — writeText
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/api/path — homeDir
vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

// Mock @tauri-apps/api/event — listen
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

// Mock @tauri-apps/api/window — getCurrentWindow
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		onResized: vi.fn().mockResolvedValue(() => {}),
		onMoved: vi.fn().mockResolvedValue(() => {}),
		isMaximized: vi.fn().mockResolvedValue(false),
		isFullscreen: vi.fn().mockResolvedValue(false),
	}),
}));

// Mock @tauri-apps/api/menu — Menu, MenuItem, CheckMenuItem, Submenu
vi.mock("@tauri-apps/api/menu", () => ({
	Menu: {
		new: vi.fn().mockResolvedValue({
			popup: vi.fn().mockResolvedValue(undefined),
		}),
	},
	MenuItem: {
		new: vi.fn().mockResolvedValue({}),
	},
	CheckMenuItem: {
		new: vi.fn().mockResolvedValue({}),
	},
	Submenu: {
		new: vi.fn().mockResolvedValue({}),
	},
}));

// Mock @tauri-apps/plugin-window-state — empty module
vi.mock("@tauri-apps/plugin-window-state", () => ({}));
