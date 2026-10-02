// What a row's status column says, Solari-style.
export type BoardStatus = 'ON TIME' | 'BOARDING' | 'DEPARTED' | 'DELAYED' | 'CANCELLED'

// One departure: a work item of the session.
export type BoardRow = {
  id: string
  // Wall-clock time the item first appeared, "HH:MM".
  time: string
  destination: string
  platform: string
  status: BoardStatus
  source: 'todo' | 'task' | 'turn'
  // Sort key: when the row last changed, ms since the epoch.
  at: number
  // An error happened while this item was in progress (it shows DELAYED until it finishes).
  isTroubled: boolean
  // A turn row that is still running; finished turns are frozen.
  isActive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'departure-board': {
      rows: BoardRow[]
      isBandHidden: boolean
    }
  }
}
