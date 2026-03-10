---
created: 2026-03-10T01:19:59.168Z
title: Persist left and right pane open/close state
area: ui
files: []
---

## Problem

When the user opens or closes the left sidebar or right detail pane, the state is lost on page reload or navigation. The panes should remember whether they were open or closed so the user returns to the same layout they left.

## Solution

Persist pane open/close state to localStorage (or similar client-side storage). On app load, read the saved state and restore pane visibility accordingly.
