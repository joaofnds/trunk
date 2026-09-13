export class NormalizeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NormalizeError";
	}
}

type WorkloadClass = {
	readonly calibrationPrefix: string;
	readonly names: readonly string[];
	readonly groups: readonly string[];
};

const CLASSES: readonly WorkloadClass[] = [
	{
		calibrationPrefix: "calibration/syntect-",
		names: ["diff_ts_full_pipeline", "enrich_ts_new_perfile"],
		groups: ["diff_ts_large_file"],
	},
	{
		calibrationPrefix: "calibration/worktree-",
		names: [
			"diff_unstaged_inner",
			"get_status_inner",
			"stage_hunk_inner",
			"ipc_round_trip/diff_unstaged",
		],
		groups: [],
	},
	{
		calibrationPrefix: "calibration/git2-",
		names: ["list_refs_inner"],
		groups: ["snapshot", "toggle_visibility", "ipc_round_trip", "startup"],
	},
];

const EXCLUDED: readonly string[] = ["reviewdb_draft_write"];

const BENCH_LINE =
	/^test (.+?)\s+\.\.\. bench:\s+([\d,]+) (\w+\/\w+) \(\+\/- ([\d,]+)\)$/;

const SCALE = 1_000_000;

type Sample = {
	readonly name: string;
	readonly value: number;
	readonly unit: string;
	readonly deviation: number;
};

function digits(text: string): number {
	return Number(text.replaceAll(",", ""));
}

function parse(input: string): Sample[] {
	const samples: Sample[] = [];

	for (const line of input.split("\n")) {
		const match = BENCH_LINE.exec(line.trimEnd());
		if (match) {
			samples.push({
				name: match[1],
				value: digits(match[2]),
				unit: match[3],
				deviation: digits(match[4]),
			});
		}
	}

	return samples;
}

function workloadOf(name: string): WorkloadClass | undefined {
	const group = name.split("/")[0];
	return (
		CLASSES.find((workload) => workload.names.includes(name)) ??
		CLASSES.find((workload) => workload.groups.includes(group))
	);
}

function isCalibration(name: string): boolean {
	return CLASSES.some((workload) =>
		name.startsWith(workload.calibrationPrefix),
	);
}

function scale(value: number, calibration: number): number {
	return Math.round((value * SCALE) / calibration);
}

export function normalize(input: string): string {
	const samples = parse(input);
	const gated: Array<{ sample: Sample; workload: WorkloadClass }> = [];
	for (const sample of samples) {
		if (isCalibration(sample.name) || EXCLUDED.includes(sample.name)) {
			continue;
		}

		const workload = workloadOf(sample.name);
		if (!workload) {
			throw new NormalizeError(
				`${sample.name} belongs to no class and is not excluded`,
			);
		}
		gated.push({ sample, workload });
	}

	const calibrations = new Map<string, Sample>();
	for (const workload of CLASSES) {
		const matches = samples.filter((sample) =>
			sample.name.startsWith(workload.calibrationPrefix),
		);
		if (matches.length === 0) {
			throw new NormalizeError(
				`${workload.calibrationPrefix}* is absent from the benchmark output`,
			);
		}
		if (matches.length > 1) {
			throw new NormalizeError(
				`${workload.calibrationPrefix}* appears more than once in the benchmark output`,
			);
		}
		calibrations.set(workload.calibrationPrefix, matches[0]);
	}

	return gated
		.map(({ sample, workload }) => {
			const calibration = calibrations.get(workload.calibrationPrefix);
			if (calibration === undefined) {
				throw new NormalizeError(`${sample.name} has no calibration value`);
			}

			const value = scale(sample.value, calibration.value);
			const deviation = scale(sample.deviation, calibration.value);
			const series = calibration.name.slice("calibration/".length);

			return `test norm/${series}/${sample.name} ... bench: ${value} ${sample.unit} (+/- ${deviation})`;
		})
		.join("\n");
}
