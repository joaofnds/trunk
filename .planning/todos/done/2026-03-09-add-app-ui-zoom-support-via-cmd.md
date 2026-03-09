---
created: 2026-03-09T04:57:26.285Z
title: Add app UI zoom support via Cmd-+
area: ui
files: []
---

## Problem

The app currently lacks keyboard-based zoom functionality. Users should be able to zoom in/out of the application UI using standard keyboard shortcuts (Cmd-+ to zoom in, Cmd-- to zoom out, Cmd-0 to reset). This is a common accessibility and usability expectation in desktop apps, allowing users to adjust the interface scale to their preference or visual needs.

## Solution

TBD — Investigate how the app renders its UI (webview, native, etc.) and implement zoom level management tied to Cmd-+/Cmd--/Cmd-0 keyboard shortcuts. Consider persisting the zoom preference across sessions.
