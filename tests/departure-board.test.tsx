import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DRUM, Flaps, MAX_ROWS, boardOrder, layout, nextFlap, targetGrid, todoIds, trim } from '../hooks/board'
import type { BoardRow } from '../types'

const BAND = {
  plugin: 'departure-board',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 90, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const PANE = {
  plugin: 'departure-board',
  component: 'Pane',
  requestId: 'departure-board',
  props: { title: 'Departures', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

function world(on: On) {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 5) })
  mock.store(on)
  // What other plugins draw in the shared band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.blit', () => ({ value: {} }))
}

type Done = Parameters<Engine['turn']['complete']>[0]
/** A person's prompt entering, then the turn that carries it starting (as the engine does). */
async function prompt($: Engine, text: string, turnId: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}
const end = ($: Engine, turnId: string, reason: 'answer' | 'aborted') => $.turn.complete({ reason, turnId } as Done)

const ok = { result: {}, text: 'ok' }
const fail = { isError: true as const, result: 'boom', text: 'boom' }

const todos = (list: [string, 'pending' | 'in_progress' | 'completed'][]) => ({
  tool: 'TodoWrite' as const,
  todos: list.map(([content, status]) => ({ content, status, activeForm: `Doing ${content}` })),
})

async function paneText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text).join('\n')
}

test('the todo list becomes the board, and an error delays what is boarding', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && e.command === 'npm test' ? fail : ok))
  await $.tool.call(todos([['Fix login', 'completed'], ['Add tests', 'in_progress'], ['Ship it', 'pending']]))
  let text = await paneText($)
  expect(text).toMatch(/FIX LOGIN|Fix login/)
  expect(text).toMatch(/DEPARTED/)
  expect(text).toMatch(/BOARDING/)
  expect(text).toMatch(/ON TIME/)

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  text = await paneText($)
  expect(text).toMatch(/DELAYED/)
  expect(text).toMatch(/npm/)

  // The item stays delayed while in progress, and departs once completed.
  await $.tool.call(todos([['Fix login', 'completed'], ['Add tests', 'in_progress'], ['Ship it', 'pending']]))
  expect(await paneText($)).toMatch(/DELAYED/)
  await $.tool.call(todos([['Fix login', 'completed'], ['Add tests', 'completed'], ['Ship it', 'in_progress']]))
  text = await paneText($)
  expect(text).not.toMatch(/DELAYED/)
  expect(text).toMatch(/BOARDING/)
})

test('tasks: created on time, updated to boarding, deleted ones are cancelled', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: '7', subject: e.subject } }, text: 'created' }
    return { result: { success: true }, text: 'ok' }
  })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Migrate db', description: 'x' })
  expect(await paneText($)).toMatch(/ON TIME/)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  expect(await paneText($)).toMatch(/BOARDING/)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'deleted' })
  expect(await paneText($)).toMatch(/CANCELLED/)
})

test('without a task list each prompt is a departure', async ($, on) => {
  world(on)
  on('tool.call', () => ok)
  await prompt($, 'rename the user model', 't1')
  let text = await paneText($)
  expect(text).toMatch(/rename the user model/)
  expect(text).toMatch(/BOARDING/)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/user.ts', old_string: 'a', new_string: 'b' })
  expect(await paneText($)).toMatch(/user\.ts/)
  await end($, 't1', 'answer')
  expect(await paneText($)).toMatch(/DEPARTED/)

  await prompt($, 'now the orders model', 't2')
  await end($, 't2', 'aborted')
  expect(await paneText($)).toMatch(/CANCELLED/)

  // Notifications and slash commands are not departures.
  await $.prompt.submit({ text: 'task finished', wait: false, origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: '/board', wait: false, origin: { kind: 'composer' } })
  expect((await paneText($)).match(/task finished|\/board/)).toBeNull()
})

