// A pretend Vikunja, held in memory, that answers the handful of paths the
// pane reads and the two label writes it makes. `/vikunja demo` swaps it in
// for the real server, for screenshots and for trying the mod with no server.
// Nothing here touches the network, the disk or a real tracker.

type Raw = Record<string, any>

const DAY = 24 * 60 * 60_000
const TODO = 1
const DOING = 2
const BLOCKED = 3

export const DEMO_CONFIG = {
  webUrl: 'https://tasks.example.com',
  folderRoot: '~/code/',
  hiddenProjects: 'household',
}

export const DEMO_FOLDERS = ['atlas-api', 'atlas-web', 'field-notes', 'infra', 'orbit-mobile'].map(
  name => `${DEMO_CONFIG.folderRoot}${name}`,
)

const PROJECTS: Raw[] = [
  { id: 1, title: 'Atlas — web app', parent_project_id: 0 },
  { id: 2, title: 'Orbit — mobile', parent_project_id: 0 },
  { id: 3, title: 'Infrastructure', parent_project_id: 0 },
  { id: 4, title: 'Household', parent_project_id: 0 },
  { id: 5, title: 'Garden', parent_project_id: 4 },
].map(p => ({ ...p, is_archived: false, views: [{ id: p.id * 10, view_kind: 'kanban' }] }))

// [id, project, number, lane, priority, assignees, title, days until due (null: none)]
const ROWS: [number, number, number, number, number, string[], string, number | null][] = [
  [101, 1, 42, DOING, 4, ['alex'], 'Ship the new onboarding flow', 2],
  [102, 1, 47, DOING, 3, ['claude'], 'Migrate settings pages to the new form kit', null],
  [103, 2, 18, DOING, 2, ['claude'], 'Offline cache for the activity feed', 5],
  [104, 3, 7, DOING, 3, ['sam', 'claude'], 'Move nightly backups to object storage', null],
  [105, 1, 39, BLOCKED, 3, ['alex'], 'Payment provider webhook retries', -3],
  [106, 2, 21, BLOCKED, 1, ['claude'], 'Push notifications on older devices', null],
  [107, 3, 9, BLOCKED, 2, ['sam'], 'Renew the wildcard certificate', 1],
  [108, 1, 51, TODO, 5, ['alex'], 'Fix the login redirect loop', -1],
  [109, 1, 52, TODO, 2, ['claude'], 'Audit colour contrast on the dashboard', null],
  [110, 1, 53, TODO, 1, ['claude'], 'Tidy the unused feature flags', null],
  [111, 2, 24, TODO, 3, ['sam'], 'Deep links from email into the app', 6],
  [112, 2, 25, TODO, 2, ['claude'], 'Reduce cold-start time', null],
  [113, 3, 11, TODO, 2, ['sam'], 'Document the restore drill', 12],
  [114, 3, 12, TODO, 0, [], 'Trial a second monitoring probe', null],
  [115, 5, 3, DOING, 2, ['alex'], 'Regrout the bathroom tiles', null],
]

const BODY: Record<number, string> = {
  101:
    '<p>Replace the three-screen sign-up with a single guided flow.</p>' +
    '<ul><li>Email first, password second</li><li>Skip the profile step until first use</li>' +
    '<li>Keep the old route alive behind a flag for a week</li></ul>' +
    '<p>Rollout: <code>onboarding_v2</code> at 10%, then 50%, then everyone.</p>',
  103: '<p>Keep the last 200 feed items on the device so the feed opens without a connection.</p>',
}

const COMMENTS: Record<number, [string, number, string][]> = {
  101: [
    ['alex', -2, '<p>Copy is signed off. Flag is in.</p>'],
    ['claude', -1, '<p>Flow is behind <code>onboarding_v2</code>; 10% since this morning, no errors.</p>'],
  ],
}

let labels: Raw[] = [{ id: 900, title: `folder: ${DEMO_FOLDERS[0]}` }]
const onTask: Record<number, number[]> = { 101: [900] }

const iso = (ms: number) => new Date(ms).toISOString()

const toRaw = (row: (typeof ROWS)[number], now: number): Raw => {
  const [id, project, number, lane, priority, assignees, title, due] = row

  return {
    id,
    project_id: project,
    identifier: `#${number}`,
    index: number,
    title,
    priority,
    done: false,
    bucket: lane,
    assignees: assignees.map(username => ({ username })),
    due_date: due === null ? '0001-01-01T00:00:00Z' : iso(now + due * DAY),
    description: BODY[id] ?? '',
    created: iso(now - 9 * DAY),
    updated: iso(now - DAY / 6),
    labels: labels.filter(l => (onTask[id] ?? []).includes(l.id)),
  }
}

/** Answers one request as the pane's client would have Vikunja answer it. */
export const demoAnswer = (now: number, path: string, method: string, body: unknown): unknown => {
  const [route, query = ''] = path.split('?')
  const parts = route.split('/').filter(Boolean)
  const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
  const paged = <T>(rows: T[]) => (page > 1 ? [] : rows)

  if (parts[0] === 'projects' && parts.length === 1) {
    return paged(PROJECTS)
  }

  if (parts[0] === 'projects' && parts[4] === 'buckets') {
    return [
      { id: TODO, title: 'To-Do' },
      { id: DOING, title: 'Doing' },
      { id: BLOCKED, title: 'Blocked' },
      { id: 4, title: 'Done' },
    ]
  }

  if (parts[0] === 'labels' && method === 'GET') {
    return paged(labels)
  }

  if (parts[0] === 'labels' && method === 'PUT') {
    const label = { id: 900 + labels.length, title: String((body as Raw).title) }
    labels = [...labels, label]

    return label
  }

  if (parts[0] === 'tasks' && parts.length === 1) {
    const filter = decodeURIComponent(/filter=([^&]*)/.exec(query)?.[1] ?? '')
    const lanes = (/bucket_id in ([\d, ]+)/.exec(filter)?.[1] ?? '').split(',').map(Number)

    const number = /index = (\d+)/.exec(filter)

    if (number !== null) {
      return paged(ROWS.filter(row => row[2] === Number(number[1])).map(row => toRaw(row, now)))
    }

    return paged(ROWS.filter(row => lanes.includes(row[3])).map(row => toRaw(row, now)))
  }

  const id = Number(parts[1])
  const row = ROWS.find(r => r[0] === id)

  if (parts[0] !== 'tasks' || row === undefined) {
    return null
  }

  if (parts[2] === 'comments') {
    return (COMMENTS[id] ?? []).map(([username, days, comment]) => ({
      author: { username },
      created: iso(now + days * DAY),
      comment,
    }))
  }

  if (parts[2] === 'labels' && method === 'PUT') {
    onTask[id] = [...new Set([...(onTask[id] ?? []), Number((body as Raw).label_id)])]

    return null
  }

  if (parts[2] === 'labels' && method === 'DELETE') {
    onTask[id] = (onTask[id] ?? []).filter(label => label !== Number(parts[3]))

    return null
  }

  return toRaw(row, now)
}
