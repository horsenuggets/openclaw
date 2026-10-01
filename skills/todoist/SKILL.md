---
name: todoist
description:
  Manage tasks and projects in Todoist. Use when user asks about tasks, to-dos, reminders,
  or productivity.
homepage: https://todoist.com
metadata:
  openclaw:
    emoji: "✅"
    requires:
      bins: ["todoist"]
      env: ["TODOIST_API_TOKEN"]
    primaryEnv: "TODOIST_API_TOKEN"
    install:
      - id: npm
        kind: node
        package: "todoist-ts-cli@^0.2.0"
        bins: ["todoist"]
        label: "Install Todoist CLI (todoist-ts-cli)"
---

# Todoist CLI

CLI for Todoist task management, built on the official TypeScript SDK.

## Setup

1. Get API token from https://todoist.com/app/settings/integrations/developer
2. Authenticate:
   ```bash
   todoist auth <your-token>
   ```

## Commands

### Tasks

```bash
todoist                    # Show today's tasks (default)
todoist today              # Same as above
todoist tasks              # List tasks (today + overdue)
todoist tasks --all        # All tasks
todoist tasks -p "Work"    # Tasks in project
todoist tasks -f "p1"      # Filter query (priority 1)
todoist tasks --json
```

### Add Tasks

```bash
todoist add "Buy groceries"
todoist add "Meeting" --due "tomorrow 10am"
todoist add "Review PR" --due "today" --priority 1 --project "Work"
todoist add "Prep slides" --project "Work" --order 3
todoist add "Triage inbox" --project "Work" --order top
todoist add "Call mom" -d "sunday" -l "family"
```

### Manage Tasks

```bash
todoist view <id>          # View task details
todoist done <id>          # Complete task
todoist reopen <id>        # Reopen completed task
todoist update <id> --due "next week"
todoist move <id> -p "Personal"
todoist delete <id>
```

### Search

```bash
todoist search "meeting"
```

### Projects & Labels

```bash
todoist projects           # List projects
todoist project-add "New Project"
todoist labels             # List labels
todoist label-add "urgent"
```

### Comments

```bash
todoist comments <task-id>
todoist comment <task-id> "Note about this task"
```

## Filter Syntax

Todoist supports powerful filter queries:

- `p1`, `p2`, `p3`, `p4` for priority levels
- `today`, `tomorrow`, `overdue`
- `@label` for tasks with label
- `#project` for tasks in project
- `search: keyword` for searching

## Notes

- Task IDs are shown in task listings
- Due dates support natural language ("tomorrow", "next monday", "jan 15")
- Priority 1 is highest, 4 is lowest
- Use `--order <n>` (1 based) or `--order top` to insert at a specific position
