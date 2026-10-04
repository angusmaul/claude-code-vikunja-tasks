export type Task = {
  id: number
  identifier: string
  title: string
  priority: number
  isDone: boolean
  project: string
  assignees: string[]
  /** When it is due, in milliseconds since the epoch; 0 when it has no due date. */
  dueAt: number
  /** In a project under the tree `hiddenProjects` names, which the lists leave out by default. */
  isHome: boolean
  /** The working folder the task's `folder: <path>` label names; '' when none. */
  folder: string
  /** That label's id, to take it off again; 0 when none. */
  folderLabelId: number
}

export type Board = {
  doing: Task[]
  blocked: Task[]
  /** The To-Do lanes: not started, shown so a task can be started from here. */
  todo: Task[]
  /** Tasks a vikunja MCP call named in this session, whatever lane they sit in. */
  touched: Task[]
  /** `$.clock.now()` of the last successful fetch; 0 before the first. */
  fetchedAt: number
  /** Why the last fetch failed, or null. Never carries a header or the token. */
  error: string | null
}

export type Comment = { author: string; at: string; body: string[] }

/** The task the pane shows in full instead of the lanes. */
export type Detail = {
  task: Task
  /** The description as markdown, cut into blocks a Markdown element takes. */
  body: string[]
  comments: Comment[]
  created: string
  updated: string
  isLoading: boolean
}

/** What the list view shows; `all` in a field is no filter on it. */
export type Filters = {
  assignee: string
  project: string
  priority: string
  /** `hide` leaves the Blocked section out. */
  blocked: string
  /** `overdue`, `week` (due in the next seven days), or `all`. */
  due: string
}

/** A lookup by the number on the card (`#42`), across every project and lane, done tasks included. */
export type Search = {
  /** The number looked for, as digits; '' when no search is showing. */
  query: string
  results: Task[]
  isLoading: boolean
  error: string | null
}

/** The folder picker and the Start session button, per open task. */
export type Launch = {
  /** The folders directly under the drive every task folder lives on. */
  folders: string[]
  /** True while the person names a folder to create there. */
  isTyping: boolean
  /** What the last Start session or folder change came to; '' for nothing. */
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'vikunja-tasks': { board: Board; touchedIds: number[]; selected: Detail | null; openId: number; filters: Filters; launch: Launch; demo: boolean; search: Search }
  }
}
