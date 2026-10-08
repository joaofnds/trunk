// The ways the prototype can draw a thread on a whole file, and a long excerpt,
// so the alternatives are compared on the same review by switching between them.

export const FILE_VARIANT_IDS = [
	"today",
	"tag",
	"note",
	"capped",
	"conversation",
] as const;

export type FileVariant = (typeof FILE_VARIANT_IDS)[number];

export const FILE_VARIANTS: Record<
	FileVariant,
	{ label: string; about: string }
> = {
	today: {
		label: "Today",
		about:
			"What the app does now. A whole-file comment is saved as lines 1 to the end, so its card is tagged as a range and prints every line of the file.",
	},
	tag: {
		label: "A. Whole-file tag",
		about:
			"GitHub, GitLab and Gerrit all start a file comment from the file's header and keep it apart from line comments. The card names the file with a dashed Whole file tag, which opens the file, and carries no code.",
	},
	note: {
		label: "B. Note on the file",
		about:
			"GitLab's design for file comments puts the thread under the file's header and above its content. Here it sits on the file's row in the panel, before that file's line threads, drawn as a note rather than a code card.",
	},
	capped: {
		label: "C. A + capped excerpts",
		about:
			"A, and no excerpt is taller than 8 lines. A longer range shows the 6 lines it ends on, where the comment points, and folds the rest behind a link. This also catches a large range picked by hand.",
	},
	conversation: {
		label: "D. A + code on demand",
		about:
			"A, and every card starts with its code folded to one line, so the panel reads as the conversation. The code opens per card, and keeps the cap from C when it does.",
	},
};

/** The tallest excerpt C and D draw before folding the rest. */
export const EXCERPT_CAP = 8;

/** How many of a folded excerpt's last lines C and D keep in view. */
export const EXCERPT_TAIL = 6;
