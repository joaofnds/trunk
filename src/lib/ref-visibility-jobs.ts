const visibilityJobs = new Map<string, Promise<void>>();

/** Serializes graph changes made by sidebars that use the same backend path. */
export function enqueueVisibility(path: string, work: () => Promise<void>) {
	const done = (visibilityJobs.get(path) ?? Promise.resolve())
		.then(work)
		.catch(() => {});
	visibilityJobs.set(path, done);
	void done.then(() => {
		if (visibilityJobs.get(path) === done) visibilityJobs.delete(path);
	});
	return done;
}

export async function visibilityJobsSettled(path: string): Promise<void> {
	await visibilityJobs.get(path);
}
