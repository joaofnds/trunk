export type Base = {
	readonly sha: string;
	readonly reason: string;
};

const NO_COMMIT = /^0+$/;

export function chooseBase(push: {
	readonly before: string;
	readonly beforeIsAncestor: boolean;
	readonly parent: string;
}): Base {
	if (NO_COMMIT.test(push.before)) {
		return {
			sha: push.parent,
			reason:
				"the push carries no previous commit, so the pushed commit's parent",
		};
	}

	if (!push.beforeIsAncestor) {
		return {
			sha: push.parent,
			reason: `the previous commit ${push.before} is not an ancestor of the pushed one, so the pushed commit's parent`,
		};
	}

	return { sha: push.before, reason: "the commit main held before the push" };
}
