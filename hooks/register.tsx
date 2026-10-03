import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Comment, Detail, Filters, Launch, Task } from '../types'

const PANE = 'vikunja-tasks'
const TITLE = 'Vikunja'

// What the plugin's `userConfig` sets, read once as the module registers.
// `webUrl`: where a task opens in a browser; a Link takes https only, so with
// anything else the link is left out. `folderRoot`: the one directory every
// task folder lives directly under. `hiddenProjects`: text in the title of a
// top-level project that, with everything under it, the lists leave out
// unless asked for.
const config = { webUrl: '', folderRoot: '', hiddenProjects: '' }
const sep = () => (config.folderRoot.includes('\\') ? '\\' : '/')
const underRoot = (name: string) => `${config.folderRoot}${name}`
const isHidden = (title: string) =>
  config.hiddenProjects !== '' && title.toLowerCase().includes(config.hiddenProjects.toLowerCase())
const POLL_MS = 60_000
// The open task is read again this often, so edits made elsewhere show up.
const LIVE_MS = 10_000
// Lane ids only change when a project or bucket is created, so they are
// looked up rarely: one small call per project.
const LANES_TTL_MS = 30 * 60_000
const PAGE = 50 // the server clamps per_page to 50 and says nothing

const LANE_COLOR: Record<string, string | undefined> = {
  doing: '#2f9e5b',
  blocked: '#e0a800',
  done: '#808080',
  'to-do': '#6b8afd',
}

// The ink a pill's label is written in, by the pill's fill: white on the
// darker fills, near-black on the lighter ones.
const DARK_INK = '#161616'
const LIGHT_INK = '#ffffff'
const INK: Record<string, string> = {
  '#2f9e5b': LIGHT_INK,
  '#e0a800': DARK_INK,
  '#808080': LIGHT_INK,
  '#6b8afd': LIGHT_INK,
  '#2bb3a3': DARK_INK,
  '#f07c1e': DARK_INK,
  '#e5484d': LIGHT_INK,
}

// One colour per priority, cool to hot, so every level reads as a level.
const PRIORITY_COLOR: Record<number, string> = {
  1: '#6b8afd',
  2: '#2bb3a3',
  3: '#e0a800',
  4: '#f07c1e',
  5: '#e5484d',
}

const ALL = 'all'
// The Project filter's value for "hidden projects too"; ALL leaves them out.
const EVERYTHING = 'everything'
const HIDE = 'hide'
const NO_FILTERS: Filters = { assignee: ALL, project: ALL, priority: ALL, blocked: ALL }
const filters = atom({ plugin: 'vikunja-tasks', key: 'filters' } as const, NO_FILTERS)

// Vikunja has no custom fields, so a task's working folder is a label on it:
// `folder: /work/repo`. It shows as a chip in Vikunja and any client can read it.
const FOLDER = 'folder: '
const FOLDER_COLOR = '6b8afd'
// What a new folder's name may not hold: Windows' reserved characters.
const BAD_NAME = /[\\/:*?"<>|]/
// More To-Do rows than this are not drawn; the filters narrow them.
const TODO_ROWS = 80
// A Select takes 64 options at most, and a tree with more is not drawn at
// all, so every list of choices is cut to this many before its fixed ones.
const CHOICES = 58
const SPAWN_TOOL = 'mcp__ccd_session__spawn_task'
const OTHER = '(other)'
const NO_LAUNCH: Launch = { folders: [], isTyping: false, note: '' }
const launch = atom({ plugin: 'vikunja-tasks', key: 'launch' } as const, NO_LAUNCH)

const EMPTY: Board = { doing: [], blocked: [], todo: [], touched: [], fetchedAt: 0, error: null }
const board = atom({ plugin: 'vikunja-tasks', key: 'board' } as const, EMPTY)
const touchedIds = atom({ plugin: 'vikunja-tasks', key: 'touchedIds' } as const, [])
const selected = atom({ plugin: 'vikunja-tasks', key: 'selected' } as const, null)
// Which task the pane shows in full; 0 is the lanes. Its own small value, so
// Back never waits on, or loses a write to, a detail still being fetched.
const openId = atom({ plugin: 'vikunja-tasks', key: 'openId' } as const, 0)

// Moves the pane's focus ring onto the control the next view leads with, so
// the keyboard the pane was given by a click is not dropped with the old view.
// Without it the desktop spends the next click on focusing the pane again,
// and every control needs pressing twice. Denied while the prompt holds the
// keyboard, which is the person's to give.
const keepFocus = ($: EngineInterface, key: string) =>
  $.ui.focus({ requestId: PANE, key }).catch(() => {})

type Lanes = {
  doing: number[]
  blocked: number[]
  todo: number[]
  projects: Record<number, string>
  home: Record<number, true>
  at: number
}
type Raw = Record<string, any>

let lanes: Lanes | null = null
let inFlight: Promise<void> | null = null

// The status is all a failure reports: an error's own text can echo the
// request, and the request carries the token.
class Unreachable extends Error {}

const client = async ($: EngineInterface) => {
  const token = await $.env.get('VIKUNJA_API_TOKEN')
  const base = ((await $.env.get('VIKUNJA_URL')) ?? '').replace(/\/+$/, '')

  if (!token || base === '') {
    throw new Unreachable('Set VIKUNJA_URL (…/api/v1) and VIKUNJA_API_TOKEN in the environment Claude Code starts in')
  }

  return async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    let status = 0
    let text = ''

    try {
      const res = await $.http.fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      status = res.status
      text = res.text
    } catch {
      throw new Unreachable('Vikunja did not answer')
    }

    if (status < 200 || status > 299) {
      throw new Unreachable(`Vikunja answered HTTP ${status}`)
    }

    return text === '' ? null : JSON.parse(text)
  }
}