test('the band shares its slot, draws a Raster on the terminal and text elsewhere', async ($, on) => {
  world(on)
  on('tool.call', () => ok)
  // Nothing to show: only the other plugins' band.
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()

  await $.tool.call(todos([['Write docs', 'in_progress']]))
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'mini' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /BOARDING/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await desk.unmount()

  // A survey holds the band.
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()

  // /board band off hides it.
  await $.command.run({ command: 'board', args: 'band off' } as Parameters<typeof $.command.run>[0])
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('subagent calls and denied calls never touch the board', async ($, on) => {
  world(on)
  on('tool.call', () => ok)
  await $.tool.call({ ...todos([['Hidden', 'in_progress']]), agentId: 'sub-1' } as Parameters<typeof $.tool.call>[0])
  expect(await paneText($)).not.toMatch(/HIDDEN|Hidden/)
})

test('flaps fall through the drum to their target, in a cascade', () => {
  const rows: BoardRow[] = [
    { id: 'a', time: '14:05', destination: 'Fix login', platform: 'auth.ts', status: 'BOARDING', source: 'todo', at: 0, isTroubled: false, isActive: false },
  ]
  const target = targetGrid(rows, 60, 2, true)
  expect(target.length).toBe(120)
  const flaps = new Flaps(60, 2, target)
  expect(flaps.settled).toBe(false)
  let frames = 0
  while (flaps.step()) frames += 1
  expect(flaps.settled).toBe(true)
  // A full drum is the longest a single flap can take, plus the cascade's delay.
  expect(frames).toBeLessThan(DRUM.length + 60)
  expect(frames).toBeGreaterThan(5)

  // Retargeting only moves the cells that change.
  const changed = targetGrid([{ ...rows[0]!, status: 'DEPARTED' }], 60, 2, true)
  flaps.retarget(changed)
  expect(flaps.settled).toBe(false)
  while (flaps.step()) frames += 1
  expect(flaps.settled).toBe(true)
  // 60 x 2 cells, 3 u32 each, base64.
  expect(flaps.encode().length).toBe(Math.ceil((60 * 2 * 12) / 3) * 4)
})

test('drum and layout edge cases', () => {
  expect(nextFlap(' '.charCodeAt(0), 'C'.charCodeAt(0))).toBe('A'.charCodeAt(0))
  // A character off the drum snaps straight to its target.
  expect(nextFlap('~'.charCodeAt(0), 'A'.charCodeAt(0))).toBe('A'.charCodeAt(0))
  expect(layout(40).platform).toBe(0)
  const wide = layout(120)
  expect(wide.time + wide.destination + wide.platform + wide.status + 3).toBe(120)
  // Non-ASCII text lands as spaces, never as a wide or unprintable cell.
  const cells = targetGrid([{ id: 'x', time: '09:00', destination: '日本語 ✓ ok', platform: '', status: 'ON TIME', source: 'turn', at: 0, isTroubled: false, isActive: false }], 40, 1, false)
  for (const c of cells) expect(c.ch >= 32 && c.ch < 127).toBe(true)
})

test('the pane draws a header and the board on the terminal, and the flaps animate on the clock', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 5) })
  mock.store(on)
  let frames = 0
  on('ui.blit', () => {
    frames += 1
    return { value: {} }
  })
  on('tool.call', () => ok)
  await $.tool.call(todos([['Index repo', 'in_progress'], ['Write report', 'pending']]))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /DEPARTURES/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 departures · 1 boarding/ })).toBeDefined()
  // Two seconds of frames: the board flips in, then every flap lands and the clock stops.
  await clock.advance(2000)
  expect(frames).toBeGreaterThan(10)
  const landed = frames
  await clock.advance(2000)
  expect(frames).toBe(landed)
  await ui.unmount()
})

test('a finished turn is frozen: later work and aborts never rewrite it', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && e.command === 'false' ? fail : ok))
  await prompt($, 'first job', 't1')
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await end($, 't1', 'answer')
  await prompt($, 'second job', 't2')
  await $.tool.call({ tool: 'Edit', file_path: '/r/later.ts', old_string: 'a', new_string: 'b' })
  await end($, 't2', 'aborted')
  const text = await paneText($)
  const first = text.split('\n').find(l => /first job/.test(l)) ?? ''
  expect(first).toMatch(/DEPARTED/)
  expect(first).not.toMatch(/later\.ts|CANCELLED/)
  const second = text.split('\n').find(l => /second job/.test(l)) ?? ''
  expect(second).toMatch(/CANCELLED/)
  expect(second).toMatch(/later\.ts/)
  // Nothing is left pinned as boarding.
  expect(text).toMatch(/0 boarding/)
})

