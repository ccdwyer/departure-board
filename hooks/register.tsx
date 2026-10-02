import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardRow, BoardStatus } from '../types'
import { Flaps, boardOrder, clockTime, isLive, layout, platformOf, statusOf, targetGrid, todoIds, trim } from './board'

const rows = atom({ plugin: 'departure-board', key: 'rows' } as const, [])
const isBandHidden = atom({ plugin: 'departure-board', key: 'isBandHidden' } as const, false)

const PANE = 'departure-board'
const FRAME_MS = 33
const CLACK = 'assets/clack.wav'
// The narrowest board the layout fits (time, destination, status and their gaps).
const MIN_COLUMNS = 21
// Prompts that are a person's own words: each one is a new departure when no task list exists.
const PERSON = ['composer', 'bridge', 'sdk', 'channel', 'slack-ping']
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])
// The pane opens this tall inline: a header, a handful of departures and the footer.
const PANE_ROWS = 14

type Site = { requestId: string; key: string; flaps: Flaps }
type Call = { tool: string; [k: string]: unknown }
type TaskRow = { id?: string; subject?: string; status?: string }

// What is on screen, per drawing site. Rebuilt after a reload by the next draw.
const sites = new Map<string, Site>()
// The next frame, when one is due: frames are chained, so a slow blit drops a frame instead of stacking steps.
let pending: { cancel: () => void } | null = null
let isFraming = false
let lastClack = 0
let isClackOn = false
// A person's prompts that have entered, waiting for the turn that carries them to start.
const waitingPrompts: string[] = []
// The main loop's running turn, so a plain tool call belongs to its row.
let runningTurn: string | null = null

/** A task list is "on" while some todo or task is still to go; a finished list gives the board back to the turns. */
function hasLiveTaskList(all: BoardRow[]): boolean {
  return all.some(r => r.source !== 'turn' && (r.status === 'ON TIME' || r.status === 'BOARDING' || r.status === 'DELAYED'))
}

/** The rows a board shows: the live task list when there is one, else everything (turns and finished items). */
function shownRows(all: BoardRow[]): BoardRow[] {
  return hasLiveTaskList(all) ? all.filter(r => r.source !== 'turn') : all
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One frame: step every board, then paint them; chain the next frame only while flaps are falling. */
async function frame($: EngineInterface): Promise<void> {
  pending = null
  if (isFraming) return
  isFraming = true
  try {
    const painted: { id: string; site: Site; cells: string }[] = []
    for (const [id, site] of sites) {
      if (site.flaps.step()) painted.push({ id, site, cells: site.flaps.encode() })
    }
    for (const p of painted) {
      try {
        const done = await $.ui.blit({ requestId: p.site.requestId, key: p.site.key, cells: p.cells })
        // Only forget the site this frame painted: a render may have replaced it while the blit was in flight.
        if (done.deny !== undefined && sites.get(p.id) === p.site) sites.delete(p.id)
      } catch {
        // Nothing mounted there any more (or no surface at all): forget the site, if it is still this one.
        if (sites.get(p.id) === p.site) sites.delete(p.id)
      }
    }
    if (painted.length > 0) schedule($)
  } finally {
    isFraming = false
  }
}

/** Ask for the next frame if a board has flaps still falling, with one clack per burst. */
function schedule($: EngineInterface): void {
  if (pending !== null) return
  let busy = false
  for (const site of sites.values()) if (!site.flaps.settled) busy = true
  if (!busy) return
  pending = $.clock.after(FRAME_MS, () => void frame($))
  const now = Date.now()
  if (isClackOn && now - lastClack > 800) {
    lastClack = now
    void clack($)
  }
}

/** One mechanical clack; a terminal with no player plays nothing. */
async function clack($: EngineInterface): Promise<void> {
  try {
    await $.audio.play({ asset: CLACK })
  } catch {
    // No sound is fine.
  }
}

/** Keep the site's flaps, falling towards a new target; a resized site starts over. */
function place(id: string, requestId: string, key: string, columns: number, height: number, list: BoardRow[], header: boolean): Site {
  const target = targetGrid(list, columns, height, header)
  const was = sites.get(id)
  if (was !== undefined && was.flaps.columns === columns && was.flaps.rows === height && was.requestId === requestId) {
    was.flaps.retarget(target)
    return was
  }
  const site = { requestId, key, flaps: new Flaps(columns, height, target) }
  sites.set(id, site)
  return site
}

async function openBoard($: EngineInterface): Promise<boolean> {
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Departures', rows: PANE_ROWS })
    return opened.isPlaced
  } catch {
    return false
  }
}

