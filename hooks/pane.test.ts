import { expect, mock, test } from 'claude-code/testing'

const TASK = {
  id: 501,
  identifier: '#42',
  title: 'Write the release notes',
  priority: 4,
  done: false,
  project_id: 3,
  assignees: [{ username: 'claude' }],
  description: '<p>Hello <strong>there</strong></p><ul><li>one</li></ul>',
  created: '2026-10-01T10:00:00+10:00',
  updated: '2026-10-03T14:02:00+10:00',
  labels: [] as { id: number; title: string }[],
  due_date: '0001-01-01T00:00:00Z',
}

// A Vikunja small enough to answer every path the mod reads.
const answer = (url: string): unknown => {
  const path = url.split('/api/v1')[1] ?? ''

  if (path.startsWith('/labels')) {
    return []
  }

  if (path.startsWith('/projects?')) {
    return [
      { id: 3, title: 'Atlas', parent_project_id: 0, views: [{ id: 30, view_kind: 'kanban' }] },
      { id: 8, title: 'Household', parent_project_id: 0, views: [] },
      { id: 9, title: 'Garden', parent_project_id: 8, views: [] },
    ]
  }

  if (path.includes('/buckets')) {
    return [
      { id: 61, title: 'Doing' },
      { id: 63, title: 'Blocked' },
      { id: 60, title: 'To-Do' },
    ]
  }

  if (path.startsWith('/tasks?')) {
    if (path.includes('60')) {
      return [
        { ...TASK, id: 901, identifier: '#9', title: 'Not started yet' },
        // the mocked clock reads 1,000,000 ms: one of these is past, one is three days out
        { ...TASK, id: 902, identifier: '#10', title: 'Late', due_date: '1970-01-01T00:00:01Z' },
        { ...TASK, id: 903, identifier: '#12', title: 'Soon', due_date: '1970-01-04T00:00:00Z' },
      ]
    }

    return path.includes('61') ? [TASK, { ...TASK, id: 900, identifier: '#3', project_id: 9 }] : []
  }

  if (path.endsWith('/comments')) {
    return [{ author: { username: 'sam' }, created: TASK.updated, comment: '<p>Looks good</p>' }]
  }

  return TASK
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`demo mode never touches the network, disk or host on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1_000_000_000_000 })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }) as never)
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.focus', () => ({ value: {} }) as never)
    // Every way out of the process is counted. Live mode's first read of the
    // board asks the environment for its settings, so the count is taken once
    // demo mode is on, and must not have moved by the end.
    const outside: string[] = []
    const counted = (name: string, value: unknown) => () => {
      outside.push(name)

      return { value } as never
    }
    on('env.get', counted('env.get', undefined))
    on('http.fetch', counted('http.fetch', { status: 500, ok: false, headers: {}, text: '' }))
    on('fs.list', counted('fs.list', []))
    on('fs.exists', counted('fs.exists', false))
    on('fs.stat', counted('fs.stat', { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
    on('fs.write', counted('fs.write', undefined))
    on('process.run', counted('process.run', { exitCode: 0, stdout: '', stderr: '' }))
    on('tool.call', () => {
      outside.push('tool.call')

      return { result: 'ok' } as never
    })

    await $.session.start({ cwd: '.', surface, isInteractive: true })
    await $.command.run({ command: 'vikunja', args: 'demo' } as never)
    const before = outside.length

    const ui = await $.ui.mount({
      plugin: 'vikunja-tasks',
      surface,
      component: 'Pane',
      requestId: 'vikunja-tasks',
      props: { id: 'vikunja-tasks', title: 'Vikunja', bodyColumns: 60 } as never,
      viewport: { columns: 60, rows: 40 },
    })

    expect(await ui.find({ text: 'demo data' })).toBeDefined()
    expect(await ui.find({ key: 'open-Doing-101' })).toBeDefined()
    expect(await ui.find({ key: 'open-Doing-115' })).toBeUndefined() // under the hidden tree

    // Find looks a task up by the number on its card, not its internal id.
    await ui.input({ key: 'search', text: '#42' })
    expect(await ui.find({ key: 'open-found-101' })).toBeDefined()
    await ui.input({ key: 'search', text: '101' })
    expect(await ui.find({ text: 'No task has that number.' })).toBeDefined()
    await ui.press({ key: 'clear-search' })
    expect(await ui.find({ text: 'FOUND' })).toBeUndefined()

    await ui.press({ key: 'open-Doing-102' })
    await ui.select({ key: 'folder', value: '~/code/infra' })
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'start-session' })
    expect(await ui.find({ text: 'Demo: this would offer a session in ~/code/infra' })).toBeDefined()
    await ui.press({ key: 'open' })

    // A new folder, typed in, is not made on disk either.
    await ui.select({ key: 'folder', value: '(other)' })
    await ui.input({ key: 'folder-path', text: 'brand-new' })

    expect(outside.slice(before)).toEqual([])

    // Back in live mode the pane asks the environment for its settings again.
    await $.command.run({ command: 'vikunja', args: 'live' } as never)
    expect(outside.slice(before)).toContain('env.get')
  })

  const options = { webUrl: 'https://tasks.test', folderRoot: 'D:\\', hiddenProjects: 'household' }

  test(`draws the lanes and a task on ${surface}`, { options }, async ($, on) => {
    mock.env(on, { OS: 'Windows_NT', VIKUNJA_API_TOKEN: 'tk_test', VIKUNJA_URL: 'http://vikunja.test/api/v1' })
    mock.clock(on, { now: 1_000_000 })
    const writes: string[] = []
    const calls: Record<string, unknown>[] = []
    on('http.fetch', (_, e) => {
      const method = e.init?.method ?? 'GET'

      if (method !== 'GET') {
        writes.push(`${method} ${e.url.split('/api/v1')[1]} ${e.init?.body ?? ''}`)
      }

      const body = method === 'PUT' && e.url.endsWith('/labels') && !e.url.includes('/tasks/') ? { id: 9 } : answer(e.url)

      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    })
    on('session.cwd', () => ({ value: 'D:\\here' }) as never)
    const made: string[] = []
    on('fs.list', () => ({
      value: [
        { name: 'here', kind: 'dir', size: 0, mtimeMs: 999, isLink: false },
        // more folders than a Select takes: the picker must still draw
        ...Array.from({ length: 90 }, (_, n) => ({ name: `dir-${n}`, kind: 'dir', size: 0, mtimeMs: n, isLink: false })),
        { name: '$RECYCLE.BIN', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      ],
    }) as never)
    const ran: (readonly string[])[] = []
    on('process.run', (_, e) => {
      ran.push((e as { argv: readonly string[] }).argv)

      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    on('fs.exists', (_, e) => ({ value: (e as { path: string }).path.endsWith('linked') }) as never)
    on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true } }) as never)
    on('fs.write', (_, e) => {
      made.push((e as { path: string }).path)

      return { value: undefined } as never
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', (_, e) => {
      calls.push(e as never)

      return { result: 'ok' } as never
    })
    on('command.register', () => ({ value: undefined }) as never)
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.focus', () => ({ value: {} }) as never)

    await $.session.start({ cwd: '.', surface, isInteractive: true })

    const ui = await $.ui.mount({
      plugin: 'vikunja-tasks',
      surface,
      component: 'Pane',
      requestId: 'vikunja-tasks',
      props: { id: 'vikunja-tasks', title: 'Vikunja', bodyColumns: 60 } as never,
      viewport: { columns: 60, rows: 40 },
    })

    expect(await ui.find({ text: 'DOING' })).toBeDefined()
    expect(await ui.find({ key: 'open-Doing-501' })).toBeDefined()
    expect(await ui.find({ key: 'open-To-Do-901' })).toBeDefined()

    // The due buttons: overdue, due in the next seven days, and all.
    const shown = async () =>
      (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => String(k).startsWith('open-To-Do')).sort()
    expect(await shown()).toEqual(['open-To-Do-901', 'open-To-Do-902', 'open-To-Do-903'])
    await ui.press({ key: 'due-overdue' })
    expect(await shown()).toEqual(['open-To-Do-902'])
    await ui.press({ key: 'due-week' })
    expect(await shown()).toEqual(['open-To-Do-903'])
    await ui.press({ key: 'due-all' })
    expect(await shown()).toEqual(['open-To-Do-901', 'open-To-Do-902', 'open-To-Do-903'])

    // Blocked can be hidden and shown again.
    expect(await ui.find({ text: 'BLOCKED' })).toBeDefined()
    await ui.press({ key: 'blocked-hide' })
    expect(await ui.find({ type: 'Text', text: 'BLOCKED' })).toBeUndefined()
    await ui.press({ key: 'blocked-show' })
    expect(await ui.find({ type: 'Text', text: 'BLOCKED' })).toBeDefined()

    // A task under the hidden tree is left out until asked for.
    expect(await ui.find({ key: 'open-Doing-900' })).toBeUndefined()
    await ui.select({ key: 'filter-project', value: 'everything' })
    expect(await ui.find({ key: 'open-Doing-900' })).toBeDefined()
    await ui.press({ key: 'clear-filters' })
    expect(await ui.find({ key: 'open-Doing-900' })).toBeUndefined()

    await ui.press({ key: 'open-Doing-501' })
    await ui.drawn()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'Looks good' })).toBeDefined()

    // Open is a Button that hands the task's page to the system browser.
    await ui.press({ key: 'open' })
    expect(ran).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'https://tasks.test/tasks/501']])

    // Picking a folder labels the task; Start session offers one in it.
    expect(await ui.find({ type: 'Select', key: 'folder', text: '$RECYCLE' })).toBeUndefined()
    await ui.select({ key: 'folder', value: 'D:\\here' })
    expect(writes).toEqual([
      'PUT /labels {"title":"folder: D:\\\\here","hex_color":"6b8afd"}',
      'PUT /tasks/501/labels {"label_id":9}',
    ])

    // A new folder is made under D: and given to the task.
    await ui.select({ key: 'folder', value: '(other)' })
    await ui.input({ key: 'folder-path', text: 'bad/name' })
    expect(made).toEqual([])
    // A link under the root is refused: it could lead a session anywhere.
    await ui.input({ key: 'folder-path', text: 'linked' })
    expect(made).toEqual([])
    expect(writes).toHaveLength(2)
    await ui.select({ key: 'folder', value: '(other)' })
    await ui.input({ key: 'folder-path', text: 'fresh' })
    expect(made).toEqual(['D:\\fresh\\.gitkeep'])
    expect(writes.at(-1)).toBe('PUT /tasks/501/labels {"label_id":9}')

    // Changing folder puts the new label on before taking the old one off.
    TASK.labels = [{ id: 7, title: 'folder: D:\\elsewhere' }]
    await ui.press({ key: 'reload' })
    await ui.select({ key: 'folder', value: 'D:\\here' })
    expect(writes.slice(-2)).toEqual(['PUT /tasks/501/labels {"label_id":9}', 'DELETE /tasks/501/labels/7 '])
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'start-session' })
    expect(calls.at(-1)).toMatchObject({ tool: 'mcp__ccd_session__spawn_task', cwd: 'D:\\elsewhere' })
    TASK.labels = []

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()

    // A filter nothing matches empties the lane, and Clear brings it back.
    await ui.select({ key: 'filter-assignee', value: 'nobody' })
    expect(await ui.find({ key: 'open-Doing-501' })).toBeUndefined()
    await ui.press({ key: 'clear-filters' })
    expect(await ui.find({ key: 'open-Doing-501' })).toBeDefined()

    // A vikunja MCP call naming a task opens it without a press.
    await $.tool.call({ tool: 'mcp__vikunja__vikunja_tasks', subcommand: 'get', id: 501 } as never)
    await ui.drawn()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ text: 'THIS SESSION' })).toBeUndefined()
  })
}
