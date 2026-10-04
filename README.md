# vikunja-tasks — a Vikunja pane for Claude Code

A Claude Code mod (a plugin of function hooks) that puts your [Vikunja](https://vikunja.io) board
beside the conversation, so the task you and Claude are working on is in view while you work on it.

- **Lanes at a glance.** Doing, Blocked and To-Do across every project, grouped by project, with
  priority and assignees. Filter by assignee, project, priority or due date (overdue, due in the next seven days); hide Blocked with a toggle.
- **The session's own task opens by itself.** When a Vikunja MCP call in the session names a task,
  the pane switches to it, and re-reads it every 10 seconds so you see it change as Claude updates it.
- **Task detail in the pane.** Description and comments, drawn as markdown, without leaving the app.
- **Start a session on a task.** Give a task a folder, press *Start session*, and a new session is
  offered in that folder, briefed with the task.

> ⚠️ Function-hook plugins are an early-access Claude Code API that moves between releases. This was
> built against **Claude Code 2.1.286** and has only been run in its desktop app on Windows. Run
> `claude plugin validate .` after an update. What has and has not been checked is under
> [What has been tested](#what-has-been-tested).

## Requirements

- Claude Code 2.1.286 (the build it was written against; later builds may move the API).
- A Vikunja server you can reach, and an API token for it.
- For auto-open: a Vikunja MCP server in the session whose tools are named `mcp__vikunja__…`
  (the names [vikunja-mcp-ng](https://github.com/netadvanced/vikunja-mcp-ng) v0.6.0 uses). The pane works without it.
- For *Start session*: the Claude desktop app, which provides the session-offer tool. In the terminal
  the button reports that it cannot offer a session.

## Install

Clone the repo, then tell Claude Code to load it. Either per run:

```bash
claude --plugin-dir /path/to/claude-code-vikunja-tasks
```

or for every session, including ones the desktop app starts, in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-vikunja-tasks"
  }
}
```

The mod reads two variables from the environment Claude Code starts in. It never prints either.

| Variable | Value |
|---|---|
| `VIKUNJA_URL` | The API base, ending in `/api/v1` — e.g. `https://tasks.example.com/api/v1` |
| `VIKUNJA_API_TOKEN` | A Vikunja API token (`tk_…`) |

## Options

Set under `pluginConfigs` in `~/.claude/settings.json`. All are optional.

```json
{
  "pluginConfigs": {
    "vikunja-tasks": {
      "options": {
        "webUrl": "https://tasks.example.com",
        "folderRoot": "/home/me/code",
        "hiddenProjects": "home improvement"
      }
    }
  }
}
```

| Option | What it does |
|---|---|
| `webUrl` | Where *Open in Vikunja* points (`http` or `https`). Empty means no button. |
| `folderRoot` | The one directory every task folder lives directly under. Empty turns the folder picker off. |
| `hiddenProjects` | Text in the title of a top-level project. That project and everything under it is left out of the lists by default; the Project filter brings it back. |

## Using it

The pane opens when a session starts. `/vikunja` reopens it and refreshes.

- Click a task to read it; **‹ All tasks** (or `b`) goes back.
- While the pane has the keyboard: `r` refreshes, and on a task `o` opens it in Vikunja.
- The first click after typing in the prompt gives the pane the keyboard; clicks after that are single.
- A lane is found by its bucket's name: `Doing`, `Blocked`, and `To-Do` (also `Todo` or `Backlog`).

### How a task knows its folder

Vikunja has no custom fields, so the folder is a **label** on the task named `folder: <path>`. It
shows as a chip in Vikunja and any other client can read it. The mod only ever adds or removes that
one label — it never sends a task update, which in Vikunja's API replaces the whole task.

Picking *Another or new folder…* and typing a name uses the folder if it exists under `folderRoot`
and creates it if not. A created folder holds one empty `.gitkeep`, because the plugin API makes a
directory only on the way to writing a file.

## What it does to your Vikunja

*Open in Vikunja* runs your system's URL opener (`rundll32` on Windows, `xdg-open` or `open` elsewhere) on the configured address.

Reads: projects, kanban buckets, tasks, comments, labels. Writes: creating a `folder: …` label,
and adding or removing it on a task — and only when you use the folder picker.

## What has been tested

- **Automated:** `claude plugin test .` mounts the pane on the desktop and terminal surfaces against a
  **fake** Vikunja written into the test. It covers drawing, opening a task, the filters, the folder
  label calls and their order, folder creation, and what Start session and Open hand to the host. It
  proves the mod's logic and that the surface accepts what it draws, not that a real server agrees.
- **Used by hand**, in the desktop app on Windows, against Vikunja v2.4.0: the lanes, filters, task
  detail, auto-open, live refresh, and the keyboard shortcuts.
- **Not yet exercised against a real server:** saving a folder label, creating a folder, and
  *Start session*. Nothing has been run in the terminal, on macOS or on Linux.

## Developing

```bash
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # mounts the pane on the desktop and terminal surfaces against a fake Vikunja
```

Two limits worth knowing, both found the hard way:

- A `Select` takes at most **64 options**. One more and the whole tree is refused, so the pane goes
  blank. Every list of choices here is cut before it is drawn.
- Text is laid out in a proportional font on the desktop, so character-count truncation runs short.

## Licence

MIT — see [LICENSE](LICENSE).
