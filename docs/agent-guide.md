# Answering reviews with a coding agent

Trunk never runs an agent, holds credentials, or calls a model. You start your own
coding agent in the repository, and it answers the review comments you send through
the `trunk review` CLI on your machine. Any agent that can run shell commands and read
a long-running process's output, as it arrives or from a file the process writes, can do
this, Claude Code among them.

1. Install Trunk with `brew install --cask joaofnds/tap/trunk`. The cask puts `trunk`
   on your `PATH`. `trunk review guide` arrives in the first release after 0.59.0, and
   `trunk --version` shows which one you have.
2. Start your agent in the repository, for example `cd ~/code/my-project && claude`.
3. Tell it: "Run `trunk review guide` and follow what it prints."

Your agent asks before it runs each command the guide gives it unless its own settings
allow them, and it waits for your answer, so keep its window where you will see a
prompt.

The agent then watches the repository's reviews, and how soon a comment reaches it
depends on how its harness reads the watch's output. Each comment you send gets an answer:
a reply for a question, or a change in the working tree followed by a reply and an
`addressed` claim. If you reopen a claimed comment without replying, the agent asks
what is still missing and does not claim it again until you answer. A comment you hold
stays invisible to the agent until you send it.
The agent leaves its changes uncommitted for you to read as a diff, and only you can
mark a comment done or dismissed.

The guide spells every command with the absolute path of the binary that printed it,
so the agent keeps using that binary and its store. [review-cli.md](review-cli.md) is
the reference for the verbs the guide uses.
