---
created: 2026-03-09T05:15:31.400Z
title: Add resizable and collapsible left and right panes
area: ui
files: []
---

## Problem

The left and right panes in the app have fixed widths with no way to resize or collapse them. Users should be able to:
1. Drag the inner border between panes to resize them
2. Collapse panes entirely via keyboard shortcuts (Cmd-J toggles the left pane, Cmd-K toggles the right pane)

## Solution

- Add drag-to-resize behavior on the inner border dividers between panes (left pane divider and right pane divider)
- Track pane widths in state, update on drag
- Implement Cmd-J keybinding to toggle (show/hide) the left pane
- Implement Cmd-K keybinding to toggle (show/hide) the right pane
- When collapsed, pane width goes to 0 and content is hidden; toggling restores previous width
