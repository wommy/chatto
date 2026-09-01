# Triage Labels

The sidecar skills speak about five triage roles. This file maps each role to
the label string in the `wommy/chatto` fork.

| Role in mattpocock/skills | Label in the fork | Meaning                                  |
| ------------------------- | ----------------- | ---------------------------------------- |
| `needs-triage`            | `needs-triage`    | A maintainer must evaluate this issue    |
| `needs-info`              | `needs-info`      | The reporter must give more information  |
| `ready-for-agent`         | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | `ready-for-human` | A human must do the work                 |
| `wontfix`                 | `wontfix`         | Nobody will do this work                 |

When a skill speaks about a role, apply the label string from this table.

Change the middle column if the fork starts to use different label names.

## Labels in the fork

Only `wontfix` exists in the fork now. The other four labels do not exist yet.
`/triage` fails if it applies a label that is not there. Create the four
labels before the first triage session:

```sh
gh label create needs-triage    --color d4c5f9 --description "A maintainer must evaluate this issue"
gh label create needs-info      --color fbca04 --description "The reporter must give more information"
gh label create ready-for-agent --color 0e8a16 --description "Fully specified, ready for an AFK agent"
gh label create ready-for-human --color 1d76db --description "A human must do the work"
```

Create them in the fork only.
