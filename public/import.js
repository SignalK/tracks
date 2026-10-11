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

export function start() {
  const form = document.getElementById('import-form')
  const status = document.getElementById('import-status')
  const button = form.querySelector('button[type="submit"]')

  function show(message, state) {
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    // Each request stores the file anew, so a second click while one is in
    // flight would import every track in it twice.
    if (button.disabled) {
      return
    }
    const file = form.elements.file.files[0]
    if (!file) {
      show('Choose a GPX file first.', 'error')
      return
    }
    const query = form.elements.self.checked ? '?self=true' : ''
    button.disabled = true
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
    // Reloaded so the list, which shows every import, includes this one.
    setTimeout(() => location.reload(), 1500)
  })
}

if (typeof document !== 'undefined') {
  start()
}
