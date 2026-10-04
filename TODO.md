# TODO

> ⚠️ **This file is no longer the source of truth for OpenClaw tasks.** All OpenClaw work
> tracking lives in **Todoist** now, in the `openclaw` project.

## Todoist Project

- **Project Name** → `openclaw`
- **Project ID** → `6g442XQJVrvqJhCp`
- **Web URL** → <https://app.todoist.com/app/project/openclaw-6g442XQJVrvqJhCp>

### Sections

| Section       | ID                 | Purpose                                                                  |
| ------------- | ------------------ | ------------------------------------------------------------------------ |
| `Not started` | `6g4FW6x4wF2gh84G` | Backlog; new work lands here by default.                                 |
| `In progress` | `6g4FW75cgqm39CMG` | Actively being worked on.                                                |
| `Done`        | `6g4FW77rX473VXvp` | Completed (tasks can stay open here as a reference, or be fully closed). |

### Watch for the `(No Section)` Trap

Todoist lets a task live in a project *without* belonging to any section; it shows up
under a `(No Section)` heading at the top of the project. This happens more easily than
you'd think...

- **Quick Add** → typing a task with `#openclaw` but no `/section` drops it straight into
  `(No Section)`.
- **API / MCP `create_tasks`** → omitting `section_id` creates a sectionless task (the
  field is optional, so it's easy to forget).
- **Mobile share sheet / natural-language add** → rarely picks a section for you.
- **Deleting a section** → Todoist keeps the tasks but strips their section, so they fall
  back into `(No Section)`.

Sectionless tasks are invisible to anything that filters by section and quietly rot. When
you open the project, *sweep `(No Section)` first* and move each task into the right home
(usually `Not started`). To find them with an agent, list the project and filter for a
null `section_id`...

```js
const tasks = mcp__todoist__get_tasks_list({
  project_id: "6g442XQJVrvqJhCp",
  limit: 100,
});
const orphans = tasks.filter((t) => !t.section_id); // these live in (No Section)
```

Then batch them back into place with `mcp__todoist__move_tasks`, passing each `task_id`
with the target `section_id` (`6g4FW6x4wF2gh84G` for `Not started`).

## Accessing Todoist With Agents

The [todoist-mcp](https://npm.im/todoist-mcp) MCP server is a prerequisite, exposing tools
under the `mcp__todoist__*` namespace. Common ones include...

| Tool                                             | Use                                                         |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `mcp__todoist__get_projects_list`                | List all projects.                                          |
| `mcp__todoist__get_sections_list`                | List sections for a project.                                |
| `mcp__todoist__get_tasks_list`                   | List tasks in a project / section.                          |
| `mcp__todoist__get_tasks_by_filter`              | Advanced filter queries (priority, labels, due date).       |
| `mcp__todoist__create_tasks`                     | Create one or more tasks (batch).                           |
| `mcp__todoist__update_tasks`                     | Edit existing tasks (content, priority, labels, due, etc.). |
| `mcp__todoist__close_tasks`                      | Mark tasks as completed.                                    |
| `mcp__todoist__delete_tasks`                     | Permanently delete tasks.                                   |
| `mcp__todoist__move_tasks`                       | Move tasks between projects / sections.                     |
| `mcp__todoist__create_sections`                  | Create new sections.                                        |
| `mcp__todoist__get_comments` / `create_comments` | Read/write task comments.                                   |

### Quick Example » List Open OpenClaw Tasks

```js
mcp__todoist__get_tasks_list({
  project_id: "6g442XQJVrvqJhCp",
  limit: 50,
});
```

### Quick Example » Add a New Task to the Backlog

```js
mcp__todoist__create_tasks({
  items: [
    {
      project_id: "6g442XQJVrvqJhCp",
      section_id: "6g4FW6x4wF2gh84G", // Not started
      content: "Brief task title",
      description: "Longer description with context, links, file paths, etc.",
      priority: 1, // P4 = 1, P3 = 2, P2 = 3, P1 = 4 (inverted from UI)
    },
  ],
});
```

## Priority Mapping

**Important » The API Is Inverted From the UI.**

| User-facing          | API `priority` value |
| -------------------- | -------------------- |
| P1 (urgent)          | `4`                  |
| P2 (high)            | `3`                  |
| P3 (medium)          | `2`                  |
| P4 (normal, default) | `1`                  |

## Other Ways to Add Tasks

- **Todoist web / mobile / desktop app** → just add to the `openclaw` project.
- **Todoist REST API** → `curl` with `Authorization: Bearer <API_TOKEN>` against
  `api.todoist.com/rest/v2/tasks` works anywhere (API token lives in keychain / the
  gateway config).

## Why This File Still Exists

It's a pointer for contributors and future agent sessions that open the repo and look for
`TODO.md`. Without this note, it's not obvious the tasks have moved. Do *not* add real
tasks to this file; they'll get lost. Add them to Todoist.