const paged = async (get: (path: string) => Promise<any>, path: string): Promise<Raw[]> => {
  const rows: Raw[] = []
  const join = path.includes('?') ? '&' : '?'

  for (let page = 1; page <= 20; page += 1) {
    const batch: Raw[] = (await get(`${path}${join}per_page=${PAGE}&page=${page}`)) ?? []
    rows.push(...batch)

    if (batch.length < PAGE) {
      break
    }
  }

  return rows
}

const findLanes = async (get: (path: string) => Promise<any>, now: number): Promise<Lanes> => {
  const projects = (await paged(get, '/projects')).filter(p => !p.is_archived)
  const found: Lanes = { doing: [], blocked: [], todo: [], projects: {}, home: {}, at: now }
  const byId = new Map(projects.map(p => [p.id as number, p]))

  for (const p of projects) {
    let root = p

    for (let hops = 0; hops < 20 && byId.has(root.parent_project_id); hops += 1) {
      root = byId.get(root.parent_project_id) as Raw
    }

    if (isHidden(String(root.title))) {
      found.home[p.id] = true
    }
  }

  await Promise.all(
    projects.map(async p => {
      found.projects[p.id] = p.title
      const kanban = (p.views ?? []).find((v: Raw) => v.view_kind === 'kanban')

      if (!kanban) {
        return
      }

      const buckets: Raw[] = (await get(`/projects/${p.id}/views/${kanban.id}/buckets`)) ?? []

      for (const b of buckets) {
        const name = String(b.title).trim().toLowerCase()

        if (name === 'doing') {
          found.doing.push(b.id)
        } else if (name === 'blocked') {
          found.blocked.push(b.id)
        } else if (['to-do', 'todo', 'to do', 'backlog'].includes(name)) {
          found.todo.push(b.id)
        }
      }
    }),
  )

  return found
}

const folderLabel = (raw: Raw): Raw | undefined =>
  ((raw.labels as Raw[] | null) ?? []).find(l => String(l.title).startsWith(FOLDER))

const toTask = (raw: Raw, projects: Record<number, string>): Task => ({
  folder: String(folderLabel(raw)?.title ?? '').slice(FOLDER.length),
  folderLabelId: folderLabel(raw)?.id ?? 0,
  id: raw.id,
  identifier: raw.identifier || `#${raw.id}`,
  title: raw.title,
  priority: raw.priority ?? 0,
  isDone: Boolean(raw.done),
  project: projects[raw.project_id] ?? `project ${raw.project_id}`,
  assignees: (raw.assignees ?? []).map((a: Raw) => a.username),
  isHome: lanes?.home[raw.project_id] === true,
})

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