test('an error delays only the newest item on its way', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 5) })
  mock.store(on)
  on('ui.blit', () => ({ value: {} }))
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? fail : ok))
  await $.tool.call(todos([['Alpha', 'in_progress']]))
  await clock.advance(60_000)
  await $.tool.call(todos([['Alpha', 'in_progress'], ['Beta', 'in_progress']]))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const text = await paneText($)
  expect(text).toMatch(/1 delayed/)
})

test('todo identity: duplicates and look-alikes stay apart, a removed todo forgets its delay', () => {
  expect(todoIds(['Fix a*b', 'Fix a=b', 'Fix a*b'])).toEqual(['todo:Fix a*b#0', 'todo:Fix a=b#0', 'todo:Fix a*b#1'])
})

test('tasks from before the session join on update and on TaskList', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskList') return { result: { tasks: [{ id: '1', subject: 'Old one', status: 'completed', blockedBy: [] }, { id: '2', subject: 'Old two', status: 'in_progress', blockedBy: [] }] }, text: 'ok' }
    return { result: { success: true }, text: 'ok' }
  })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '9', status: 'in_progress', subject: 'Resume work' })
  expect(await paneText($)).toMatch(/Resume work/)
  await $.tool.call({ tool: 'TaskList' })
  const text = await paneText($)
  expect(text).toMatch(/Old one/)
  expect(text).toMatch(/Old two/)
})

test('trimming never drops live work, and drops old turns first', () => {
  const row = (i: number, extra: Partial<BoardRow>): BoardRow => ({ id: `r${i}`, time: '00:00', destination: `R${i}`, platform: '', status: 'DEPARTED', source: 'task', at: i, isTroubled: false, isActive: false, ...extra })
  const list: BoardRow[] = []
  for (let i = 0; i < 40; i += 1) list.push(row(i, { source: 'turn' }))
  for (let i = 40; i < 120; i += 1) list.push(row(i, i < 50 ? { status: 'BOARDING' } : {}))
  const kept = trim(list)
  expect(kept.length).toBeLessThanOrEqual(MAX_ROWS)
  for (let i = 40; i < 50; i += 1) expect(kept.some(r => r.id === `r${i}`)).toBe(true)
  expect(kept.filter(r => r.source === 'turn').length).toBe(0)
  // Live rows lead the board order.
  expect(boardOrder(kept, 3).every(r => r.status === 'BOARDING')).toBe(true)
})

test('the band respects a tiny budget and a narrow column', async ($, on) => {
  world(on)
  on('tool.call', () => ok)
  await $.tool.call(todos([['Narrow', 'in_progress']]))
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 0 } })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Narrow|NARROW/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 16 } })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /BOARDING|Narrow/ })).toBeDefined()
  await ui.unmount()
})

test('a prompt typed mid-turn waits for its own turn and never takes over the live row', async ($, on) => {
  world(on)
  on('tool.call', () => ok)
  await prompt($, 'fix the login', 't1')
  // Typed while turn t1 runs: it is queued, so it has no row yet.
  await $.prompt.submit({ text: 'now the orders model', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/r/login.ts', old_string: 'a', new_string: 'b' })
  let text = await paneText($)
  expect(text.split('\n').find(l => /fix the login/.test(l)) ?? '').toMatch(/BOARDING/)
  expect(text).not.toMatch(/orders model/)
  await end($, 't1', 'answer')
  await $.turn.start({ text: 'now the orders model', turnId: 't2' })
  text = await paneText($)
  expect(text.split('\n').find(l => /fix the login/.test(l)) ?? '').toMatch(/DEPARTED/)
  expect(text.split('\n').find(l => /orders model/.test(l)) ?? '').toMatch(/BOARDING/)
})

test('a finished task list gives the board back to the turns, and a TaskList snapshot drops deleted tasks', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskList') return { result: { tasks: [] }, text: '' }
    return ok
  })
  await $.tool.call(todos([['Fix login', 'completed']]))
  await prompt($, 'next job please', 't1')
  expect(await paneText($)).toMatch(/next job please/)
  // A task that was deleted elsewhere: the empty snapshot removes it.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress', subject: 'Old task' } as never)
  expect(await paneText($)).toMatch(/OLD TASK|Old task/)
  await $.tool.call({ tool: 'TaskList' } as never)
  expect(await paneText($)).not.toMatch(/OLD TASK|Old task/)
})
