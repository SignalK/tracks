/**
 * Importing GPX files as tracks.
 *
 * The file goes to this plugin's own route, which reads it with the same GPX
 * parser the export uses: the page ships with no bundler and cannot reach it.
 * Storing needs write access, which the server enforces.
 */
import { refusal } from './bin.js'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const IMPORT_URL = '../../plugins/tracks/imports'

/** What an import came to, in words. */
export function imported({ ids, skippedPoints }) {
  const count = `Imported ${ids.length} track${ids.length === 1 ? '' : 's'}.`
  return skippedPoints > 0
    ? `${count} ${skippedPoints} point${skippedPoints === 1 ? '' : 's'} without a time left out.`
    : count
}

async function messageOf(response) {
  try {
    const body = await response.json()
    return body?.message ?? body?.error
  } catch {
    return undefined
  }
}

function start() {
  const form = document.getElementById('import-form')
  const status = document.getElementById('import-status')

  function show(message, state) {
    status.textContent = message
    status.hidden = false
    if (state) {
      status.dataset.state = state
    } else {
      delete status.dataset.state
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const file = form.elements.file.files[0]
    if (!file) {
      show('Choose a GPX file first.', 'error')
      return
    }
    const query = form.elements.self.checked ? '?self=true' : ''
    show('Importing…')
    let response
    try {
      response = await fetch(`${IMPORT_URL}${query}`, {
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
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!Array.isArray(body?.ids)) {
      show('The server sent a response this page could not read.', 'error')
      return
    }
    show(imported(body))
    // The list shows the last 30 days; an older passage is stored all the same.
    setTimeout(() => location.reload(), 1500)
  })
}

if (typeof document !== 'undefined') {
  start()
}
