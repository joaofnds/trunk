export type CommitFormMode = "commit" | "amend" | "stash";

/** What the commit form holds besides the draft. The repository's view keeps
 *  it, so looking at a commit, which closes the form, loses none of it. */
export class CommitFormSession {
	mode = $state<CommitFormMode>("commit");
	committing = $state(false);
	amendSubject = $state("");
	amendBody = $state("");
	/** The commit the amend buffer is aimed at. The amend names it, and the
	 *  backend refuses once HEAD is another, so a pull or a commit landing
	 *  meanwhile is never replaced under this message. */
	amendHeadOid = $state<string | null>(null);
	/** The message the amend buffer was filled with, to tell an edit from it. */
	amendSeed = { subject: "", body: "" };
	amendSeeding = 0;
}
