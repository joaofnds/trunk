//! Case 09: every graph shape at once. Eighteen branches, five tags of both kinds, three
//! stashes, an orphan root, a criss-cross merge, a fast-forward, and a dirty worktree.
//! Transcribed from cases/09-kitchen-sink/build.sh, whose running day counter advances
//! after every commit, merge and stash and is read by the annotated tags as it stands.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "09-kitchen-sink",
    summary: "The kitchen-sink repository: one repo carrying sixteen graph shapes at once.",
    repos: &["kitchen-sink"],
    build,
};

/// The repository and the script's `day` counter.
struct Sink {
    repo: Repo,
    day: i64,
}

impl Sink {
    fn now(&self) -> Signature {
        FIXTURE.at(BASE_SECS + self.day * DAY_SECS)
    }

    /// `commit <file> <content> <message>`: fixture_write, then a commit of that path.
    fn commit(&mut self, file: &str, content: &str, msg: &str) {
        self.repo.write(file, &format!("{content}\n"));
        self.repo.add(&[file]);
        let when = self.now();
        self.repo.commit(when, msg);
        self.day += 1;
    }

    /// `merge <branch> <message>`: always --no-ff.
    fn merge(&mut self, branch: &str, msg: &str) {
        let when = self.now();
        self.repo.merge(when, msg, &[branch]);
        self.day += 1;
    }

    /// `stash_push [-u] -m <message>`.
    fn stash(&mut self, msg: &str, include_untracked: bool) {
        let when = self.now();
        self.repo.stash(when, msg, include_untracked);
        self.day += 1;
    }

    /// `GIT_COMMITTER_DATE="$(fixture_date $day)" g tag -a <name> -m <message>`.
    fn tag_annotated(&mut self, name: &str, msg: &str) {
        let when = self.now();
        self.repo.tag_annotated(name, when, msg);
    }

    fn checkout_new(&mut self, name: &str) {
        self.repo.branch(name);
        self.repo.checkout(name);
    }
}

