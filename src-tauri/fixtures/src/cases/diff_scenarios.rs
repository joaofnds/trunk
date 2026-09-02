//! Case 02: one diff-rendering scenario per commit. Each commit's subject names the
//! scenario and its body says what the diff views should show; the working tree ends
//! with one staged and two unstaged edits. Transcribed from
//! cases/02-diff-scenarios/build.py.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "02-diff-scenarios",
    summary: "One repo, one diff-rendering scenario per commit.",
    repos: &["diff-scenarios"],
    build,
};

/// The repository and the script's `_day` counter, advanced per commit.
struct Scenarios {
    repo: Repo,
    day: i64,
}

impl Scenarios {
    fn write(&mut self, rel: &str, content: &str) {
        self.repo.write(rel, content);
    }

    fn write_bytes(&mut self, rel: &str, content: &[u8]) {
        self.repo.write_bytes(rel, content);
    }

    /// `sub`: replace `old` once; the pattern must be unique or the scenario is not the
    /// one described.
    fn sub(&mut self, rel: &str, old: &str, new: &str) {
        let text = std::fs::read_to_string(self.repo.path().join(rel)).expect("read the file");
        assert!(
            text.matches(old).count() == 1,
            "{rel}: pattern not unique or missing: {old:?}"
        );
        self.repo.write(rel, &text.replace(old, new));
    }

    /// `commit(subject, body, *paths)`: stage the paths, commit at the pinned day.
    fn commit(&mut self, subject: &str, body: &str, paths: &[&str]) {
        self.repo.add(paths);
        self.commit_index(subject, body);
    }

    /// `commit_index(subject, body)`: commit what is already staged, at the pinned day.
    fn commit_index(&mut self, subject: &str, body: &str) {
        let when = FIXTURE.at(BASE_SECS + self.day * DAY_SECS);
        self.day += 1;
        self.repo.commit(when, &format!("{subject}\n\n{body}"));
    }
}

const PIPELINE_STAGES: &str = "func stageParse(input []byte) (Ast, error) {
\ttree, err := parse(input)
\tif err != nil {
\t\treturn Ast{}, fmt.Errorf(\"parse: %w\", err)
\t}
\treturn tree, nil
}

func stageCheck(tree Ast) error {
\tfor _, node := range tree.Nodes {
\t\tif err := check(node); err != nil {
\t\t\treturn err
\t\t}
\t}
\treturn nil
}

func stageEmit(tree Ast, out io.Writer) error {
\tfor _, node := range tree.Nodes {
\t\tif err := emit(node, out); err != nil {
\t\t\treturn err
\t\t}
\t}
\treturn nil
}
";

/// A 1x1 RGB PNG, as the python `png_1x1(200, 30, 30)` wrote it.
const RED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x38, 0x21, 0x27, 0x07,
    0x00, 0x02, 0xb6, 0x01, 0x05, 0x34, 0xa6, 0x75, 0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// `png_1x1(30, 30, 200)`.
const BLUE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x90, 0x93, 0x3b, 0x01,
    0x00, 0x01, 0x62, 0x01, 0x05, 0x11, 0x1b, 0xa3, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

fn minified_css() -> String {
    let sides = ["top", "right", "bottom", "left"];
    let rules: String = (0..12)
        .map(|n| {
            let side = sides[n % 4];
            format!("margin-{side}:0;padding-{side}:{n}px;border-{side}:1px solid #aabbcc;")
        })
        .collect();

    format!(".hero{{{rules}color:#112233;background:#445566;}}")
}

fn blob_bytes() -> Vec<u8> {
    (0..=255u8).cycle().take(256 * 8).collect()
}

