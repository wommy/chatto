# Triage Labels

The label string for each of the five triage roles.

`/triage` reads this file. [`issue-tracker.md`](issue-tracker.md) gives the
tools that apply a label.

The skills speak about a role. This table maps each role to the label string
in the `wommy/chatto` fork.

| Role in mattpocock/skills | Label in the fork | Meaning                                  |
| ------------------------- | ----------------- | ---------------------------------------- |
| `needs-triage`            | `needs-triage`    | A maintainer must evaluate this issue    |
| `needs-info`              | `needs-info`      | The reporter must give more information  |
| `ready-for-agent`         | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | `ready-for-human` | A human must do the work                 |
| `wontfix`                 | `wontfix`         | Nobody will do this work                 |

When a skill names a role, apply the label string from this table.

Change the middle column if the fork starts to use different label names.

## Labels in the fork

All five labels exist in the fork. `/triage` can apply each one.

They exist in the fork only. The upstream repository does not have the four
new ones.