// Vikunja stores descriptions and comments as HTML; the pane draws markdown.
const toMarkdown = (html: string): string =>
  html
    .replace(/\r/g, '')
    .replace(
      /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`,
    )
    .replace(/<\/?(strong|b)>/gi, '**')
    .replace(/<\/?(em|i)>/gi, '*')
    .replace(/<\/?code[^>]*>/gi, '`')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<h[1-6][^>]*>/gi, '\n#### ')
    .replace(/<li[^>]*>\s*(<p[^>]*>)?/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|ul|ol|li|div|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, entity => ENTITIES[entity] ?? entity)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

// One Markdown element takes a bounded string, so long text is drawn as
// several, cut between paragraphs.
const BLOCK = 3000
const toBlocks = (html: string): string[] => {
  const blocks: string[] = []
  let block = ''

  for (const paragraph of toMarkdown(html).split('\n\n')) {
    for (let at = 0; at < paragraph.length; at += BLOCK) {
      const piece = paragraph.slice(at, at + BLOCK)

      if (block !== '' && block.length + piece.length + 2 > BLOCK) {
        blocks.push(block)
        block = ''
      }

      block = block === '' ? piece : `${block}\n\n${piece}`
    }
  }

  return block === '' ? blocks : [...blocks, block]
}

const day = (iso: unknown) => (typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '')

const loadDetail = async ($: EngineInterface, task: Task) => {
  const before = await read($, selected)
  let detail: Detail

  try {
    const get = await client($)
    const [raw, notes] = await Promise.all([
      get(`/tasks/${task.id}`),
      get(`/tasks/${task.id}/comments`).catch(() => []),
    ])
    const comments: Comment[] = ((notes as Raw[]) ?? [])
      .map(c => ({
        author: c.author?.username ?? '?',
        at: day(c.created),
        body: toBlocks(String(c.comment ?? '')),
      }))
      .reverse() // newest first: what just happened is what is being watched
    detail = {
      task: toTask(raw, lanes?.projects ?? {}),
      body: toBlocks(String(raw.description ?? '')),
      comments,
      created: day(raw.created),
      updated: day(raw.updated),
      isLoading: false,
    }
  } catch (err) {
    const error = err instanceof Unreachable ? err.message : 'Vikunja answer could not be read'
    detail = { task, body: [error], comments: [], created: '', updated: '', isLoading: false }
  }

  // An unchanged task is not written again: a write redraws the pane, and a
  // redraw every few seconds would fight the person's scrolling.
  if (before !== null && JSON.stringify(before) === JSON.stringify(detail)) {
    return
  }

  if ((await read($, openId)) !== task.id) {
    return
  }

  await update($, selected, () => detail)

  if (before !== null && before.task.id === task.id && !before.isLoading && detail.updated !== '') {
    $.ui.toast(`Vikunja ${detail.task.identifier} updated`)
  }
}

const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() ===
  b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

const say = ($: EngineInterface, note: string) =>
  update($, launch, was => ({ ...NO_LAUNCH, ...was, isTyping: false, note }))

// The folders a task can be given: the directories directly under the root.
const knownFolders = async ($: EngineInterface) => {
  try {
    if (config.folderRoot === '') {
      return
    }

    const entries = await $.fs.list(config.folderRoot)
    const folders = entries
      .filter(e => e.kind === 'dir' && !/^[$.]/.test(e.name) && e.name !== 'System Volume Information')
      // The drive holds more folders than a picker takes: the most recently
      // changed ones are offered, and the name box reaches any other.
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CHOICES)
      .map(e => underRoot(e.name))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    await update($, launch, was => ({ ...NO_LAUNCH, ...was, folders }))
  } catch {
    // the picker keeps what it had
  }
}

// Makes a folder of that name under the root (or takes the one already there) and
// gives it to the task. `$.fs` makes directories only on the way to a file,
// so a new folder starts with an empty .gitkeep in it.
const createFolder = async ($: EngineInterface, task: Task, typed: string) => {
  const root = config.folderRoot.toLowerCase()
  const name = typed.trim().toLowerCase().startsWith(root) ? typed.trim().slice(root.length) : typed.trim()

  if (name === '' || name === '.' || name === '..' || BAD_NAME.test(name)) {
    await update($, launch, was => ({
      ...NO_LAUNCH,
      ...was,
      note: 'A folder name, with none of \\ / : * ? " < > |',
    }))

    return
  }

  const path = underRoot(name)

  try {
    if (!(await $.fs.exists(path))) {
      await $.fs.write(`${path}${sep()}.gitkeep`, '')
    }
  } catch {
    await say($, `Could not create ${path}.`)

    return
  }

  await setFolder($, task, path)
}