fn build(out: &Path) {
    let mut repo = Repo::init(&out.join("diff-scenarios"), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");
    let mut s = Scenarios { repo, day: 0 };

    base_files(&mut s);
    s.repo.add_all();
    s.commit_index(
        "add fixture files",
        "Base state for every scenario commit that follows.",
    );

    code_scenarios(&mut s);
    markdown_scenarios(&mut s);
    structural_scenarios(&mut s);

    s.sub(
        "code/report.py",
        "totals.get(row.currency, 0)",
        "totals.get(row.currency, 0.0)",
    );
    s.repo.add(&["code/report.py"]);
    s.sub(
        "code/metrics.rs",
        "self.samples.len() as f64",
        "self.samples.len().max(1) as f64",
    );
    s.sub(
        "docs/guide.md",
        "The card holds the proof.",
        "The card holds the evidence.",
    );
}

fn base_files(s: &mut Scenarios) {
    s.write(
        "SCENARIO.md",
        r##"# Case 6 — Diff rendering scenarios

One scenario per commit. Open this repo in Trunk, select a commit, open its
file, and check the commit body's expectation in the named view. Code
scenarios exercise the source view (word emphasis, split pairing, hunk
boundaries); markdown scenarios exercise the rendered view (copies and
merged styles) as well.

The working tree ends dirty on purpose:

- staged: `code/report.py` (one literal)
- unstaged: `code/metrics.rs` (one call) and `docs/guide.md` (one word)

Reset with `./build 02-diff-scenarios` from the repository root.
"##,
    );

    s.write(
        "code/metrics.rs",
        r##"pub struct Metrics {
    samples: Vec<f64>,
    scale: u32,
}

impl Metrics {
    pub fn new() -> Self {
        Self { samples: Vec::new(), scale: 64 }
    }

    // Carried: the cache already answers the need. Ask it first, and say
    // which side answers it faster; when the cache side does, that gap is
    // recorded here, judged per call.
    pub fn push(&mut self, value: f64) {
        self.samples.push(value);
    }

    pub fn mean(&self) -> f64 {
        let sum: f64 = self.samples.iter().sum();
        sum / self.samples.len() as f64
    }
}
"##,
    );

    s.write(
        "code/client.ts",
        r##"import { endpoint, request } from "./http";

export function fetchUser(id: string): Promise<Response> {
  const a = endpoint(1);
  const query = new URLSearchParams({ id });
  const url = `${a}?${query}`;
  return request(url);
}

export const banner = "café aberto — bem-vindo, chef 👨‍🍳";
"##,
    );

    s.write(
        "code/server.go",
        "package main

import \"net/http\"

// On conflict, the more specific rule governs. The route's own settings win
// over this default. A handler override wins over this base handler. The
// config holds the reasons and wins where this file seems to differ.
func routes(mux *http.ServeMux) {
\tmux.HandleFunc(\"/health\", handleHealth)
\tmux.HandleFunc(\"/users\", handleUsers)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
\tw.WriteHeader(http.StatusOK)
\tw.Write([]byte(\"ok\"))
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
\tw.WriteHeader(http.StatusOK)
\tw.Write([]byte(\"users\"))
}
",
    );

    s.write(
        "code/report.py",
        r##"def summary(rows):
    """Collect the totals for the daily report. Each row carries an amount
    and a currency, and the totals accumulate per currency so mixed rows
    never add up across currencies by accident."""
    totals = {}
    for row in rows:
        totals[row.currency] = totals.get(row.currency, 0) + row.amount
    return totals
"##,
    );

    s.write(
        "code/config.yaml",
        r##"# Server section: bind address and request handling.
# Timeouts apply per request, not per connection.
server:
  host: 0.0.0.0
  port: 8080
  timeout_seconds: 30

# Logging section: structured output for the collector.
# The level applies to every module uniformly.
logging:
  level: info
  format: json

# Limits section: connection budgets for the listener.
# Burst rides on top of the steady-state cap.
limits:
  max_connections: 512
  burst: 64
  window_seconds: 60
"##,
    );

    s.write(
        "code/styles.css",
        &format!(
            ".card {{\n  border-radius: 6px;\n  padding: 12px;\n}}\n\n{}\n",
            minified_css()
        ),
    );

    s.write(
        "docs/guide.md",
        r##"# Guide

Keep file names, symbols, and code out of the reply. They only say where
something is, and the reader would have to open a file to follow them. Say
what the finding means. The card holds the proof.

A question about the state of work gets the position now, never the story of
how it got there. What blocks it, the one thing worth doing, what the rest
waits on. Retelling the record is the failure this style exists to stop.

State a finding as fact. No headline in front of it, and no account of how or
when you found it. When there are several findings, the one with the biggest
consequence comes first, stated as what it would have cost.

The quick brown fox jumps over the lazy dog near the river bank today, while
the server configuration lives in a YAML file loaded at startup by the daemon
and metrics accumulate quietly in the background.
"##,
    );

    s.write(
        "docs/reference.md",
        r##"# Reference

## Verdicts

Every item ends with one of these verdicts, and the study is complete when
every item carries one:

- **Carried**: the corpus already answers the need. Cite where, and say which
  side answers it better; a difference is a gap judged under Import.
- **Import**: name the failure or gap observed here that the mechanism
  answers. A gap we can show today qualifies.
- **Declined**: everything else, with the reason recorded on the card.

## Limits

| limit | value | applies to |
| --- | --- | --- |
| max connections | 512 | server |
| burst | 64 | client |
| window | 60s | both |

## Snippets

```rust
fn scale(value: f64) -> f64 {
    value * 64.0
}
```

```ts
export const retries = 5;
export const backoff = "exponential";
```

```python
def window(seconds):
    return max(seconds, 60)
```

Steps to reproduce:

1. Install the toolchain with `mise install` and wait for it to finish.
2. Run the checks:

   ```bash
   just check --verbose
   ```

3. Read the summary in the terminal, then open the [dashboard](https://example.com/dash)
   and compare the totals against **the stored baseline** before shipping.

> The quote block stays calm and unchanged while everything around it moves,
> until the day it too gets edited.
"##,
    );

    s.write(
        "docs/i18n.md",
        r##"# Internacionalização

A configuração é lida uma única vez na inicialização, e as alterações feitas
depois disso só têm efeito após o reinício do serviço — não há recarga quente.

Größenänderungen müssen über die Konfigurationsdatei erfolgen, damit die
Überwachung die Änderung sieht.

```markdown
# Exemplo

Uma lista dentro de um bloco de código:

- primeiro item
- segundo item
```
"##,
    );
}

fn code_scenarios(s: &mut Scenarios) {
    s.sub("code/metrics.rs", "scale: 64 }", "scale: 63 }");
    s.commit(
        "rust: change one literal in a struct default",
        "Source view: exactly 64 and 63 emphasized, nothing else marked.",
        &["code/metrics.rs"],
    );

    s.sub(
        "code/client.ts",
        "const a = endpoint(1);",
        "const b = endpoint(2);",
    );
    s.sub("code/client.ts", "`${a}?${query}`", "`${b}?${query}`");
    s.commit(
        "ts: rename a variable and bump its argument",
        "Source view: small marks on a/b and 1/2, and on the template's a/b;\nthe rest of each line unmarked.",
        &["code/client.ts"],
    );

    s.sub(
        "code/server.go",
        "// On conflict, the more specific rule governs. The route's own settings win
// over this default. A handler override wins over this base handler. The
// config holds the reasons and wins where this file seems to differ.",
        "// On conflict, the more specific rule governs. A handler override wins over
// this base handler. The config holds the reasons and wins where this file
// seems to differ.",
    );
    s.commit(
        "go: delete one sentence from a wrapped comment",
        "Source view: only the removed sentence emphasized on the delete side,\nadd side clean; split view seats each line beside its reflowed twin.",
        &["code/server.go"],
    );

    s.sub(
        "code/report.py",
        "Collect the totals for the daily report. Each row carries an amount
    and a currency, and the totals accumulate per currency so mixed rows
    never add up across currencies by accident.",
        "Metrics are flushed every thirty seconds unless the buffer fills up
    first, and retry budgets cap the exponential backoff so queues drain
    before clients give up on the report entirely.",
    );
    s.commit(
        "py: rewrite a docstring completely",
        "Source view: plain red/green with no word emphasis (dense rewrite);\nsplit view stacks the sides instead of pairing them.",
        &["code/report.py"],
    );

    s.sub(
        "code/metrics.rs",
        "    // Carried: the cache already answers the need. Ask it first, and say
    // which side answers it faster; when the cache side does, that gap is
    // recorded here, judged per call.",
        "    // Carried: the cache already answers the need. Ask it first, test the
    // answer against the worst case the cache guarded (a cache guarding
    // staleness rather than misses is tested by comparison alone), and say
    // which side answers the need faster. An answer that fails its case is
    // a gap recorded here, judged per call.",
    );
    s.commit(
        "rust: grow the middle of a comment block keeping its frame",
        "Source view: the changed middle carries emphasis on every changed\nregion, including the fully new lines — never marked lines beside\nunmarked more-changed ones (the TRUNK-76 shape).",
        &["code/metrics.rs"],
    );

    s.sub(
        "code/server.go",
        "\tmux.HandleFunc(\"/health\", handleHealth)\n\tmux.HandleFunc(\"/users\", handleUsers)",
        "\tmux.HandleFunc(\"/health\", handleHealth)\n\tmux.HandleFunc(\"/orders\", handleOrders)\n\tmux.HandleFunc(\"/users\", handleUsers)",
    );
    s.sub(
        "code/server.go",
        "func handleUsers(w http.ResponseWriter, r *http.Request) {",
        "func handleOrders(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(http.StatusOK)\n\tw.Write([]byte(\"orders\"))\n}\n\nfunc handleUsers(w http.ResponseWriter, r *http.Request) {",
    );
    s.commit(
        "go: insert a handler between two similar handlers",
        "Source view: the added hunk sits on the function boundary (blank line\nto blank line), the boundary git CLI picks — not mid-function.",
        &["code/server.go"],
    );

    s.sub(
        "code/client.ts",
        "  const query = new URLSearchParams({ id });\n  const url = `${b}?${query}`;",
        "  const url = `${b}?${new URLSearchParams({ id })}`;",
    );
    s.commit(
        "ts: collapse two lines into one",
        "Split view: the surviving line pairs with its closest twin, the\nleftover delete sits alone against a phantom.",
        &["code/client.ts"],
    );

    s.sub(
        "code/config.yaml",
        "limits:\n  max_connections: 512\n  burst: 64\n  window_seconds: 60",
        "limits:\n    max_connections: 512\n    burst: 64\n    window_seconds: 60",
    );
    s.commit(
        "yaml: re-indent a block, whitespace only",
        "Source view: lines pair side by side with no word emphasis (whitespace\nslivers suppressed); the ignore-whitespace toggle empties the diff.",
        &["code/config.yaml"],
    );

    s.sub(
        "code/styles.css",
        "color:#112233;background:#445566;",
        "color:#112244;background:#445566;",
    );
    s.commit(
        "css: edit one token inside a minified line",
        "Source view: plain coloring, no emphasis — the 500-byte line guard\nrefuses to word-diff minified content.",
        &["code/styles.css"],
    );

    s.sub("code/config.yaml", "port: 8080", "port: 9090");
    s.sub("code/config.yaml", "level: info", "level: debug");
    s.sub(
        "code/config.yaml",
        "max_connections: 512",
        "max_connections: 1024",
    );
    s.commit(
        "yaml: change values in three separate sections",
        "Source view: three hunks, each with word emphasis on just its changed\nvalue — the per-file refinement budget covers all of them.",
        &["code/config.yaml"],
    );

    s.sub(
        "code/client.ts",
        "export const banner = \"café aberto — bem-vindo, chef 👨‍🍳\";",
        "export const banner = \"café fechado — até amanhã, chef 👩‍🍳\";",
    );
    s.commit(
        "ts: edit an accented, emoji string",
        "Source view: emphasis sits exactly on the changed words despite\nmultibyte characters before them (TRUNK-74 fixed the byte vs UTF-16\noffset shift).",
        &["code/client.ts"],
    );
}

fn markdown_scenarios(s: &mut Scenarios) {
    s.sub(
        "docs/guide.md",
        "Keep file names, symbols, and code out of the reply. They only say where
something is, and the reader would have to open a file to follow them. Say
what the finding means. The card holds the proof.",
        "Keep file names, symbols, and code out of the reply. Say what the finding
means. The card holds the proof.",
    );
    s.commit(
        "md: delete one sentence from a hard-wrapped paragraph",
        "Rendered view: only the removed sentence struck; the rewrapped rest\ncarries no marks. Source view: same, plus reflow pairing.",
        &["docs/guide.md"],
    );

    s.sub(
        "docs/guide.md",
        "A question about the state of work gets the position now, never the story of
how it got there. What blocks it, the one thing worth doing, what the rest
waits on. Retelling the record is the failure this style exists to stop.",
        "Every reply states the position now, never the story of how it got there.
Asked about the state of work: what blocks it, the one thing worth doing,
what the rest waits on. Retelling the record is the failure this style
exists to stop.",
    );
    s.commit(
        "md: rewrite a sentence keeping the paragraph frame",
        "Merged rendered view: one struck run and one inserted run per rewritten\nregion, separated by a space — no word-by-word jammed pairs (the\nTRUNK-77 shape).",
        &["docs/guide.md"],
    );

    s.sub(
        "docs/guide.md",
        "State a finding as fact. No headline in front of it, and no account of how or
when you found it. When there are several findings, the one with the biggest
consequence comes first, stated as what it would have cost.",
        "State a finding as fact. No headline in front of it, and no
account of how or when you found it. When there are several findings,
the one with the biggest consequence comes first, stated as what it
would have cost.",
    );
    s.commit(
        "md: rewrap a paragraph without changing words",
        "Rendered view: nothing visibly changed (same words, new wrap).\nSource view: the reflowed lines pair with their twins, no emphasis.",
        &["docs/guide.md"],
    );

    s.sub(
        "docs/guide.md",
        "The quick brown fox jumps over the lazy dog near the river bank today, while
the server configuration lives in a YAML file loaded at startup by the daemon
and metrics accumulate quietly in the background.",
        "Retry budgets cap exponential backoff so queues drain before clients give
up, and every dashboard tile answers one question about the last five
minutes without a single shared counter between them.",
    );
    s.commit(
        "md: rewrite a paragraph completely",
        "Rendered view: full before/after wash, no word marks (dense rewrite);\nthe merged view keeps the before and after copies for this block.",
        &["docs/guide.md"],
    );

    s.sub(
        "docs/reference.md",
        "Cite where, and say which\n  side answers it better; a difference is a gap judged under Import.",
        "Cite where, test the\n  citation against its worst case; a difference is a gap judged under Import.",
    );
    s.commit(
        "md: edit one clause inside a bullet",
        "Rendered view: del/ins marks on exactly the changed clause inside the\nCarried bullet; the other bullets carry no tint.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "- **Import**: name the failure or gap observed here that the mechanism
  answers. A gap we can show today qualifies.
- **Declined**: everything else, with the reason recorded on the card.",
        "- **Declined**: everything else, with the reason recorded on the card.
- **Unverified**: only running the code could settle it; say why reading
  the files cannot.",
    );
    s.commit(
        "md: delete one bullet and insert another",
        "Rendered view: the removed bullet tinted red as a whole item, the new\nbullet green as a whole item — item tint, not word marks.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "| limit | value | applies to |",
        "| limit | value | scope |",
    );
    s.sub(
        "docs/reference.md",
        "| max connections | 512 | server |",
        "| max connections | 1024 | server |",
    );
    s.commit(
        "md: edit a table cell and its header",
        "Rendered view: word marks inside just the changed header cell and the\nchanged value cell; the rest of the table untouched, one header row.",
        &["docs/reference.md"],
    );

    s.sub("docs/reference.md", "## Limits", "## Budgets");
    s.commit(
        "md: change a heading",
        "Rendered view: word marks on the changed word inside the heading.",
        &["docs/reference.md"],
    );

    s.sub("docs/reference.md", "    value * 64.0", "    value * 63.0");
    s.sub(
        "docs/reference.md",
        "export const retries = 5;",
        "export const retries = 7;",
    );
    s.sub(
        "docs/reference.md",
        "    return max(seconds, 60)",
        "    return max(seconds, 90)",
    );
    s.commit(
        "md: edit fenced code in rust, ts, and python",
        "Rendered view: code blocks show a before/after pair, never merged word\nmarks inside highlighted code at the top level.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "   just check --verbose",
        "   just check --quiet",
    );
    s.commit(
        "md: edit code inside a list item",
        "Rendered view: the list item's code block changes without fabricated\nspaces in the code (the TRUNK-79 territory: marks inside pre reached\nthrough a container leaf).",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "compare the totals against **the stored baseline** before shipping",
        "compare the totals against the stored baseline before shipping",
    );
    s.commit(
        "md: unbold a phrase, formatting only",
        "Rendered view: the item keeps a wash/tint (markup-only change);\nno del/ins word marks, since no visible words changed.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "with `mise install` and wait",
        "with `mise run setup` and wait",
    );
    s.sub(
        "docs/reference.md",
        "[dashboard](https://example.com/dash)",
        "[dashboard](https://example.com/metrics)",
    );
    s.commit(
        "md: edit inline code and a link target",
        "Rendered view: word marks on the inline code change; the link's text is\nunchanged while its destination moved — the change should still be\nvisible, not silent.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/reference.md",
        "> The quote block stays calm and unchanged while everything around it moves,",
        "> The quote block stays calm and mostly unchanged while everything around it\n> moves,",
    );
    s.commit(
        "md: edit a blockquote",
        "Rendered view: word marks on the inserted word inside the quote block.",
        &["docs/reference.md"],
    );

    s.sub(
        "docs/i18n.md",
        "depois disso só têm efeito após o reinício do serviço — não há recarga quente.",
        "depois disso já têm efeito imediatamente, sem reinício — a recarga é quente.",
    );
    s.sub("docs/i18n.md", "- segundo item", "- segundo item editado");
    s.commit(
        "md: edit accented prose and a markdown fence",
        "Rendered view: marks sit on the changed accented words (multibyte\noffsets), and the markdown fence renders as code — its bullet edit shows\nas a code change, not as a rendered list.",
        &["docs/i18n.md"],
    );
}

fn structural_scenarios(s: &mut Scenarios) {
    s.write(
        "code/pipeline.go",
        &format!("package main\n\nimport (\n\t\"fmt\"\n\t\"io\"\n)\n\n{PIPELINE_STAGES}"),
    );
    s.write(
        "code/util.ts",
        "export function clamp(v: number, lo: number, hi: number): number {\n\treturn Math.min(Math.max(v, lo), hi);\n}\n\nexport function lerp(a: number, b: number, t: number): number {\n\treturn a + (b - a) * clamp(t, 0, 1);\n}\n",
    );
    s.write_bytes("assets/blob.bin", &blob_bytes());
    s.write_bytes("assets/icon.png", RED_PNG);
    let generated: String = (1..=8000)
        .map(|n| format!("line {n:05}: a steady unchanged payload row\n"))
        .collect();
    s.write("code/generated.txt", &generated);
    s.write(
        "docs/endings.txt",
        "alpha line kept clean\nbeta line kept clean\ngamma line kept clean\n",
    );
    s.commit(
        "add files for the structural scenarios",
        "Setup only: the scenarios below mutate these files.",
        &[
            "code/pipeline.go",
            "code/util.ts",
            "assets/blob.bin",
            "assets/icon.png",
            "code/generated.txt",
            "docs/endings.txt",
        ],
    );

    let stages: Vec<&str> = PIPELINE_STAGES.split("\n\n").collect();
    let stage_parse = format!("{}\n", stages[0]);
    s.sub("code/pipeline.go", &format!("{stage_parse}\n"), "");
    s.sub(
        "code/pipeline.go",
        stages[2],
        &format!("{}\n\n{}", stages[2], stage_parse.trim_end_matches('\n')),
    );
    s.commit(
        "go: move a function to the bottom of the file, unchanged",
        "Moved-code scenario: stageParse moves verbatim from top to bottom.\nTools with move detection show it as a move; others show a full\ndelete plus a full add.",
        &["code/pipeline.go"],
    );

    s.repo.mv("code/util.ts", "code/math-util.ts");
    s.sub("code/math-util.ts", "clamp(t, 0, 1)", "clamp(t, 0.0, 1.0)");
    s.commit(
        "ts: rename a file and edit one line",
        "Rename scenario: similarity detection should show one renamed file\nwith a one-line edit, not a delete plus an add.",
        &["code/math-util.ts"],
    );

    let copy = std::fs::read_to_string(s.repo.path().join("code/math-util.ts"))
        .expect("read the renamed file")
        .replace("export function clamp", "export function clampCopy");
    s.write("code/math-util-copy.ts", &copy);
    s.commit(
        "ts: copy a file and tweak one identifier",
        "Copy scenario: with copy detection on, tools show a copied file with\na small edit; most show a plain new file.",
        &["code/math-util-copy.ts"],
    );

    let mut reversed = blob_bytes();
    reversed.reverse();
    s.write_bytes("assets/blob.bin", &reversed);
    s.commit(
        "bin: change a binary blob",
        "Binary scenario: the diff should say binary changed (ideally with\nsizes), never dump bytes.",
        &["assets/blob.bin"],
    );

    s.write_bytes("assets/icon.png", BLUE_PNG);
    s.commit(
        "img: change an image's pixels",
        "Image scenario: rich viewers show before/after thumbnails; text\nviewers say binary changed (open issue TRUNK-11).",
        &["assets/icon.png"],
    );

    s.sub(
        "code/generated.txt",
        "line 00002: a steady unchanged payload row",
        "line 00002: an edited payload row near the top",
    );
    s.sub(
        "code/generated.txt",
        "line 07999: a steady unchanged payload row",
        "line 07999: an edited payload row near the bottom",
    );
    s.commit(
        "big: edit both ends of an 8000-line file",
        "Large-file scenario: two small hunks far apart; the view must stay\nresponsive and both hunks must be reachable.",
        &["code/generated.txt"],
    );

    s.write(
        "docs/endings.txt",
        "alpha line kept clean\r\nbeta line grew a trailing space \r\ngamma line kept clean\r\n",
    );
    s.commit(
        "ws: flip line endings to CRLF and add a trailing space",
        "Invisibles scenario: every line changes by ending alone; one line also\ngains a trailing space. Good views mark the invisibles instead of\nshowing three identical-looking pairs.",
        &["docs/endings.txt"],
    );

    s.repo
        .gitlink("vendor/dep", "1111111111111111111111111111111111111111");
    s.commit_index(
        "sub: add a submodule pointer",
        "Setup only: a gitlink entry, no real submodule checkout.",
    );
    s.repo
        .gitlink("vendor/dep", "2222222222222222222222222222222222222222");
    s.commit_index(
        "sub: bump the submodule pointer",
        "Submodule scenario: the diff should show a subproject commit change,\nideally with both short OIDs visible.",
    );
}
