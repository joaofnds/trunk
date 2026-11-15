use syn::visit::{self, Visit};
use trunk_lib::activity::ActivityState;

#[test]
fn active_work_defers_preparation() {
    let state = ActivityState::default();
    let work = state.acquire().unwrap();

    assert_eq!(state.begin_prepare().unwrap_err().code, "update_busy");
    drop(work);
    assert!(state.begin_prepare().is_ok());
}

fn rust_sources(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    files
}

#[test]
fn every_ordinary_ipc_command_requires_an_activity_lease() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;

    for path in rust_sources(&root) {
        let source = std::fs::read_to_string(&path).unwrap();
        let mut lines = source.lines();
        while let Some(line) = lines.next() {
            if !line.trim_start().starts_with("#[tauri::command") {
                continue;
            }
            let mut signature = String::new();
            for line in lines.by_ref() {
                signature.push_str(line.split('{').next().unwrap());
                if line.contains('{') {
                    break;
                }
            }
            if signature.contains("fn updates_") {
                continue;
            }
            assert!(
                signature.contains(": crate::activity::Activity")
                    || signature.contains(": activity::Activity"),
                "{}: {signature}",
                path.display()
            );
            checked += 1;
        }
    }

    assert!(
        checked > 100,
        "the check must inspect the real command registry"
    );
}

#[test]
fn production_repository_executors_cannot_spawn_unowned_blocking_work() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = rust_sources(&root.join("commands"));
    sources.extend(
        [
            "state.rs",
            "watcher.rs",
            "background_fetch.rs",
            "remote_ops.rs",
        ]
        .map(|name| root.join(name)),
    );

    for path in sources {
        if path.file_name().is_some_and(|name| name == "updates.rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        let violations = unowned_executors(&source);
        assert!(violations.is_empty(), "{}: {violations:?}", path.display());
    }
}

fn unowned_executors(source: &str) -> Vec<String> {
    let file = syn::parse_file(source).expect("the executor guard must parse every source file");
    let mut guard = ExecutorGuard::default();
    guard.visit_file(&file);
    guard.violations
}

fn test_only(attributes: &[syn::Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .parse_args::<syn::Path>()
                .is_ok_and(|path| path.is_ident("test"))
    })
}

#[derive(Default)]
struct ExecutorGuard {
    violations: Vec<String>,
}

impl<'ast> Visit<'ast> for ExecutorGuard {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        let attributes = match item {
            syn::Item::Const(item) => &item.attrs,
            syn::Item::Enum(item) => &item.attrs,
            syn::Item::ExternCrate(item) => &item.attrs,
            syn::Item::Fn(item) => &item.attrs,
            syn::Item::ForeignMod(item) => &item.attrs,
            syn::Item::Impl(item) => &item.attrs,
            syn::Item::Macro(item) => &item.attrs,
            syn::Item::Mod(item) => &item.attrs,
            syn::Item::Static(item) => &item.attrs,
            syn::Item::Struct(item) => &item.attrs,
            syn::Item::Trait(item) => &item.attrs,
            syn::Item::TraitAlias(item) => &item.attrs,
            syn::Item::Type(item) => &item.attrs,
            syn::Item::Union(item) => &item.attrs,
            syn::Item::Use(item) => &item.attrs,
            _ => panic!("the executor guard must handle every item kind"),
        };
        if !test_only(attributes) {
            visit::visit_item(self, item);
        }
    }

    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        let attributes = match item {
            syn::ImplItem::Const(item) => &item.attrs,
            syn::ImplItem::Fn(item) => &item.attrs,
            syn::ImplItem::Type(item) => &item.attrs,
            syn::ImplItem::Macro(item) => &item.attrs,
            _ => panic!("the executor guard must handle every impl item kind"),
        };
        if !test_only(attributes) {
            visit::visit_impl_item(self, item);
        }
    }

    fn visit_trait_item(&mut self, item: &'ast syn::TraitItem) {
        let attributes = match item {
            syn::TraitItem::Const(item) => &item.attrs,
            syn::TraitItem::Fn(item) => &item.attrs,
            syn::TraitItem::Type(item) => &item.attrs,
            syn::TraitItem::Macro(item) => &item.attrs,
            _ => panic!("the executor guard must handle every trait item kind"),
        };
        if !test_only(attributes) {
            visit::visit_trait_item(self, item);
        }
    }

    fn visit_expr_path(&mut self, expression: &'ast syn::ExprPath) {
        let segments = &expression.path.segments;
        let blocking = segments
            .last()
            .is_some_and(|part| part.ident == "spawn_blocking");
        let thread = segments.last().is_some_and(|part| part.ident == "spawn")
            && segments
                .iter()
                .rev()
                .nth(1)
                .is_some_and(|part| part.ident == "thread");
        if blocking || thread {
            self.violations.push(
                segments
                    .iter()
                    .map(|part| part.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
            );
        }
        visit::visit_expr_path(self, expression);
    }

    fn visit_use_tree(&mut self, tree: &'ast syn::UseTree) {
        let imported = match tree {
            syn::UseTree::Name(name) => Some(&name.ident),
            syn::UseTree::Rename(rename) => Some(&rename.ident),
            _ => None,
        };
        if imported.is_some_and(|name| name == "spawn_blocking") {
            self.violations.push("spawn_blocking import".into());
        }
        visit::visit_use_tree(self, tree);
    }

    fn visit_token_stream(&mut self, stream: &'ast proc_macro2::TokenStream) {
        self.inspect_macro_tokens(stream);
    }
}

