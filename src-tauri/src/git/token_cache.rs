use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use git2::Oid;

use super::syntax;
use super::types::SyntaxToken;

/// Starting byte budget for the process-global token cache. Picked without a
/// real-workload measurement; task 2 records what one real entry costs next to
/// this constant without changing it.
pub const DEFAULT_TOKEN_CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Syntax tokens for every side of every diff, keyed by content OID and
/// grammar. A git OID is content identity, so the cache needs no
/// invalidation: the workdir side carries one too (verified, doc-5 §3).
#[derive(Clone)]
pub struct SyntaxTokenCache(Arc<Mutex<TokenCacheInner>>);

#[derive(PartialEq, Eq, Hash, Clone)]
struct TokenCacheKey {
    oid: Oid,
    extension: String,
}

struct TokenCacheEntry {
    tokens: Vec<Vec<SyntaxToken>>,
    byte_size: usize,
}

struct TokenCacheInner {
    entries: HashMap<TokenCacheKey, (TokenCacheEntry, u64)>,
    clock: u64,
    total_bytes: usize,
    budget_bytes: usize,
    parse_count: usize,
}

fn entry_bytes(tokens: &[Vec<SyntaxToken>]) -> usize {
    tokens
        .iter()
        .map(|line| {
            std::mem::size_of::<Vec<SyntaxToken>>()
                + line.len() * std::mem::size_of::<SyntaxToken>()
        })
        .sum()
}

impl SyntaxTokenCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self(Arc::new(Mutex::new(TokenCacheInner {
            entries: HashMap::new(),
            clock: 0,
            total_bytes: 0,
            budget_bytes,
            parse_count: 0,
        })))
    }

    /// Number of real parses this cache has performed, i.e. cache misses. Test-observable.
    pub fn parse_count(&self) -> usize {
        self.0.lock().unwrap().parse_count
    }

    /// Per-line syntax tokens for lines `1..=max_line` of `text`, keyed by
    /// `(oid, extension)`. A hit returns a clone under lock; a miss parses
    /// with the lock dropped, then re-locks to insert and evict. An entry
    /// parsed less deep than `max_line` is replaced by a fresh parse from
    /// line 1 (partial hits grow the entry, doc-5 decision 3).
    pub fn tokens_for(
        &self,
        oid: Oid,
        extension: &str,
        text: &str,
        max_line: u32,
    ) -> Vec<Vec<SyntaxToken>> {
        let key = TokenCacheKey {
            oid,
            extension: extension.to_string(),
        };

        {
            let mut inner = self.0.lock().unwrap();
            inner.clock += 1;
            let stamp = inner.clock;
            if let Some((entry, access)) = inner.entries.get_mut(&key)
                && entry.tokens.len() >= max_line as usize
            {
                *access = stamp;
                return entry.tokens.clone();
            }
        }

        let Some(mut highlighter) = syntax::create_highlighter(extension) else {
            return Vec::new();
        };
        let mut tokens: Vec<Vec<SyntaxToken>> = Vec::with_capacity(max_line as usize);
        for (idx, raw_line) in text.split('\n').enumerate() {
            if idx as u32 >= max_line {
                break;
            }
            tokens.push(syntax::highlight_line_with(&mut highlighter, raw_line));
        }

        let byte_size = entry_bytes(&tokens);
        let mut inner = self.0.lock().unwrap();
        inner.parse_count += 1;
        inner.clock += 1;
        let stamp = inner.clock;
        if let Some((old, _)) = inner.entries.remove(&key) {
            inner.total_bytes -= old.byte_size;
        }
        inner.total_bytes += byte_size;
        inner.entries.insert(
            key,
            (
                TokenCacheEntry {
                    tokens: tokens.clone(),
                    byte_size,
                },
                stamp,
            ),
        );
        evict(&mut inner);
        tokens
    }
}

fn evict(inner: &mut TokenCacheInner) {
    while inner.total_bytes > inner.budget_bytes {
        let Some(coldest) = inner
            .entries
            .iter()
            .min_by_key(|(_, (_, stamp))| *stamp)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        if let Some((entry, _)) = inner.entries.remove(&coldest) {
            inner.total_bytes -= entry.byte_size;
        }
    }
}
