// Pure board logic: rows to a character grid, and the split-flap animator.
import type { BoardRow, BoardStatus } from '../types'

// The characters on a flap drum, in the order the flaps fall.
export const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-/'&()!?#+@_"
const DRUM_INDEX = new Map<number, number>()
for (let i = 0; i < DRUM.length; i += 1) DRUM_INDEX.set(DRUM.charCodeAt(i), i)

export const AMBER = 0xffb000
export const FLAP_BG = 0x161616
export const GAP_BG = 0x050505
const FLIPPING = 0xffe0a0
const DEFAULT = 0x01000000

export const STATUS_COLOR: Record<BoardStatus, number> = {
  'ON TIME': 0xd8d8d8,
  BOARDING: 0xffd000,
  DEPARTED: 0x6be675,
  DELAYED: 0xff5a4f,
  CANCELLED: 0x8a8a8a,
}

/** One printable drum character: upper case, anything off the drum becomes a space. */
export function drumText(text: string): string {
  let out = ''
  for (const ch of text.toUpperCase()) {
    out += DRUM_INDEX.has(ch.charCodeAt(0)) && ch.length === 1 ? ch : ' '
  }
  return out
}

const pad = (text: string, width: number) => {
  const t = drumText(text)
  return t.length >= width ? t.slice(0, width) : t + ' '.repeat(width - t.length)
}

export type Layout = { time: number; destination: number; platform: number; status: number }

/** Column widths for a board this many cells wide; the platform column goes first on narrow boards. */
export function layout(columns: number): Layout {
  const time = 5
  const status = 9
  const platform = columns >= 48 ? Math.min(16, Math.max(8, Math.floor(columns * 0.2))) : 0
  const gaps = platform > 0 ? 3 : 2
  const destination = Math.max(4, columns - time - status - platform - gaps)
  return { time, destination, platform, status }
}

/** A target cell: its character and the colour it settles in. */
export type Cell = { ch: number; fg: number; bg: number }

/** The board as rows of cells: an optional header, then one line per departure. */
export function targetGrid(rows: BoardRow[], columns: number, height: number, header: boolean): Cell[] {
  const l = layout(columns)
  const cells: Cell[] = []
  const line = (parts: { text: string; width: number; fg: number }[], isHeader: boolean) => {
    let used = 0
    parts.forEach((p, i) => {
      if (p.width <= 0) return
      if (i > 0 && used < columns) {
        cells.push({ ch: 32, fg: DEFAULT, bg: GAP_BG })
        used += 1
      }
      const text = pad(p.text, p.width)
      for (let k = 0; k < text.length && used < columns; k += 1) {
        cells.push({ ch: text.charCodeAt(k), fg: p.fg, bg: isHeader ? GAP_BG : FLAP_BG })
        used += 1
      }
    })
    while (used < columns) {
      cells.push({ ch: 32, fg: DEFAULT, bg: GAP_BG })
      used += 1
    }
  }
  let drawn = 0
  if (header && height > 0) {
    line(
      [
        { text: 'TIME', width: l.time, fg: 0x8a6a20 },
        { text: 'DESTINATION', width: l.destination, fg: 0x8a6a20 },
        { text: 'PLATFORM', width: l.platform, fg: 0x8a6a20 },
        { text: 'STATUS', width: l.status, fg: 0x8a6a20 },
      ],
      true,
    )
    drawn += 1
  }
  for (const r of rows) {
    if (drawn >= height) break
    line(
      [
        { text: r.time, width: l.time, fg: AMBER },
        { text: r.destination, width: l.destination, fg: AMBER },
        { text: r.platform, width: l.platform, fg: AMBER },
        { text: r.status, width: l.status, fg: STATUS_COLOR[r.status] },
      ],
      false,
    )
    drawn += 1
  }
  while (drawn < height) {
    // An empty flap row: blank tiles, so the board keeps its shape.
    line(
      [
        { text: '', width: l.time, fg: AMBER },
        { text: '', width: l.destination, fg: AMBER },
        { text: '', width: l.platform, fg: AMBER },
        { text: '', width: l.status, fg: AMBER },
      ],
      false,
    )
    drawn += 1
  }
  return cells
}

/** Standard padded base64; no reliance on the environment's encoders. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/**
 * A board on screen: what each flap shows now, what it is falling towards, and
 * how many frames each waits before it starts (the cascade).
 */
export class Flaps {
  readonly columns: number
  readonly rows: number
  private shown: Uint16Array
  private fg: Uint32Array
  private target: Cell[]
  private wait: Int16Array

  constructor(columns: number, rows: number, target: Cell[]) {
    this.columns = columns
    this.rows = rows
    const n = columns * rows
    // A fresh board starts blank and flips in.
    this.shown = new Uint16Array(n).fill(32)
    this.fg = new Uint32Array(n).fill(AMBER)
    this.wait = new Int16Array(n)
    this.target = target
    for (let i = 0; i < n; i += 1) this.wait[i] = stagger(i, columns)
  }

  /** A new target: only the flaps that change start falling, in a cascade. */
  retarget(target: Cell[]): void {
    for (let i = 0; i < target.length; i += 1) {
      const was = this.target[i]
      const now = target[i] as Cell
      if (was === undefined || was.ch !== now.ch) this.wait[i] = stagger(i, this.columns)
    }
    this.target = target
  }

