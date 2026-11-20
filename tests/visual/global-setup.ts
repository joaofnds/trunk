import type { TestProject } from "vitest/node";
import { clearDifferences } from "./baseline.js";
import { origin, serve } from "./server.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** Where the run's one Vite server serves the pages. */
		pageOrigin: string;
	}
}

/** Once per run, before any file: two files clearing at their own start would
 *  each delete what the other had already written, and every file's pages load
 *  from the one server started here. */
export async function setup(
	project: TestProject,
): Promise<() => Promise<void>> {
	clearDifferences();
	const vite = await serve();
	project.provide("pageOrigin", origin(vite));

	return () => vite.close();
}