impl ExecutorGuard {
    fn inspect_macro_tokens(&mut self, stream: &proc_macro2::TokenStream) {
        use proc_macro2::TokenTree;

        let tokens: Vec<_> = stream.clone().into_iter().collect();
        for (index, token) in tokens.iter().enumerate() {
            match token {
                TokenTree::Group(group) => self.inspect_macro_tokens(&group.stream()),
                TokenTree::Ident(name) => {
                    let previous: Vec<_> = tokens[..index]
                        .iter()
                        .rev()
                        .take(3)
                        .map(ToString::to_string)
                        .collect();
                    if name == "spawn_blocking" && previous.first().is_none_or(|value| value != ".")
                        || name == "spawn" && previous == [":", ":", "thread"]
                    {
                        self.violations.push(format!("{name} in macro"));
                    }
                }
                TokenTree::Punct(_) | TokenTree::Literal(_) => {}
            }
        }
    }
}

#[test]
fn executor_guard_checks_production_after_test_only_helpers() {
    let source = r"
        #[cfg(test)]
        fn helper() { tauri::async_runtime::spawn_blocking(|| ()); }
        #[cfg(test)]
        mod tests { fn helper() { std::thread::spawn(|| ()); } }
        #[cfg(test)]
        impl Fixture { fn helper() { std::thread::spawn(|| ()); } }
        impl Fixture {
            #[cfg(test)]
            fn helper() { std::thread::spawn(|| ()); }
        }
        fn production() {
            activity.spawn_blocking(|| ());
            tauri::async_runtime::spawn_blocking(|| ());
            std::thread::spawn(|| ());
        }
    ";

    let violations = unowned_executors(source);

    assert_eq!(
        violations,
        ["tauri::async_runtime::spawn_blocking", "std::thread::spawn"]
    );
}

#[test]
fn executor_guard_checks_macro_bodies_without_matching_strings_or_guarded_calls() {
    let source = r#"
        fn production() {
            tokio::select! {
                _ = activity.spawn_blocking(|| ()) => {},
                _ = tauri::async_runtime::spawn_blocking(|| ()) => {},
            }
            invoke!(std::thread::spawn(|| ()));
            println!("thread::spawn and spawn_blocking are forbidden");
        }
    "#;

    let violations = unowned_executors(source);

    assert_eq!(violations, ["spawn_blocking in macro", "spawn in macro"]);
}

#[test]
fn executor_guard_rejects_renamed_blocking_executor_imports() {
    let source = "use tauri::async_runtime::spawn_blocking as run; fn work() { run(|| ()); }";

    let violations = unowned_executors(source);

    assert_eq!(violations, ["spawn_blocking import"]);
}

#[test]
fn executor_guard_detects_an_unowned_markdown_command_mutation() {
    let source = include_str!("../src/commands/markdown.rs");
    let (before, command) = source
        .split_once("pub async fn render_markdown_diff(")
        .unwrap();
    let mutated_command = command.replacen(
        "activity\n        .spawn_blocking",
        "tauri::async_runtime::spawn_blocking",
        1,
    );
    assert_ne!(
        mutated_command, command,
        "the mutation must change its target"
    );
    let mutant = format!("{before}pub async fn render_markdown_diff({mutated_command}");

    let violations = unowned_executors(&mutant);

    assert_eq!(violations, ["tauri::async_runtime::spawn_blocking"]);
}