  get settled(): boolean {
    for (let i = 0; i < this.shown.length; i += 1) {
      if (this.shown[i] !== (this.target[i] as Cell).ch) return false
    }
    return true
  }

  /** One frame: every flap that is due falls by one character. */
  step(): boolean {
    let moving = false
    for (let i = 0; i < this.shown.length; i += 1) {
      const want = (this.target[i] as Cell).ch
      const have = this.shown[i] as number
      if (have === want) continue
      moving = true
      if ((this.wait[i] as number) > 0) {
        this.wait[i] = (this.wait[i] as number) - 1
        continue
      }
      this.shown[i] = nextFlap(have, want)
    }
    return moving
  }

  /** The Raster's cells: settled flaps in their colour, falling ones bright. */
  encode(): string {
    const n = this.shown.length
    const words = new Uint32Array(n * 3)
    for (let i = 0; i < n; i += 1) {
      const t = this.target[i] as Cell
      const ch = this.shown[i] as number
      const falling = ch !== t.ch
      words[i * 3] = ch
      words[i * 3 + 1] = falling ? FLIPPING : t.fg
      words[i * 3 + 2] = falling && t.bg === FLAP_BG ? 0x262626 : t.bg
    }
    return base64(new Uint8Array(words.buffer))
  }
}

/** Frames a flap waits before falling: left to right, top to bottom, like a real board. */
function stagger(i: number, columns: number): number {
  const row = Math.floor(i / columns)
  const col = i % columns
  return Math.min(40, Math.floor(col * 0.35) + row * 3)
}

/** The next character on the drum towards `want`; a character off the drum snaps straight there. */
export function nextFlap(have: number, want: number): number {
  const from = DRUM_INDEX.get(have)
  const to = DRUM_INDEX.get(want)
  if (from === undefined || to === undefined) return want
  return DRUM.charCodeAt((from + 1) % DRUM.length)
}

/** Board text for a status from a todo or task. */
export function statusOf(status: string, hadError: boolean): BoardStatus {
  if (status === 'completed') return 'DEPARTED'
  if (status === 'deleted') return 'CANCELLED'
  if (status === 'in_progress') return hadError ? 'DELAYED' : 'BOARDING'
  return 'ON TIME'
}

/** "HH:MM" in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What a tool call is about, for the platform column. */
export function platformOf(e: { tool: string; [k: string]: unknown }): string {
  const path = e.file_path ?? e.notebook_path
  if (typeof path === 'string' && path.length > 0) return path.split('/').pop() ?? path
  if (e.tool === 'Bash' && typeof e.command === 'string') {
    const word = e.command.trim().split(/\s+/)[0] ?? ''
    return word.split('/').pop() ?? 'BASH'
  }
  if (typeof e.url === 'string') {
    try {
      return new URL(e.url).hostname
    } catch {
      return 'WEB'
    }
  }
  return e.tool.startsWith('mcp__') ? (e.tool.split('__')[1] ?? 'MCP') : e.tool
}

/** Is this row still on its way: boarding, delayed while running, or a turn that has not ended. */
export function isLive(r: BoardRow): boolean {
  if (r.source === 'turn') return r.isActive
  return r.status === 'BOARDING' || r.status === 'DELAYED'
}

/** The rows a board shows, best first: what is on its way, then the most recently changed. */
export function boardOrder(rows: BoardRow[], room: number): BoardRow[] {
  const live = rows.filter(isLive).sort((a, b) => b.at - a.at)
  const rest = rows.filter(r => !isLive(r)).sort((a, b) => b.at - a.at)
  return [...live, ...rest].slice(0, Math.max(0, room))
}

// Most rows kept: turn history first, then finished work, are what make room.
export const MAX_ROWS = 60
export const MAX_TURNS = 12

/** Bound the list without ever dropping work that is still on its way. */
export function trim(rows: BoardRow[]): BoardRow[] {
  let list = rows
  const turns = list.filter(r => r.source === 'turn' && !r.isActive).sort((a, b) => a.at - b.at)
  const extraTurns = Math.max(0, turns.length - MAX_TURNS)
  const dropTurns = new Set(turns.slice(0, extraTurns).map(r => r.id))
  list = list.filter(r => !dropTurns.has(r.id))
  if (list.length <= MAX_ROWS) return list
  const finished = list
    .filter(r => !isLive(r) && r.status !== 'ON TIME')
    .sort((a, b) => (a.source === 'turn' ? 0 : 1) - (b.source === 'turn' ? 0 : 1) || a.at - b.at)
  const drop = new Set(finished.slice(0, list.length - MAX_ROWS).map(r => r.id))
  return list.filter(r => !drop.has(r.id))
}

/** Stable ids for a todo list: the raw content, plus which copy it is when the same text repeats. */
export function todoIds(contents: string[]): string[] {
  const seen = new Map<string, number>()
  return contents.map(c => {
    const n = seen.get(c) ?? 0
    seen.set(c, n + 1)
    return `todo:${c}#${n}`
  })
}