/** The row a plain tool call belongs to: the newest work item on its way, else the running turn. */
function currentWork(list: BoardRow[]): string | null {
  let best: BoardRow | null = null
  for (const r of list) {
    if (r.source === 'turn' || !isLive(r)) continue
    if (best === null || r.at > best.at) best = r
  }
  if (best !== null) return best.id
  const turn = runningTurn === null ? undefined : list.find(r => r.id === `turn:${runningTurn}` && r.isActive)
  return turn?.id ?? null
}

type Next = (e: never) => Promise<{ deny?: string; isError?: true }>

/**
 * A plain tool call: it becomes the platform of the row on its way as it starts, and an error
 * delays that same row, even if another item started meanwhile.
 */
async function plainCall($: EngineInterface, e: Call, next: Next): Promise<never> {
  let owner: string | null = null
  try {
    const platform = platformOf(e)
    const now = await $.clock.now()
    await update($, rows, list => {
      owner = currentWork(list)
      if (owner === null) return list
      return list.map(r => (r.id === owner ? { ...r, platform, at: now } : r))
    })
  } catch {
    owner = null
  }
  const ran = await next(e as never)
  if (owner !== null && ran.deny === undefined && ran.isError === true) {
    try {
      const id = owner
      await update($, rows, list =>
        list.some(r => r.id === id && isLive(r)) ? list.map(r => (r.id === id ? { ...r, isTroubled: true, status: 'DELAYED' as const } : r)) : list,
      )
    } catch {
      // Ignore.
    }
  }
  return ran as never
}

const clip = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text)