fn build(out: &Path) {
    let mut repo = Repo::init(&out.join("kitchen-sink"), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");
    let mut s = Sink { repo, day: 0 };

    s.commit("README.md", "# Test repository", "Initial commit");

    s.commit(
        "src/main.ts",
        "console.log('hello')",
        "feat: add main entry point",
    );
    s.commit(
        "src/utils.ts",
        "export function add(a: number, b: number) { return a + b }",
        "feat: add utils module",
    );
    s.repo.tag("v0.1.0", "HEAD");
    s.tag_annotated("v0.2.0", "Annotated tag for v0.2.0");

    s.checkout_new("feature/auth");
    s.commit(
        "src/auth.ts",
        "export function login() {}",
        "feat: add auth module",
    );
    s.commit(
        "src/auth.ts",
        "export function login()\nexport function logout() {}",
        "feat: add logout",
    );
    s.repo.checkout("main");
    s.commit(
        "src/config.ts",
        "export const PORT = 3000",
        "feat: add config",
    );
    s.merge("feature/auth", "Merge branch 'feature/auth' into main");

    s.checkout_new("feature/api");
    s.commit(
        "src/api.ts",
        "export function fetchUsers() {}",
        "feat: add API client",
    );
    s.commit(
        "src/api.ts",
        "export function fetchPosts() {}",
        "feat: add fetchPosts",
    );
    s.repo.checkout("main");
    s.checkout_new("feature/ui");
    s.commit(
        "src/ui.ts",
        "export function render() {}",
        "feat: add UI renderer",
    );
    s.commit(
        "src/ui.ts",
        "export function hydrate() {}",
        "feat: add hydrate",
    );
    s.repo.checkout("main");
    s.checkout_new("feature/db");
    s.commit(
        "src/db.ts",
        "export function connect() {}",
        "feat: add database module",
    );
    s.repo.checkout("main");
    s.merge("feature/api", "Merge branch 'feature/api' into main");
    s.merge("feature/ui", "Merge branch 'feature/ui' into main");
    s.merge("feature/db", "Merge branch 'feature/db' into main");
    s.repo.tag("v0.3.0", "HEAD");

    s.checkout_new("develop");
    s.commit(
        "src/logger.ts",
        "export function log(msg: string) { console.log(msg) }",
        "feat: add logger",
    );
    s.commit(
        "src/logger.ts",
        "export function log(msg: string) { console.log('[LOG]', msg) }",
        "refactor: prefix log messages",
    );
    s.commit(
        "src/errors.ts",
        "export class AppError extends Error {}",
        "feat: add custom error class",
    );
    s.repo.checkout("main");
    s.commit(
        "docs/README.md",
        "# Documentation",
        "docs: add documentation folder",
    );
    s.commit("docs/api.md", "# API Docs", "docs: add API documentation");
    s.merge("develop", "Merge branch 'develop' into main");

    s.checkout_new("feature/notifications");
    s.commit(
        "src/notify.ts",
        "export function notify() {}",
        "feat: add notification system",
    );
    s.checkout_new("feature/notifications-email");
    s.commit(
        "src/email.ts",
        "export function sendEmail() {}",
        "feat: add email notifications",
    );
    s.commit(
        "src/email.ts",
        "export function formatEmail() {}",
        "feat: add email formatting",
    );
    s.repo.checkout("feature/notifications");
    s.commit(
        "src/notify.ts",
        "export function subscribe() {}",
        "feat: add subscribe",
    );
    s.merge(
        "feature/notifications-email",
        "Merge email into notifications",
    );
    s.repo.checkout("main");
    s.merge(
        "feature/notifications",
        "Merge branch 'feature/notifications' into main",
    );

    s.repo.write("src/wip1.ts", "work in progress 1\n");
    s.repo.add(&["src/wip1.ts"]);
    s.stash("WIP: experimental feature", false);
    s.repo.write("src/wip2.ts", "work in progress 2\n");
    s.repo.add(&["src/wip2.ts"]);
    s.stash("WIP: another experiment", false);
    s.repo.write("src/wip3.ts", "unstaged changes\n");
    append(&mut s.repo, "src/main.ts", "modified\n");
    s.stash("WIP: mixed staged and untracked", true);

    s.checkout_new("hotfix/typo");
    s.commit(
        "docs/README.md",
        "# Documentation\nFixed typo",
        "fix: typo in docs",
    );
    s.repo.checkout("main");
    s.merge("hotfix/typo", "Merge branch 'hotfix/typo' into main");

    s.repo.checkout_orphan("gh-pages");
    s.commit(
        "index.html",
        "<html><body>Hello</body></html>",
        "Initial GitHub Pages commit",
    );
    s.commit("style.css", "body { margin: 0 }", "Add styles");

    s.repo.checkout("main");
    s.checkout_new("feature/search");
    s.commit(
        "src/search.ts",
        "export function search() {}",
        "feat: add search",
    );
    s.commit(
        "src/search.ts",
        "export function filter() {}",
        "feat: add filter",
    );
    s.commit(
        "src/search.ts",
        "export function sort() {}",
        "feat: add sort",
    );
    s.repo.checkout("main");
    s.checkout_new("feature/cache");
    s.commit(
        "src/cache.ts",
        "export function cache() {}",
        "feat: add caching layer",
    );
    s.repo.checkout("main");
    s.checkout_new("bugfix/memory-leak");
    s.commit("src/utils.ts", "// fixed leak", "fix: memory leak in utils");

    s.repo.checkout("main");
    s.commit("CHANGELOG.md", "# Changelog", "docs: add changelog");
    s.commit(
        "package.json",
        "{\"name\":\"trunk-test\",\"version\":\"0.4.0\"}",
        "chore: bump version",
    );
    s.repo.tag("v0.4.0", "HEAD");

    s.checkout_new("feature/refactor");
    for i in 1..=8 {
        s.commit(
            &format!("src/refactor-{i}.ts"),
            &format!("// refactor step {i}"),
            &format!("refactor: step {i} of migration"),
        );
    }

    s.repo.checkout("main");
    s.checkout_new("branch-a");
    s.commit("src/a1.ts", "// a1", "feat: branch-a commit 1");
    s.repo.checkout("main");
    s.checkout_new("branch-b");
    s.commit("src/b1.ts", "// b1", "feat: branch-b commit 1");
    s.merge("branch-a", "Merge branch-a into branch-b");
    s.repo.checkout("branch-a");
    s.commit("src/a2.ts", "// a2", "feat: branch-a commit 2");
    s.merge("branch-b", "Merge branch-b into branch-a");
    s.repo.checkout("main");
    s.merge("branch-a", "Merge branch-a (criss-cross) into main");

    s.tag_annotated("v0.5.0-rc1", "Release candidate 1");

    s.checkout_new("feature/quick-fix");
    s.commit("src/fix.ts", "// quick fix", "fix: quick patch");
    s.repo.checkout("main");
    s.repo.merge_ff("feature/quick-fix");

    s.checkout_new("feature/long-lived");
    s.commit("src/ll1.ts", "// ll1", "feat: long-lived work 1");
    s.repo.checkout("main");
    s.commit("src/hotpatch.ts", "// hotpatch", "fix: critical hotpatch");
    s.repo.checkout("feature/long-lived");
    s.merge("main", "Merge main into feature/long-lived (update)");
    s.commit("src/ll2.ts", "// ll2", "feat: long-lived work 2");

    s.repo.checkout("main");
    s.repo
        .write("src/uncommitted.ts", "// uncommitted new file\n");
    append(&mut s.repo, "CHANGELOG.md", "// modified\n");
    s.repo.add(&["CHANGELOG.md"]);

    s.repo.write("SCENARIO.md", &format!("{SCENARIO}\n"));
}

/// `printf '…' >>"$REPO/<rel>"`.
fn append(repo: &mut Repo, rel: &str, text: &str) {
    let mut content = std::fs::read_to_string(repo.path().join(rel)).expect("read the file");
    content.push_str(text);
    repo.write(rel, &content);
}

/// The scenario, verbatim from the script; fixture_scenario adds the final newline.
const SCENARIO: &str = r##"# Kitchen sink — every graph shape in one repository

The widest fixture in the corpus. Open it to look at lane allocation, edge
routing, ref pills and colouring all under pressure at once. When you want to
isolate a single rule, use a narrower fixture instead.

What is in here, and what each part is for:

| Shape | Where to look |
|---|---|
| Merge commits (hollow dots) | `feature/auth`, `feature/api`, `feature/ui`, `feature/db` merges into main |
| Three branches alive at once | the `feature/api`/`feature/ui`/`feature/db` span |
| Branch off a branch | `feature/notifications-email` off `feature/notifications` |
| Criss-cross merge | `branch-a` and `branch-b` each merge the other |
| Orphan root | `gh-pages` has no ancestor in common with main |
| Fast-forward merge | `feature/quick-fix` — no merge commit is created |
| Merge main into a branch | `feature/long-lived`, left unmerged on purpose |
| Long chain | `feature/refactor`, 8 commits |
| Branches behind main | `feature/search`, `feature/cache`, `bugfix/memory-leak` |
| Lightweight and annotated tags | `v0.1.0`/`v0.3.0`/`v0.4.0` are lightweight; `v0.2.0`/`v0.5.0-rc1` are tag objects |
| Tag on a merge commit | `v0.5.0-rc1` |
| Three stashes | one of them carrying untracked files |
| Dirty worktree | `CHANGELOG.md` staged, `src/uncommitted.ts` untracked |

Rebuild at any time with `cases/09-kitchen-sink/build.sh`. The repo is
disposable — edit it freely."##;
