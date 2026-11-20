export type CommitFormMode = "commit" | "amend" | "stash";

/** What the commit form holds. The repository's view keeps it, so looking at a
 *  commit, which closes the form, loses none of it, and a commit that lands
 *  meanwhile clears the draft the reopened form shows. */
export class CommitFormSession {
	/** The commit and stash message, which the uncommitted-changes row shows and
	 *  the repository saves. Amend edits its own buffer below and never this. */
	draftSubject = $state("");
	draftBody = $state("");
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