// Puts the task's folder label on it, making the label when no task has
// named that folder yet; '' takes the label off. Only label calls are used:
// they add and remove one thing, where a task update replaces the whole task.
const setFolder = async ($: EngineInterface, task: Task, path: string) => {
  const folder = path.trim()

  try {
    const send = await client($)

    if (task.folderLabelId !== 0 && !sameFolder(task.folder, folder)) {
      await send(`/tasks/${task.id}/labels/${task.folderLabelId}`, 'DELETE')
    }

    if (folder !== '' && !sameFolder(task.folder, folder)) {
      const title = `${FOLDER}${folder}`
      const labels = await paged(send, `/labels?s=${encodeURIComponent(FOLDER.trim())}`)
      const label =
        labels.find(l => l.title === title) ??
        (await send('/labels', 'PUT', { title, hex_color: FOLDER_COLOR }))
      await send(`/tasks/${task.id}/labels`, 'PUT', { label_id: label.id })
    }

    await say($, '')
  } catch (err) {
    await say($, err instanceof Unreachable ? `Folder not saved: ${err.message}` : 'Folder not saved.')
  }

  await loadDetail($, task)
  void knownFolders($)
}

// Offers a new session for the task in its folder. The desktop app shows the
// offer as a chip in the conversation, and the person's click starts it.
const startSession = async ($: EngineInterface, detail: Detail) => {
  const t = detail.task
  const here = await $.session.cwd().catch(() => '')
  const title = `Work on Vikunja ${t.identifier}: ${t.title}`
  const prompt = [
    `Work on Vikunja task id ${t.id} (${t.identifier} in project "${t.project}"): ${t.title}`,
    '',
    `Start by reading the task and its comments through the vikunja MCP (vikunja_tasks get, id ${t.id}),`,
    'move the task to Doing if it is not there, and record what was',
    'done on the task when finished.',
    '',
    'The description as it stood when this session was started:',
    '',
    detail.body.join('\n\n').slice(0, 6000) || '(none)',
  ].join('\n')

  await say($, 'Offering a session…')

  try {
    const ran = await $.tool.call({
      tool: SPAWN_TOOL,
      title: title.length > 58 ? `${title.slice(0, 57)}…` : title,
      prompt,
      tldr: `You pressed Start session on ${t.identifier} in the Vikunja pane. This opens a session in ${t.folder} to work on that task.`,
      // The tool takes cwd only for a project other than this session's.
      ...(sameFolder(here, t.folder) ? {} : { cwd: t.folder }),
      consent: `The user pressed "Start session" on Vikunja task ${t.identifier} in the Vikunja pane`,
    } as never)

    if (ran.deny !== undefined) {
      await say($, 'Not started: the call was declined.')
    } else if (ran.isError) {
      await say($, `Not started: ${(ran.text ?? 'the app refused it').split('\n')[0].slice(0, 160)}`)
    } else {
      await say($, 'Session offered. Click its chip in the conversation to start it.')
    }
  } catch {
    await say($, 'Not started: this app has no way to offer a session from a pane.')
  }
}

const show = async ($: EngineInterface, task: Task) => {
  await update($, selected, () => ({
    task,
    body: [],
    comments: [],
    created: '',
    updated: '',
    isLoading: true,
  }))
  await update($, openId, () => task.id)
  await update($, launch, was => ({ ...NO_LAUNCH, folders: was?.folders ?? [] }))
  void knownFolders($)
  void keepFocus($, 'back')
  await loadDetail($, task)
}

