---
created: 2026-03-10T00:30:21.410Z
title: Git push does not trigger app graph update
area: general
files: []
---

## Problem

Running `git push` from the terminal does not trigger an update on the app's graph. The graph should reactively update when new commits are pushed to reflect the latest state, but it remains stale after a push operation performed outside the app.

## Solution

TBD - Investigate how the app detects git state changes. Likely needs a file watcher on git refs/hooks or a push hook that notifies the app to refresh.
