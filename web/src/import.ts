/**
 * Importing GPX files as tracks.
 *
 * The file goes to this plugin's own routes, which read it with the same GPX
 * rules the export uses: the page imports no server code and cannot reach
 * them. A file of the own vessel goes in slices into its recording, after the
 * page lists the file's tracks to choose from (upload.ts); any other goes in
 * one request and is kept as an import. Storing needs write access, which the
 * server enforces.
 */
import type { GpxUploadStatus, ImportAnswer, Refusal } from './api.js'
import { refusal } from './bin.js'
import { byId, within } from './dom.js'
import { isOtherVessel, scanGpx, uploadGpx } from './upload.js'
import type { ScannedTrack } from './upload.js'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const IMPORT_URL = '../../plugins/tracks/imports'

/** The import form's fields, by name. */
interface ImportFields {
  file: HTMLInputElement
  self: HTMLInputElement
  replace: HTMLInputElement
}

/**
 * The largest file the one-request import takes, as the server's
 * MAX_UPLOAD_BYTES: an import is read whole, so another vessel's track cannot
 * go in slices.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

const points = (count: number) => `${count.toLocaleString()} point${count === 1 ? '' : 's'}`

/** Points the own vessel's retention, in the plugin's danger zone, would delete within the hour. */
const tooOld = (count: number) =>
  count === 1
    ? "1 point was left out because it is older than your vessel's track is kept."
    : `${points(count)} were left out because they are older than your vessel's track is kept.`

/** What an import came to, in words. */
export function imported({ ids, skippedPoints, overlappingPoints = 0, expiredPoints = 0 }: ImportAnswer): string {
  return [
    `Imported ${ids.length} track${ids.length === 1 ? '' : 's'}.`,
    ...(skippedPoints > 0 ? [`${points(skippedPoints)} without a time left out.`] : []),
    ...(overlappingPoints > 0 ? [`${points(overlappingPoints)} left out where your vessel already has a track.`] : []),
    ...(expiredPoints > 0 ? [tooOld(expiredPoints)] : []),
  ].join(' ')
}

/** What an upload into the own vessel's recording came to, in words. */
export function uploaded({
  imported: count,
  overlapping,
  untimed,
  expired = 0,
}: Pick<GpxUploadStatus, 'imported' | 'overlapping' | 'untimed'> & { expired?: number }): string {
  return [
    `Imported ${points(count)} into your vessel's track.`,
    ...(untimed > 0 ? [`${points(untimed)} without a time left out.`] : []),
    ...(overlapping > 0 ? [`${points(overlapping)} left out where your vessel already has a track.`] : []),
    ...(expired > 0 ? [tooOld(expired)] : []),
  ].join(' ')
}

const MB = 1024 * 1024

/** How far an upload got, in words. */
export function progress({ received, size }: Pick<GpxUploadStatus, 'received' | 'size'>): string {
  const share = Math.floor((received / size) * 100)
  return `Importing: ${share}%, ${(received / MB).toFixed(0)} of ${(size / MB).toFixed(0)} MB.`
}

const titled = (name: string) => (name === '' ? '(no name)' : name)

/** A track of the scanned file as the list to choose from offers it. */
export interface TrackChoice {
  name: string
  label: string
  disabled: boolean
  checked: boolean
}

/** A track of the scanned file as its row in the list to choose from (see `scanGpx` for what the scan says of it). */
export function trackChoice({ name, points: count, from, to, elsewhere, partly, foreign }: ScannedTrack): TrackChoice {
  const times =
    from === undefined
      ? 'no times'
      : from === to
        ? from.slice(0, 10)
        : `${from.slice(0, 10)} to ${(to ?? from).slice(0, 10)}`
  const seen =
    elsewhere === undefined ? '' : `, ${partly ? 'partly ' : ''}elsewhere than ${titled(elsewhere)} at the same time`
  return {
    name,
    label: `${titled(name)}: ${points(count)}, ${times}${seen}`,
    // A track without times cannot be placed in the recording.
    disabled: from === undefined,
    // Another vessel's track written into the recording would draw lines to wherever it was.
    checked: from !== undefined && !isOtherVessel(name) && foreign !== true,
  }
}

async function messageOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as Refusal | null
    return body?.message ?? body?.error
  } catch {
    return undefined
  }
}

