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

/** Bytes at each end of the file its fingerprint reads. */
const FINGERPRINT_BYTES = 64 * 1024

/** cyrb53, a fast 53-bit string hash: enough to tell two files apart by chance, not against intent. */
function hash53(bytes) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761)
    h2 = Math.imul(h2 ^ byte, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * What tells `file` from another of its name and size, so that an upload
 * broken off goes on only with the file it began with: its time of change,
 * and a hash of its first and last bytes. Not a digest of the whole file,
 * which would mean reading a gigabyte before every resume; and not
 * SubtleCrypto, which a page served over plain http, as most boats serve
 * it, does not have.
 */
export async function fingerprintOf(file) {
  const head = new Uint8Array(await file.slice(0, FINGERPRINT_BYTES).arrayBuffer())
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - FINGERPRINT_BYTES)).arrayBuffer())
  return `${file.lastModified ?? 0}:${hash53(head)}:${hash53(tail)}`
}

/** The answer's body, or what it says in place of one. */
async function bodyOf(response) {
  try {
    return await response.json()
  } catch {
    return { message: `The server answered ${response.status}.` }
  }
}

/** Tries at ending an upload, a retry delay apart: a slice still being written holds it. */
const STOP_ATTEMPTS = 5

/**
 * End the upload on the server, and throw the AbortError that says so, or
 * the error that says the server was not told: it then keeps the upload
 * until IDLE_TIMEOUT_MS has passed without a slice.
 */
async function stopUpload(call, url, onStatus, wait) {
  let ended = false
  for (let attempt = 0; attempt < STOP_ATTEMPTS && !ended; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAY_MS)
    const response = await call(url, { method: 'DELETE' }).catch(() => undefined)
    const upload = response && (await bodyOf(response)).upload
    if (upload) onStatus(upload)
    ended = response?.ok === true || (upload !== undefined && upload.state !== 'receiving')
  }
  if (!ended) {
    throw new Error(
      'Stopped sending, but the server could not be told. It holds the import until another one takes its place, which it allows after 15 minutes without a slice.',
    )
  }
  throw stopped()
}

/** What `promise` comes to, or undefined as soon as `signal` aborts. */
function unlessAborted(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const aborted = () => resolve(undefined)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', aborted)
        reject(err)
      },
    )
  })
}

/** Wait `ms`, or less once `signal` aborts. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

const stopped = () => new DOMException('The import was stopped', 'AbortError')

/** Refusals no second try changes. */
const FINAL = new Set([400, 401, 403, 413, 415, 422])

/**
 * Send `file` into the own vessel's recording, resolving to the finished
 * upload's status; `onStatus` hears each one on the way. An upload of the
 * same file with the same choices that a dropped connection or a restart
 * broke off goes on from where the server got to. Aborting `signal` gives
 * up the slice on its way and ends the upload on the server; what the server
 * wrote stays.
 */
export async function uploadGpx({ file, tracks, onOverlap, onStatus, signal, request = fetch, sleep }) {
  const wait = sleep ?? ((ms) => pause(ms))
  // Stop does not wait out a retry's delay.
  const backOff = (ms) => (sleep ? unlessAborted(sleep(ms), signal) : pause(ms, signal))
  const call = (url, init = {}) => request(url, { credentials: 'include', ...init })
  const current = async () => {
    const response = await call(UPLOAD_URL)
    return response.ok ? (await bodyOf(response)).upload : undefined
  }

  const fingerprint = await fingerprintOf(file)
  let status = await unlessAborted(
    current().catch(() => undefined),
    signal,
  )
  if (signal?.aborted) throw stopped()
  const same =
    status?.state === 'receiving' &&
    status.filename === file.name &&
    status.size === file.size &&
    status.fingerprint === fingerprint &&
    status.onOverlap === onOverlap &&
    status.tracks.length === tracks.length &&
    status.tracks.every((name) => tracks.includes(name))
  if (!same) {
    const starting = call(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, tracks, onOverlap, fingerprint }),
    })
    const response = await unlessAborted(starting, signal)
    if (response === undefined) {
      // The request itself goes on, so that an upload it starts is ended once its answer comes.
      void starting
        .then(bodyOf)
        .then(({ upload }) => {
          if (upload?.state === 'receiving') {
            return call(`${UPLOAD_URL}/${encodeURIComponent(upload.id)}`, { method: 'DELETE' })
          }
          return undefined
        })
        .catch(() => undefined)
      throw stopped()
    }
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
    await backOff(Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), RETRY_DELAY_MAX_MS))
  }
  while (status.state === 'receiving') {
    if (signal?.aborted) {
      await stopUpload(call, url, onStatus, wait)
    }
    const offset = status.received
    let response
    try {
      response = await call(`${url}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, offset + SLICE_BYTES),
        // Stop does not wait for a slice that is stuck on its way: the
        // server goes on from what it wrote either way.
        signal,
      })
    } catch {
      if (signal?.aborted) continue
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
