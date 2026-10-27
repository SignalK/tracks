/**
 * A GPX file too large for one request: a look at its tracks before any of it
 * is sent, and the upload itself, slice by slice (see src/gpxUpload.ts for
 * the server side). Neither holds more of the file than one slice: a
 * chartplotter's export of several years runs past a gigabyte.
 */

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
export const UPLOAD_URL = '../../plugins/tracks/imports/upload'

/** Bytes per request: well under the server's 8 MiB limit. */
export const SLICE_BYTES = 4 * 1024 * 1024

/** Bytes the scan reads at a time. */
const SCAN_BYTES = 8 * 1024 * 1024

// A boat's Wi-Fi drops for a moment now and then, a plugin restart takes the
// routes away for a few seconds, and a slice whose answer was lost can still
// be writing on a slow SD card. A slice that did not get through is sent
// again from wherever the server says it got to, waiting twice as long each
// time: about four minutes in all.
const RETRIES = 8
const RETRY_DELAY_MS = 2000
const RETRY_DELAY_MAX_MS = 60_000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * XML's predefined and numeric character references, decoded: the server
 * chooses a track by its name as the parser reads it, so the name chosen
 * here must be spelled the same.
 */
function decodeEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (match, decimal, hex, named) => {
    if (named !== undefined) return ENTITIES[named]
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/** Named as TimeZero names the AIS targets it followed: `AIS <name>`, or the bare MMSI. */
export function isOtherVessel(name) {
  return /^AIS\b/.test(name) || /^\d{9}$/.test(name)
}

const TAG = /<(\/?)(?:[\w.-]+:)?([\w.-]+)[^>]*?(\/?)>/g

/**
 * The tracks of a GPX file by name, `''` for one without, each with how many
 * points it has and the times of its first and last point as written.
 *
 * It picks out tags rather than parsing, which reads a gigabyte in seconds
 * where a parser would take minutes; the server parses the upload properly
 * and imports only the names chosen here, so a file odd enough to fool this
 * scan costs a track in the list, never a wrong position. A track's name is
 * the `<name>` it has before its first segment, as the server reads it.
 */
export async function scanGpx(file, onProgress = () => {}, chunkBytes = SCAN_BYTES) {
  const tracks = new Map()
  const decoder = new TextDecoder()
  let carry = ''
  let track
  // Elements open inside the current <trk>, so its own <name> is told from one in <extensions>.
  let depth = 0
  let capture
  let text = ''
  const close = (name) => {
    if (name === 'name' && capture === 'name' && track.name === undefined) {
      // As the parser reads line ends.
      track.name = decodeEntities(text.replace(/\r\n?/g, '\n')).trim()
    } else if (name === 'time' && capture === 'time') {
      const time = text.trim()
      track.group.from ??= time
      track.group.to = time
    }
    capture = undefined
  }
  const group = (name) => {
    let found = tracks.get(name)
    if (!found) tracks.set(name, (found = { name, points: 0 }))
    return found
  }
  for (let at = 0; at < file.size; at += chunkBytes) {
    const chunk = carry + decoder.decode(await file.slice(at, at + chunkBytes).arrayBuffer(), { stream: true })
    let end = 0
    TAG.lastIndex = 0
    for (let match = TAG.exec(chunk); match; match = TAG.exec(chunk)) {
      if (capture) text += chunk.slice(end, match.index)
      end = TAG.lastIndex
      const [, closing, name, empty] = match
      if (name === 'trk') {
        if (closing) {
          track = undefined
        } else {
          track = {}
          depth = 0
        }
        continue
      }
      if (!track) continue
      if (closing) {
        depth--
        close(name)
        continue
      }
      if (name === 'trkseg' && track.group === undefined) {
        track.group = group(track.name ?? '')
      }
      if (name === 'name' && depth === 0 && track.group === undefined) {
        capture = 'name'
        text = ''
      } else if (name === 'trkpt' && track.group) {
        track.group.points++
      } else if (name === 'time' && track.group) {
        capture = 'time'
        text = ''
      }
      if (empty) close(name)
      else depth++
    }
    // A tag cut by the end of the chunk is read whole with the next one.
    const open = chunk.lastIndexOf('<')
    carry = open >= end ? chunk.slice(open) : ''
    if (capture) text += chunk.slice(end, open >= end ? open : chunk.length)
    onProgress(Math.min(file.size, at + chunkBytes) / file.size)
  }
  return [...tracks.values()]
}

/** The answer's body, or what it says in place of one. */
async function bodyOf(response) {
  try {
    return await response.json()
  } catch {
    return { message: `The server answered ${response.status}.` }
  }
}

/** Refusals no second try changes. */
const FINAL = new Set([400, 401, 403, 413, 415, 422])

/**
 * Send `file` into the own vessel's recording, resolving to the finished
 * upload's status; `onStatus` hears each one on the way. An upload of the
 * same file with the same choices that a dropped connection or a restart
 * broke off goes on from where the server got to. Aborting `signal` ends the
 * upload on the server once the slice in flight is written.
 */
export async function uploadGpx({ file, tracks, onOverlap, onStatus, signal, request = fetch, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const call = (url, init = {}) => request(url, { credentials: 'include', ...init })
  const current = async () => {
    const response = await call(UPLOAD_URL)
    return response.ok ? (await bodyOf(response)).upload : undefined
  }

  let status = await current().catch(() => undefined)
  const same =
    status?.state === 'receiving' &&
    status.filename === file.name &&
    status.size === file.size &&
    status.onOverlap === onOverlap &&
    status.tracks.length === tracks.length &&
    status.tracks.every((name) => tracks.includes(name))
  if (!same) {
    const response = await call(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, tracks, onOverlap }),
    })
    const body = await bodyOf(response)
    if (!response.ok || !body.upload) {
      throw new Error(body.message ?? `The server answered ${response.status}.`)
    }
    status = body.upload
  }
  onStatus(status)
  const url = `${UPLOAD_URL}/${encodeURIComponent(status.id)}`

  let failures = 0
  const retry = async (error) => {
    if (++failures > RETRIES) throw error
    await wait(Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), RETRY_DELAY_MAX_MS))
  }
  while (status.state === 'receiving') {
    if (signal?.aborted) {
      const response = await call(url, { method: 'DELETE' }).catch(() => undefined)
      const body = response?.ok ? await bodyOf(response) : undefined
      if (body?.upload) onStatus(body.upload)
      throw new DOMException('The import was stopped', 'AbortError')
    }
    const offset = status.received
    let response
    try {
      response = await call(`${url}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, offset + SLICE_BYTES),
      })
    } catch {
      await retry(new Error('Could not reach the server.'))
      // The slice may have arrived though its answer did not.
      const now = await current().catch(() => undefined)
      if (now?.id === status.id) status = now
      continue
    }
    const body = await bodyOf(response)
    if (response.ok && body.upload) {
      failures = 0
      status = body.upload
      onStatus(status)
      continue
    }
    if (FINAL.has(response.status)) {
      throw new Error(body.message ?? `The server answered ${response.status}.`)
    }
    // Out of step, a failed write the server took back, or the plugin
    // restarting: go on from where the server says it is.
    await retry(new Error(body.message ?? `The server answered ${response.status}.`))
    const now = body.upload ?? (await current().catch(() => undefined))
    if (now?.id === status.id) status = now
  }
  if (status.state !== 'finished') {
    throw new Error(status.error ?? `The import is ${status.state}.`)
  }
  return status
}
