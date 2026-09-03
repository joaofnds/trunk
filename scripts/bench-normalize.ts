export class NormalizeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NormalizeError";
	}
}

type WorkloadClass = {
	readonly calibration: string;
	readonly names: readonly string[];
	readonly groups: readonly string[];
};

const CLASSES: readonly WorkloadClass[] = [
	{
		calibration: "calibration/syntect",
		names: ["diff_ts_full_pipeline", "enrich_ts_new_perfile"],
		groups: ["diff_ts_large_file"],
	},
	{
		calibration: "calibration/git2",
		names: [
			"list_refs_inner",
			"diff_unstaged_inner",
			"get_status_inner",
			"stage_hunk_inner",
		],
		groups: ["snapshot", "toggle_visibility", "ipc_round_trip", "startup"],
	},
];

const EXCLUDED: readonly string[] = ["reviewdb_draft_write"];

const CALIBRATION_NAMES = CLASSES.map((workload) => workload.calibration);

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
	return CLASSES.find(
		(workload) =>
			workload.names.includes(name) || workload.groups.includes(group),
	);
}

function scale(value: number, calibration: number): number {
	return Math.round((value * SCALE) / calibration);
}

export function normalize(input: string): string {
	const samples = parse(input);

	const unclassified = samples.find(
		(sample) =>
			!CALIBRATION_NAMES.includes(sample.name) &&
			!EXCLUDED.includes(sample.name) &&
			!workloadOf(sample.name),
	);
	if (unclassified) {
		throw new NormalizeError(
			`${unclassified.name} belongs to no class and is not excluded`,
		);
	}

	const calibrations = new Map(
		samples
			.filter((sample) => CALIBRATION_NAMES.includes(sample.name))
			.map((sample) => [sample.name, sample.value]),
	);
	const absent = CALIBRATION_NAMES.find((name) => !calibrations.has(name));
	if (absent) {
		throw new NormalizeError(`${absent} is absent from the benchmark output`);
	}

	const gated = samples.filter(
		(sample) =>
			!CALIBRATION_NAMES.includes(sample.name) &&
			!EXCLUDED.includes(sample.name),
	);

	return gated
		.map((sample) => {
			const calibration = calibrations.get(
				workloadOf(sample.name)?.calibration ?? "",
			);
			if (calibration === undefined) {
				throw new NormalizeError(`${sample.name} has no calibration value`);
			}

			const value = scale(sample.value, calibration);
			const deviation = scale(sample.deviation, calibration);

			return `test norm/${sample.name} ... bench: ${value} ${sample.unit} (+/- ${deviation})`;
		})
		.join("\n");
}
