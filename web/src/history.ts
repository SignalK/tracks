/**
 * Importing the own vessel's track from a history provider.
 *
 * Offered only where a provider is installed, and only to an administrator,
 * which the server enforces: the import writes into the recording. It runs on
 * the server, day by day, so the page starts it and shows how far it got.
 */
import type { HistoryImportAnswer, Refusal } from './api.js'
import { refusal } from './bin.js'
import { byId } from './dom.js'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const HISTORY_IMPORT_URL = '../../plugins/tracks/history-import'

/** How often the page asks how far a running import got. */
export const POLL_MS = 5000

const positions = (count: number) => `${count} position${count === 1 ? '' : 's'}`

/**
 * A date in the viewer's locale. The import goes by UTC days, so the day it
 * got to is shown in UTC, as the plugin status shows it; when it finished is
 * an instant, shown in the viewer's zone.
 */
const day = (iso: string, timeZone?: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString(undefined, timeZone ? { timeZone } : {})
}

/**
 * What the page says of the import, and what its button offers, from the
 * route's answer; undefined where there is nothing to import from or to show.
 */
/** What the page shows of the import: its text, the button's label (none hides it) and a status state. */
export interface HistoryView {
  text: string
  button?: string | undefined
  state?: string
}

export function historyView({ provider, state }: HistoryImportAnswer): HistoryView | undefined {
  if (!state) {
    return provider ? { text: 'Not imported yet.', button: 'Import' } : undefined
  }
  const filled = `${positions(state.filled)} filled`
  if (state.running) {
    if (state.firstDay === undefined || state.nextDay === undefined) {
      return { text: 'Importing: finding where the history begins…' }
    }
    const done = Date.parse(state.nextDay) - Date.parse(state.firstDay)
    const all = Math.max(1, Date.parse(state.startedAt) - Date.parse(state.firstDay))
    const share = Math.floor((100 * done) / all)
    return { text: `Importing: ${share}% done, up to ${day(state.nextDay, 'UTC')}. ${filled} so far.` }
  }
  // Without a provider an unfinished import has nothing to go on with.
  const resume = provider ? 'Resume' : undefined
  const where = state.nextDay === undefined ? '' : ` at ${day(state.nextDay, 'UTC')}`
  if (state.error !== undefined) {
    return { text: `The import stopped${where}: ${state.error}. ${filled}.`, button: resume, state: 'error' }
  }
  if (state.finishedAt !== undefined) {
    return { text: `Imported on ${day(state.finishedAt)}: ${filled}.`, button: provider ? 'Import again' : undefined }
  }
  // Neither running, failed nor finished: a stop broke it off, and it goes
  // on by itself a minute after the plugin starts.
  return { text: `The import stopped${where}, and goes on shortly. ${filled}.`, button: resume }
}

async function messageOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as Refusal | null
    return body?.message ?? body?.error
  } catch {
    return undefined
  }
}

export function start(): Promise<void> {
  const section = byId('history')
  const status = byId('history-status')
  const button = byId<HTMLButtonElement>('history-start')
  let timer: ReturnType<typeof setTimeout> | undefined

  function show(text: string, state?: string): void {
    status.textContent = text
    if (state) {
      status.dataset.state = state
    } else {
      delete status.dataset.state
    }
  }

  async function load(): Promise<void> {
    clearTimeout(timer)
    let response
    try {
      response = await fetch(HISTORY_IMPORT_URL, { credentials: 'include', signal: AbortSignal.timeout(30_000) })
    } catch {
      // Asked again while an import runs, so a dropped request does not
      // freeze the progress shown.
      if (!section.hidden) timer = setTimeout(load, POLL_MS)
      return
    }
    // Refused to anyone but an administrator, who alone can start it. Shown
    // already, the section is following an import, and a plugin restart or a
    // storage error must not freeze its progress.
    if (!response.ok) {
      if (!section.hidden) timer = setTimeout(load, POLL_MS)
      return
    }
    let body: HistoryImportAnswer | null
    try {
      body = (await response.json()) as HistoryImportAnswer | null
    } catch {
      if (!section.hidden) timer = setTimeout(load, POLL_MS)
      return
    }
    const view = historyView(body ?? {})
    section.hidden = view === undefined
    if (!view) {
      return
    }
    show(view.text, view.state)
    button.hidden = view.button === undefined
    button.textContent = view.button ?? ''
    button.disabled = false
    if (body?.state?.running) {
      timer = setTimeout(load, POLL_MS)
    }
  }

  button.addEventListener('click', async () => {
    // One start at a time; the server refuses a second one anyway.
    if (button.disabled) {
      return
    }
    button.disabled = true
    let response
    try {
      response = await fetch(HISTORY_IMPORT_URL, { method: 'POST', credentials: 'include' })
    } catch {
      show('Could not reach the server.', 'error')
      button.disabled = false
      return
    }
    if (!response.ok) {
      show((await messageOf(response)) ?? refusal(response.status), 'error')
      button.disabled = false
      return
    }
    await load()
  })

  return load()
}

if (typeof document !== 'undefined') {
  void start()
}
