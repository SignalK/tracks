import type { Request } from 'express'

/** The largest GPX file the upload route reads, so one request cannot exhaust memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`The file is larger than ${Math.round(limit / (1024 * 1024))} MB`)
  }
}

/**
 * A request's body as UTF-8 text, refused past `limit` bytes.
 *
 * Read here rather than by a body parser because the server installs only a
 * JSON one, and a GPX file arrives as XML. A body some other middleware has
 * already read as text is taken as it is.
 */
export function readText(req: Request, limit = MAX_UPLOAD_BYTES): Promise<string> {
  const parsed: unknown = req.body
  if (typeof parsed === 'string') {
    return Buffer.byteLength(parsed) > limit ? Promise.reject(new UploadTooLargeError(limit)) : Promise.resolve(parsed)
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new UploadTooLargeError(limit))
        // Stop reading, but leave the socket open for the 413.
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
