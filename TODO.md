# Features

## Icons & Visuals
- Add icon set and use it throughout the whole application ui
- Find a better icon for the tag pill

## Git Operations
- Discard changes
- Stage/unstage hunk
- Branch actions (delete)
- Tag actions (delete)
- Interactive rebase
- Conflict diffs
- Conflict resolution
- Check out branch after creating

## Commit & Staging Workflow
- When committing, we currently have a checkbox that says "amend previous commit". Let's change that to a three-way selector that selects between commit, amend, and stash
- Change the right sidebar "stage all changes" to a green button, and the "unstage all changes" to a red button
- When not collapsed, both unstaged and staged files should have the same height

## Commit Graph
- Ability to search for commit hashes, commit messages, and branches on the commit graph with cmd+f
- Add a small padding to the top (and bottom) of the commit graph
- Add a overflow to the commit graph. We currently cannot shrink the width of the graph column smaller than the width of the graph. We should be able to do that. And when we shrink smaller than the width of the graph, the commits the far right should stick (position sticky) to the right. So if we keep shrinking, we can eventually make it a single line of committ dots. One on top of on the top of the other. Just like GitKraken
- When I click on the references on the left pane, it should navigate to where that is on the graph
- When I create a new file, the whip is not showing on the commit graph. And the new file is not showing any diff when I click on it on the right pane.

## UI Layout & Navigation
- Multiple tabs
- Merge window top bar with the application tab+actions bar, saving vertical space and achieving a slicker look
- Add toggle to switch between list view and preview for files (everywhere file lists are shown)
- When the right pane is closed and they click on a commit or a branch or whatever that would change the right pane content, the right pane should toggle back open

## Notifications & Dialogs
- Introduce dialogs for errors/warns/updated and use it to replace all current errors/warnings

# Bugs

## Commit Graph
- Branch overflow pill is behind the commit graph. We should adjust the Z index
- The graph column header currently has a divider to the right, even when there is no other columns selected. For example, I currently have branch/tag, graph, and commit message. And to the right of message it has a divider even though it has no other fields after it.
