# Issue Tracker: GitHub

Where issues live, and which tools reach them.

`/to-tickets`, `/to-spec`, `/triage`, `/wayfinder`, and `/code-review` read
this file.

Issues live as GitHub issues in the `wommy/chatto` fork. Open every issue
there.

The label strings that `/triage` applies are in
[`triage-labels.md`](triage-labels.md).

## Which tools to use

Two tool sets reach the same issues. Use the set that your session has.

- **The `gh` CLI**, in a local session.
- **The GitHub MCP tools** (`mcp__github__*`), in a Claude Code remote
  session. A remote session does not have `gh`.

`gh` finds the repository from the clone. The MCP tools need an `owner` and a
`repo` parameter for each call.

## Operations

| Operation       | `gh` CLI                                       | GitHub MCP tool                       |
| --------------- | ---------------------------------------------- | ------------------------------------- |
| Create an issue | `gh issue create --title "..." --body "..."`    | `issue_write`, `method: create`       |
| Read an issue   | `gh issue view <n> --comments`                  | `issue_read`, `method: get`           |
| List issues     | `gh issue list --state open --label <label>`    | `list_issues`                         |
| Comment         | `gh issue comment <n> --body "..."`             | `add_issue_comment`                   |
| Change a label  | `gh issue edit <n> --add-label "..."`           | `issue_write`, `method: update`       |
| Close an issue  | `gh issue close <n> --comment "..."`            | `issue_write`, `state: closed`        |

Use a heredoc for a body that has more than one line.

## Pull requests as a triage surface

**PRs as a request surface: no.**

`/triage` reads issues only. Change this flag to `yes` to put external pull
requests in the triage queue.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in the fork.

## When a skill says "fetch the relevant ticket"

Read the GitHub issue and its comments.

## Issue numbers and pull request numbers

GitHub gives issues and pull requests one number space. A bare `#42` can be
either one. Read the issue first. If that fails, read the pull request.

## Wayfinder operations

`/wayfinder` uses one map issue and a set of child issues.

- **Map**: one issue with the label `wayfinder:map`. Its body holds the Notes,
  the Decisions so far, and the Fog.
- **Child ticket**: an issue attached to the map as a GitHub sub-issue. The MCP
  tool `issue_write` takes a `parent_issue_number` for this. Label each child
  `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
  `wayfinder:task`.
- **Blocking**: use GitHub issue dependencies. If dependencies are not
  available, put a `Blocked by: #<n>` line at the top of the child body. A
  ticket is free when each blocker is closed.
- **Frontier query**: list the open children of the map. Remove each child that
  has an open blocker or an assignee. The first one in map order wins.
- **Claim**: assign the ticket to yourself. This is the first write of the
  session.
- **Resolve**: comment the answer on the ticket, close the ticket, then add a
  pointer to the map's Decisions so far.