export const register: Register = (on, options) => {
  isClackOn = options.clack === true

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'board',
        description: 'Departure Board: open the split-flap board (`/board band off` hides the mini board)',
        argumentHint: '[band on|off]',
        immediate: true,
      })
    } catch {
      // The board is optional; the session is not.
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'band off' || arg === 'band on') {
      await update($, isBandHidden, () => arg === 'band off')
      return { text: `Departure Board: mini board ${arg === 'band off' ? 'hidden' : 'shown'}.` }
    }
    const placed = await openBoard($)
    return { text: placed ? 'Departure Board: now boarding.' : 'Departure Board: widen the terminal to open the board.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    sites.delete(PANE)
    return next(e)
  })

  // A person's prompt that entered (now, or queued behind the running turn) is remembered;
  // its row opens when the turn that carries it starts, so a prompt typed mid-turn never takes over the live row.
  on('prompt.submit', async ($, e, next) => {
    const res = await next(e)
    if (res.drop !== undefined || !PERSON.includes(e.origin.kind)) return res
    const words = normalize(e.text)
    if (words.length > 0 && !words.startsWith('/')) {
      waitingPrompts.push(words)
      if (waitingPrompts.length > 20) waitingPrompts.shift()
    }
    return res
  })

  on('turn.start', async ($, e, next) => {
    const res = await next(e)
    try {
      const words = normalize(e.text)
      const at = waitingPrompts.indexOf(words)
      // Only a turn carrying a person's prompt departs; continuations and notifications do not.
      if (words.length === 0 || at < 0) return res
      waitingPrompts.splice(at, 1)
      runningTurn = e.turnId
      const now = await $.clock.now()
      const row: BoardRow = { id: `turn:${e.turnId}`, time: clockTime(now), destination: words, platform: '', status: 'BOARDING', source: 'turn', at: now, isTroubled: false, isActive: true }
      await update($, rows, list => trim([...list.filter(r => r.id !== row.id), row]))
    } catch {
      // Ignore.
    }
    return res
  })

  on('tool.call', async ($, e, next) => {
    // A plain call (any agent's) belongs to the row on its way when it starts, not when it ends.
    if (!TASK_TOOLS.has(e.tool)) return plainCall($, e as Call, next)
    const ran = await next(e)
    // A subagent's own task list is not the session's board.
    if (ran.deny !== undefined || e.agentId !== undefined) return ran
    try {
      const now = await $.clock.now()
      const failed = ran.isError === true

      if (e.tool === 'TodoWrite') {
        if (failed) return ran
        const todos = Array.isArray(e.todos) ? e.todos : []
        const ids = todoIds(todos.map(t => t.content))
        await update($, rows, list => {
          const keep = list.filter(r => r.source !== 'todo')
          const before = new Map(list.filter(r => r.source === 'todo').map(r => [r.id, r]))
          const fresh = todos.map((t, i): BoardRow => {
            const id = ids[i] as string
            const was = before.get(id)
            // The red mark lasts while the item stays in progress.
            const isTroubled = t.status === 'in_progress' && was?.isTroubled === true
            const status = statusOf(t.status, isTroubled)
            return {
              id,
              time: was?.time ?? clockTime(now),
              destination: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
              platform: was?.platform ?? '',
              status,
              source: 'todo',
              at: was !== undefined && was.status === status ? was.at : now,
              isTroubled,
              isActive: false,
            }
          })
          return trim([...keep, ...fresh])
        })
        return ran
      }

      if (e.tool === 'TaskCreate') {
        const task = failed ? undefined : (ran.result as { task?: TaskRow } | undefined)?.task
        if (task?.id !== undefined) {
          const row: BoardRow = { id: `task:${task.id}`, time: clockTime(now), destination: task.subject ?? e.subject, platform: '', status: 'ON TIME', source: 'task', at: now, isTroubled: false, isActive: false }
          await update($, rows, list => trim([...list.filter(r => r.id !== row.id), row]))
        }
        return ran
      }

      if (e.tool === 'TaskUpdate') {
        if (failed) return ran
        const id = `task:${e.taskId}`
        await update($, rows, list => {
          const was = list.find(r => r.id === id)
          // A task from before this session: it joins the board on its first update.
          const base: BoardRow = was ?? { id, time: clockTime(now), destination: e.subject ?? `TASK ${e.taskId}`, platform: '', status: 'ON TIME', source: 'task', at: now, isTroubled: false, isActive: false }
          const isTroubled = e.status === undefined ? base.isTroubled : e.status === 'in_progress' && base.isTroubled
          const status: BoardStatus = e.status === undefined ? base.status : statusOf(e.status, isTroubled)
          const row = { ...base, destination: e.subject ?? base.destination, status, isTroubled, at: now }
          return trim([...list.filter(r => r.id !== id), row])
        })
        return ran
      }

      if (e.tool === 'TaskList') {
        const snapshot = failed ? undefined : (ran.result as { tasks?: TaskRow[] } | undefined)?.tasks
        if (Array.isArray(snapshot)) {
          const tasks = snapshot
          await update($, rows, list => {
            const byId = new Map(list.map(r => [r.id, r]))
            const listed = tasks.flatMap((t): BoardRow[] => {
              if (t.id === undefined) return []
              const id = `task:${t.id}`
              const was = byId.get(id)
              const isTroubled = t.status === 'in_progress' && was?.isTroubled === true
              const status = statusOf(t.status ?? 'pending', isTroubled)
              return [{ id, time: was?.time ?? clockTime(now), destination: t.subject ?? was?.destination ?? `TASK ${t.id}`, platform: was?.platform ?? '', status, source: 'task', at: was !== undefined && was.status === status ? was.at : now, isTroubled, isActive: false }]
            })
            const ids = new Set(listed.map(r => r.id))
            // A full, successful snapshot: tasks it no longer lists were deleted, so they leave the board.
            return trim([...list.filter(r => !ids.has(r.id) && r.source !== 'task'), ...listed])
          })
        }
        return ran
      }
    } catch {
      // The board only watches; the call's result stands.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const now = await $.clock.now()
        const end: BoardStatus = e.reason === 'answer' ? 'DEPARTED' : 'CANCELLED'
        const id = `turn:${e.turnId}`
        if (runningTurn === e.turnId) runningTurn = null
        // Only this turn's own row ends: a DELAYED turn that ends still departs (or is cancelled).
        await update($, rows, list => (list.some(r => r.id === id) ? list.map(r => (r.id === id ? { ...r, status: end, isActive: false, at: now } : r)) : list))
      } catch {
        // Ignore.
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, rows)
    const room = Math.min(3, e.props.maxRows)
    if (e.props.hasSurvey || all.length === 0 || room < 1 || (await read($, isBandHidden))) return next(e)
    const list = shownRows(all)
    const picked = boardOrder(list, Math.min(room, list.length))
    // Reserve the board's rows: the mods beneath get what is left of the band.
    const below = await next({ ...e, props: { ...e.props, maxRows: e.props.maxRows - picked.length } })
    const columns = Math.min(512, e.props.bodyColumns)

    if (e.surface !== 'terminal' || columns < MIN_COLUMNS) {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {picked.map(r => (
            <Text>{clip(`${r.status} ${r.time} ${r.destination}`, Math.max(10, columns))}</Text>
          ))}
          {below}
        </Box>
      )
    }

    const { Box, Raster } = $.ui.resolve(e)
    const site = place('band', e.requestId, 'mini', columns, picked.length, picked, false)
    schedule($)
    return (
      <Box flexDirection="column">
        <Raster key="mini" columns={columns} rows={picked.length} cells={site.flaps.encode()} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = shownRows(await read($, rows))
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.min(512, e.props.bodyColumns)
    // The pane's own body, less the title and the footer: never the whole terminal.
    const body = e.props.scroll?.bodyRows ?? Math.max(6, Math.floor((e.viewport?.rows ?? 24) / 3))
    const room = Math.max(3, Math.min(256, body - 2))
    const list = boardOrder(all, room - 1)
    const boarding = all.filter(r => r.status === 'BOARDING').length
    const departed = all.filter(r => r.status === 'DEPARTED').length
    const delayed = all.filter(r => r.status === 'DELAYED').length
    const more = all.length - list.length
    const footer = `${all.length} departures · ${boarding} boarding · ${departed} departed · ${delayed} delayed${more > 0 ? ` · ${more} not shown` : ''}`

    if (e.surface !== 'terminal' || columns < MIN_COLUMNS) {
      const l = layout(Math.max(MIN_COLUMNS, columns))
      return (
        <Box flexDirection="column">
          <Text bold>DEPARTURES</Text>
          {list.length === 0 && <Text dimColor>No departures yet. Give Claude a task.</Text>}
          {list.map(r => (
            <Text>
              {r.time} {clip(r.destination, Math.max(20, l.destination))} · {clip(r.platform, 24)} · {r.status}
            </Text>
          ))}
          <Text dimColor>{footer}</Text>
        </Box>
      )
    }

    const { Raster } = $.ui.resolve(e)
    const height = Math.max(2, Math.min(room, list.length + 1))
    const site = place(PANE, e.requestId, 'board', columns, height, list, true)
    schedule($)
    return (
      <Box flexDirection="column">
        <Text bold color="#ffb000">
          ✈ DEPARTURES
        </Text>
        <Raster key="board" columns={columns} rows={height} cells={site.flaps.encode()} />
        <Text dimColor>{list.length === 0 ? 'No departures yet. Give Claude a task.' : footer}</Text>
      </Box>
    )
  })
}