export function start(): void {
  const form = byId<HTMLFormElement>('import-form')
  const status = byId('import-status')
  const choices = byId<HTMLFieldSetElement>('import-tracks')
  const stop = byId<HTMLButtonElement>('import-stop')
  const button = within<HTMLButtonElement>(form, 'button[type="submit"]')
  const fields = form.elements as HTMLFormControlsCollection & ImportFields
  const { self, replace } = fields
  // Only the own vessel has a recording to replace.
  const allowReplace = () => {
    replace.disabled = !self.checked
  }
  allowReplace()
  self.addEventListener('change', allowReplace)

  function show(message: string, state?: string): void {
    // A failed upload can be tried again; a successful one reloads the page.
    if (state === 'error') {
      button.disabled = false
    }
    status.textContent = message
    status.hidden = false
    if (state) {
      status.dataset.state = state
    } else {
      delete status.dataset.state
    }
  }

  /** The tracks of the chosen file, listed to choose from while the own vessel is ticked. */
  let scanned: File | undefined
  let scanning = 0
  async function listTracks(): Promise<void> {
    const file = fields.file.files?.[0]
    const run = ++scanning
    scanned = undefined
    choices.replaceChildren()
    choices.hidden = true
    if (!self.checked || !file) {
      return
    }
    show('Reading the file…')
    let tracks: ScannedTrack[]
    try {
      tracks = await scanGpx(file, (share) => {
        if (run === scanning) show(`Reading the file: ${Math.floor(share * 100)}%`)
      })
    } catch {
      if (run === scanning) show('The file could not be read.', 'error')
      return
    }
    if (run !== scanning) {
      return
    }
    if (tracks.length === 0) {
      show('No track found: the file is not GPX, has no track with points, or nests too deeply to scan.', 'error')
      return
    }
    scanned = file
    const legend = document.createElement('legend')
    legend.textContent = 'Tracks of my own vessel in the file'
    choices.append(legend)
    for (const track of tracks) {
      const choice = trackChoice(track)
      const label = document.createElement('label')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.name = 'track'
      box.value = choice.name
      box.checked = choice.checked
      box.disabled = choice.disabled
      label.append(box, ` ${choice.label}`)
      choices.append(label)
    }
    choices.hidden = false
    status.hidden = true
  }
  fields.file.addEventListener('change', listTracks)
  self.addEventListener('change', listTracks)

  let stopping: AbortController | undefined
  stop.addEventListener('click', () => {
    stopping?.abort()
    show('Stopping…')
  })

  async function uploadOwn(file: File): Promise<void> {
    const tracks = [...choices.querySelectorAll<HTMLInputElement>('input[name="track"]:checked')].map(
      ({ value }) => value,
    )
    if (scanned !== file || tracks.length === 0) {
      show('Choose the tracks of your own vessel first.', 'error')
      return
    }
    button.disabled = true
    const stopper = new AbortController()
    stopping = stopper
    stop.hidden = false
    try {
      const done = await uploadGpx({
        file,
        tracks,
        onOverlap: replace.checked ? 'replace' : 'keep',
        onStatus: (upload) => {
          if (!stopper.signal.aborted) show(progress(upload))
        },
        signal: stopper.signal,
      })
      show(uploaded(done))
      setTimeout(() => location.reload(), 1500)
    } catch (err) {
      show(
        err instanceof Error && err.name === 'AbortError'
          ? 'Stopped. What was imported stays; importing the file again fills in the rest.'
          : err instanceof Error
            ? err.message
            : 'The import failed.',
        'error',
      )
    } finally {
      stop.hidden = true
      stopping = undefined
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    // Each request stores the file anew, so a second click while one is in
    // flight would import every track in it twice.
    if (button.disabled) {
      return
    }
    const file = fields.file.files?.[0]
    if (!file) {
      show('Choose a GPX file first.', 'error')
      return
    }
    if (self.checked) {
      await uploadOwn(file)
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      show(
        `A file of another vessel can be at most ${MAX_FILE_BYTES / MB} MB. A larger one of your own vessel imports when you tick that.`,
        'error',
      )
      return
    }
    button.disabled = true
    show('Importing…')
    let response
    try {
      response = await fetch(IMPORT_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/gpx+xml' },
        body: file,
      })
    } catch {
      show('Could not reach the server.', 'error')
      return
    }
    if (!response.ok) {
      show((await messageOf(response)) ?? refusal(response.status), 'error')
      return
    }
    let body: ImportAnswer | undefined
    try {
      body = (await response.json()) as ImportAnswer | undefined
    } catch {
      body = undefined
    }
    if (body === undefined || !Array.isArray(body?.ids)) {
      show('The server sent a response this page could not read.', 'error')
      return
    }
    show(imported(body))
    // Reloaded so the list, which shows every import, includes this one.
    setTimeout(() => location.reload(), 1500)
  })
}

if (typeof document !== 'undefined') {
  start()
}