// The task the session is working on takes the pane without being asked for.
const autoOpen = async ($: EngineInterface, id: number) => {
  if ((await read($, openId)) === id) {
    const open = await read($, selected)

    return open === null ? undefined : loadDetail($, open.task)
  }

  const now = await read($, board)
  const known = [...now.touched, ...now.doing, ...now.blocked, ...(now.todo ?? [])].find(t => t.id === id)
  void $.ui.open({ id: PANE, title: TITLE })

  return show(
    $,
    known ?? { id, identifier: `#${id}`, title: '…', priority: 0, isDone: false, project: '', assignees: [], isHome: false, folder: '', folderLabelId: 0 },
  )
}

const byProjectThenPriority = (a: Task, b: Task) =>
  a.project.localeCompare(b.project) || b.priority - a.priority || a.id - b.id

const load = async ($: EngineInterface, isForced: boolean) => {
  const now = await $.clock.now()

  try {
    const get = await client($)

    if (isForced || lanes === null || now - lanes.at > LANES_TTL_MS) {
      lanes = await findLanes(get, now)
    }

    const { projects } = lanes
    // A task read through /tasks reports bucket_id 0, so each lane is its own query.
    const inLane = async (ids: number[]) => {
      if (ids.length === 0) {
        return []
      }

      const filter = encodeURIComponent(`done = false && bucket_id in ${ids.join(', ')}`)
      const rows = await paged(get, `/tasks?filter=${filter}`)

      return rows.map(r => toTask(r, projects)).sort(byProjectThenPriority)
    }

    const ids = await read($, touchedIds)
    const [doing, blocked, todo, touched] = await Promise.all([
      inLane(lanes.doing),
      inLane(lanes.blocked),
      inLane(lanes.todo),
      Promise.all(
        ids.map(id =>
          get(`/tasks/${id}`)
            .then(r => toTask(r, projects))
            .catch(() => null), // deleted since it was touched
        ),
      ),
    ])

    await update($, board, () => ({
      doing,
      blocked,
      todo,
      touched: touched.filter((t): t is Task => t !== null),
      fetchedAt: now,
      error: null,
    }))
    $.ui.status(`Vikunja ${doing.length} doing · ${blocked.length} blocked`)

    const open = await read($, selected)

    if (open !== null && (await read($, openId)) === open.task.id) {
      await loadDetail($, open.task)
    }
  } catch (err) {
    const error = err instanceof Unreachable ? err.message : 'Vikunja answer could not be read'
    await update($, board, was => ({ ...(was ?? EMPTY), error }))
    $.ui.status('Vikunja unreachable')
  }
}

const refresh = ($: EngineInterface, isForced = false): Promise<void> => {
  if (inFlight === null) {
    inFlight = load($, isForced).finally(() => {
      inFlight = null
    })
  }

  return inFlight
}

const clock = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

