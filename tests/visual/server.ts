import { join } from "node:path";
import {
	createServer,
	loadConfigFromFile,
	type PluginOption,
	type ViteDevServer,
} from "vite";

export const ROOT = join(import.meta.dirname, "../..");
export const PAGE = "/tests/visual/page/index.html";
export const CATALOG_PAGE = "/tests/visual/page/catalog.html";

/** Sets up vitest's DOM tests, and inside any vitest process it empties Vite's
 *  browser resolve conditions, so the page would load Svelte's server build. */
const UNIT_TEST_PLUGIN = "vite-plugin-svelte-testing-library";

/** The run's one page server. A server per test file would give each its own
 *  dependency optimizer over the one cache directory, and a server that found
 *  the cache mid-rewrite deletes it under the pages the others are loading. */
export async function serve(): Promise<ViteDevServer> {
	const app = await loadConfigFromFile(
		{ command: "serve", mode: "development" },
		join(ROOT, "vite.config.ts"),
	);
	if (app === null) throw new Error("vite.config.ts did not load");
	const plugins = app.config.plugins ?? [];
	const served = plugins.filter((plugin) => !named(plugin, UNIT_TEST_PLUGIN));
	if (served.length === plugins.length)
		throw new Error(
			`vite.config.ts no longer lists ${UNIT_TEST_PLUGIN}: serve its plugins unfiltered`,
		);

	const server = await createServer({
		...app.config,
		plugins: served,
		configFile: false,
		root: ROOT,
		cacheDir: join(ROOT, "node_modules/.vite-visual"),
		// Keep optimized module URLs stable while tests open lazy views.
		optimizeDeps: { noDiscovery: true },
		logLevel: "error",
		server: {
			host: "127.0.0.1",
			port: 0,
			hmr: false,
			watch: null,
			headers: { "Cache-Control": "max-age=3600" },
			warmup: { clientFiles: [PAGE.slice(1), CATALOG_PAGE.slice(1)] },
		},
	});
	return server.listen();
}

export function origin(vite: ViteDevServer): string {
	const address = vite.httpServer?.address();
	if (address === null || address === undefined || typeof address === "string")
		throw new Error("the Vite server is not listening on a port");
	return `http://127.0.0.1:${address.port}`;
}

function named(plugin: PluginOption, name: string): boolean {
	if (!plugin || Array.isArray(plugin) || plugin instanceof Promise)
		return false;
	return plugin.name === name;
}