export const register: Register = (on, options) => {
  const text = (key: string) => (typeof options?.[key] === 'string' ? (options[key] as string).trim() : '')
  config.webUrl = text('webUrl').replace(/\/+$/, '')
  config.hiddenProjects = text('hiddenProjects')
  // The root always ends in its separator, so a name is appended as it is.
  const root = text('folderRoot')
  config.folderRoot = root === '' || /[\\/]$/.test(root) ? root : `${root}${root.includes('\\') ? '\\' : '/'}`

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vikunja',
      description: 'Show the Vikunja tasks in Doing, Blocked and To-Do, and the ones this session touched',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(LIVE_MS, async () => {
      const open = await read($, selected)

      if (open !== null && !open.isLoading && (await read($, openId)) === open.task.id) {
        await loadDetail($, open.task)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'vikunja' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($, true)
    const now = await read($, board)

    return {
      text: now.error ?? `Vikunja: ${now.doing.length} doing, ${now.blocked.length} blocked.`,
    }
  })

  // A vikunja MCP call that names a task puts it in "This session", and any
  // vikunja call may have moved a card, so the board is read again after it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.tool.startsWith('mcp__vikunja__')) {
      const args = e as unknown as Record<string, unknown>
      const named: number[] = []

      if (e.tool.startsWith('mcp__vikunja__vikunja_task')) {
        for (const value of [args.id, args.otherTaskId, ...((args.taskIds as unknown[]) ?? [])]) {
          if (typeof value === 'number' && value > 0) {
            named.push(value)
          }
        }
      }

      // A created task has no id to name yet; the answer carries it.
      if (args.subcommand === 'create' && named.length === 0 && 'text' in ran) {
        const made = /"id"\s*:\s*(\d+)/.exec(ran.text ?? '')

        if (made !== null) {
          named.push(Number(made[1]))
        }
      }

      if (named.length > 0) {
        await update($, touchedIds, ids => [...new Set([...(ids ?? []), ...named])].slice(-30))
        void refresh($).then(() => autoOpen($, named[0]))
      } else {
        void refresh($)
      }
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const now = await read($, board)
    const shown = await read($, openId)
    const detail = shown === 0 ? null : await read($, selected)
    const open = detail !== null && detail.task.id === shown ? detail : null
    const start = { ...NO_LAUNCH, ...(await read($, launch)) }
    const columns = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    const touched = new Set(now.touched.map(t => t.id))
    const doing = new Set(now.doing.map(t => t.id))
    const blocked = new Set(now.blocked.map(t => t.id))

    const laneOf = (t: Task) =>
      t.isDone ? 'done' : doing.has(t.id) ? 'doing' : blocked.has(t.id) ? 'blocked' : 'to-do'

    // A filled chip: the fill says which level or lane, the label which one.
    const pill = (label: string, fill: string | undefined) => (
      <Text bold backgroundColor={fill} color={INK[fill ?? ''] ?? LIGHT_INK}>
        {` ${label} `}
      </Text>
    )

    // A priority's chip: the fill is a box of one fixed width with the label
    // centred in it, so P1 and P4 take the same room whatever the font.
    const priorityPill = (priority: number) => (
      <Box width={4} flexShrink={0} justifyContent="center" backgroundColor={PRIORITY_COLOR[priority]}>
        <Text bold color={INK[PRIORITY_COLOR[priority]] ?? LIGHT_INK}>
          P{priority}
        </Text>
      </Box>
    )

    if (open !== null) {
      const t = open.task
      const lane = laneOf(t)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button
              key="back"
              label="‹ All tasks"
              hotkey="b"
              autoFocus
              onPress={async () => {
                await update($, openId, () => 0)
                void keepFocus($, 'refresh')
              }}
            />
            {config.webUrl.startsWith('https://') && (
              <Link href={`${config.webUrl}/tasks/${t.id}`} label="Open in Vikunja ↗" />
            )}
          </Box>

          <Box flexDirection="column">
            <Text dimColor>
              {[t.project, t.identifier].filter(Boolean).join(' · ')}
            </Text>
            <Text bold>{t.title}</Text>
            <Box flexDirection="row" gap={1}>
              {pill(lane.toUpperCase(), LANE_COLOR[lane])}
              {t.priority > 0 && priorityPill(t.priority)}
              {t.assignees.length > 0 && <Text dimColor>{t.assignees.join(', ')}</Text>}
            </Box>
            <Text dimColor>
              {open.isLoading
                ? 'loading…'
                : `updated ${open.updated} · live, checked every ${LIVE_MS / 1000}s`}
            </Text>
          </Box>

          <Box flexDirection="column">
            <Text bold dimColor>
              SESSION
            </Text>
            {config.folderRoot === '' ? (
              <Text dimColor>Set folderRoot in this plugin's options to give tasks a folder.</Text>
            ) : 'Select' in table ? (
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                <table.Select
                  key="folder"
                  label="Folder"
                  value={start.isTyping ? OTHER : t.folder}
                  options={[
                    { value: '', label: 'Not set' },
                    ...[...new Set([t.folder, ...start.folders].filter(Boolean))].slice(0, CHOICES + 1).map(value => ({ value })),
                    { value: OTHER, label: 'Another or new folder…' },
                  ]}
                  onSelect={value =>
                    value === OTHER
                      ? void update($, launch, was => ({ ...NO_LAUNCH, ...was, isTyping: true, note: '' }))
                      : void setFolder($, t, value)
                  }
                />
                {t.folder !== '' && (
                  <Button
                    key="start-session"
                    variant="primary"
                    label="Start session"
                    onPress={() => void startSession($, open)}
                  />
                )}
                <Button key="reload-folder" plain dimColor label="Reload" onPress={() => void loadDetail($, t)} />
              </Box>
            ) : (
              <Text dimColor>{t.folder === '' ? 'No folder set.' : t.folder}</Text>
            )}
            {start.isTyping && 'Input' in table && (
              <table.Input
                key="folder-path"
                label={`Folder name  ${config.folderRoot}`}
                placeholder="project-name"
                submitLabel="use or create"
                onSubmit={value => void createFolder($, t, value)}
              />
            )}
            {t.folder === '' && !start.isTyping && (
              <Text dimColor>Pick the folder this task is worked on in to start a session there.</Text>
            )}
            {start.note !== '' && <Text>{start.note}</Text>}
          </Box>


          <Box flexDirection="column">
            <Text bold dimColor>
              DESCRIPTION
            </Text>
            {!open.isLoading && open.body.length === 0 && <Text dimColor>None.</Text>}
            {open.body.map(block => (
              <Markdown text={block} />
            ))}
          </Box>

          {open.comments.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Text bold dimColor>
                COMMENTS · {open.comments.length} · newest first
              </Text>
              {open.comments.map(c => (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold>{c.author}</Text>
                    <Text dimColor>{c.at}</Text>
                  </Box>
                  {c.body.map(block => (
                    <Markdown text={block} />
                  ))}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // A row lights under the pointer: a translucent grey that sits on either
    // theme where the surface blends it; the terminal has no alpha, so there
    // the number and the underlined title carry the highlight alone.
    const rowHover = e.surface === 'terminal' ? {} : { backgroundColor: '#80808030' }

    // The title is the Button, so it is cut to the pane here; the number and
    // the facts sit either side of it as plain text.
    const row = (section: string, t: Task, facts: string) => {
      // The desktop's letters run narrower than the cells `columns` counts,
      // so the cut is looser than the cell arithmetic; the box clips the rest.
      const room = Math.max(12, Math.floor((columns - facts.length - 20) * 1.45))
      const title = t.title.length > room ? `${t.title.slice(0, room - 1)}…` : t.title

      return (
        <Box key={`row-${section}-${t.id}`} flexDirection="row" gap={1} hover={rowHover}>
          <Box width={4} flexShrink={0}>
            <Text
              color={touched.has(t.id) ? 'cyan' : undefined}
              dimColor={!touched.has(t.id)}
              hover={{ color: 'cyan', dimColor: false }}
            >
              {t.identifier}
            </Text>
          </Box>
          <Box flexShrink={1} overflow="hidden">
            <Button
              key={`open-${section}-${t.id}`}
              plain
              dimColor={t.isDone}
              label={t.isDone ? `✓ ${title}` : title}
              hover={{ underline: true }}
              onPress={() => void show($, t)}
            />
          </Box>
          <Box flexGrow={1} />
          <Text dimColor>{facts}</Text>
          {section === 'session' && pill(laneOf(t).toUpperCase(), LANE_COLOR[laneOf(t)])}
          {/* the pill's slot is kept when a task has no priority, so the column stays straight */}
          {t.priority > 0 ? priorityPill(t.priority) : <Box width={4} flexShrink={0} />}
        </Box>
      )
    }

    const picked = { ...NO_FILTERS, ...(await read($, filters)) }
    // The Blocked toggle shows its own state, so it does not count as a filter to clear.
    const isFiltered = [picked.assignee, picked.project, picked.priority].some(value => value !== ALL)
    const passes = (t: Task) =>
      (picked.project === ALL
        ? !t.isHome || touched.has(t.id) // a hidden task the session is on still shows
        : picked.project === EVERYTHING || t.project === picked.project) &&
      (picked.assignee === ALL ||
        (picked.assignee === 'nobody' ? t.assignees.length === 0 : t.assignees.includes(picked.assignee))) &&
      (picked.priority === ALL ||
        (picked.priority === 'unset' ? t.priority === 0 : t.priority >= Number(picked.priority)))
    const todo = now.todo ?? [] // a board stored before To-Do was read has none
    const everything = [...now.doing, ...now.blocked, ...todo, ...now.touched]
    const choices = (values: string[]) =>
      [...new Set(values)].sort((a, b) => a.localeCompare(b)).slice(0, CHOICES)
    const pick = (key: keyof Filters) => (value: string) =>
      void update($, filters, was => ({ ...NO_FILTERS, ...was, [key]: value }))

    const section = (name: string, color: string | undefined, all: Task[], most = Infinity) => {
      const matching = all.filter(passes)
      const tasks = matching.slice(0, most)
      // "n of m" is against what a filter the person set left out; the hidden
      // projects the default view leaves out are not part of either number.
      const inScope = picked.project === ALL ? all.filter(t => !t.isHome || touched.has(t.id)) : all
      const projects = [...new Set(tasks.map(t => t.project))]

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold color={color}>
              {name.toUpperCase()}
            </Text>
            <Text dimColor>
              {matching.length === inScope.length ? `${inScope.length}` : `${matching.length} of ${inScope.length}`}
            </Text>
          </Box>
          {tasks.length === 0 && (
            <Text dimColor>{inScope.length === 0 ? 'Nothing here.' : 'Nothing matches the filters.'}</Text>
          )}
          {projects.map(project => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor italic>
                {project}
              </Text>
              {tasks.filter(t => t.project === project).map(t => row(name, t, t.assignees.join(', ')))}
            </Box>
          ))}
          {matching.length > tasks.length && (
            <Box marginTop={1}>
              <Text dimColor>
                {matching.length - tasks.length} more not shown. Narrow them with the filters.
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {now.fetchedAt === 0 ? 'loading…' : `as of ${clock(now.fetchedAt)}`}
          </Text>
          <Button key="refresh" label="Refresh" autoFocus onPress={() => void refresh($, true)} />
        </Box>
        {'Select' in table && (
          <Box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={2}
            borderStyle="round"
            borderColor="#808080"
            paddingX={1}
          >
            <table.Select
              key="filter-assignee"
              label="Who"
              value={picked.assignee}
              options={[
                { value: ALL, label: 'Anyone' },
                ...choices(everything.flatMap(t => t.assignees)).map(value => ({ value })),
                { value: 'nobody', label: 'Unassigned' },
              ]}
              onSelect={pick('assignee')}
            />
            <table.Select
              key="filter-project"
              label="Project"
              value={picked.project}
              options={[
                ...(config.hiddenProjects === ''
                  ? [{ value: ALL, label: 'All projects' }]
                  : [
                      { value: ALL, label: `All but ${config.hiddenProjects}` },
                      { value: EVERYTHING, label: 'Everything' },
                    ]),
                ...choices(everything.map(t => t.project)).map(value => ({ value })),
              ]}
              onSelect={pick('project')}
            />
            <table.Select
              key="filter-priority"
              label="Priority"
              value={picked.priority}
              options={[
                { value: ALL, label: 'Any' },
                { value: '5', label: 'P5 only' },
                { value: '4', label: 'P4 and up' },
                { value: '3', label: 'P3 and up' },
                { value: '2', label: 'P2 and up' },
                { value: '1', label: 'P1 and up' },
                { value: 'unset', label: 'Not set' },
              ]}
              onSelect={pick('priority')}
            />
            <Box flexDirection="row" alignItems="center">
              <Text dimColor>Blocked </Text>
              <Button
                key="blocked-show"
                label="Show"
                variant={picked.blocked === HIDE ? 'secondary' : 'primary'}
                onPress={() => pick('blocked')(ALL)}
              />
              <Button
                key="blocked-hide"
                label="Hide"
                variant={picked.blocked === HIDE ? 'primary' : 'secondary'}
                onPress={() => pick('blocked')(HIDE)}
              />
            </Box>
            {isFiltered && (
              <Button key="clear-filters" plain label="Clear" onPress={() => void update($, filters, was => ({ ...NO_FILTERS, blocked: was?.blocked ?? ALL }))} />
            )}
          </Box>
        )}
        {now.error !== null && (
          <Text bold color="red">
            {now.error}
          </Text>
        )}
        {now.touched.filter(passes).length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold color="cyan">
                THIS SESSION
              </Text>
              <Text dimColor>{now.touched.filter(passes).length}</Text>
            </Box>
            {now.touched.filter(passes).map(t => row('session', t, t.project))}
          </Box>
        )}
        {section('Doing', LANE_COLOR.doing, now.doing)}
        {picked.blocked !== HIDE && section('Blocked', LANE_COLOR.blocked, now.blocked)}
        {section('To-Do', LANE_COLOR['to-do'], todo, TODO_ROWS)}
      </Box>
    )
  })
}
