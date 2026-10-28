import type { Request } from 'express'

/** The largest GPX file the upload route reads, so one request cannot exhaust memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export class UploadTooLargeError extends Error {
  constructor(limit: number, what = 'The file') {
    super(`${what} is larger than ${Math.round(limit / (1024 * 1024))} MB`)
  }
}

/** A body the server already parsed as something other than a file. */
export class UploadTypeError extends Error {
  constructor(what = 'the file', type = 'application/gpx+xml') {
    super(`Send ${what} as the request body, with Content-Type ${type}`)
  }
}

/** XML allows a byte-order mark, and the GPX parser does not skip one. */
const withoutBom = (text: string) => (text.startsWith('\uFEFF') ? text.slice(1) : text)

/**
 * A request's body as UTF-8 text, refused past `limit` bytes.
 *
 * Read here rather than by a body parser because the server parses only JSON
 * and form bodies, and a GPX file arrives as XML. A body some other middleware
 * has already read as text is taken as it is; one it read as anything else is
 * refused, since the stream it came from is spent.
 */
export function readText(req: Request, limit = MAX_UPLOAD_BYTES): Promise<string> {
  const parsed: unknown = req.body
  if (typeof parsed === 'string') {
    return Buffer.byteLength(parsed) > limit
      ? Promise.reject(new UploadTooLargeError(limit))
      : Promise.resolve(withoutBom(parsed))
  }
  return readBytes(req, limit).then((bytes) => withoutBom(bytes.toString('utf8')))
}

/**
 * A slice of a file uploaded in slices, refused past `limit` bytes; see
 * gpxUpload.ts. Its bytes are taken as they are: a slice can begin or end
 * inside a character.
 */
export function readSlice(req: Request, limit: number): Promise<Buffer> {
  return readBytes(
    req,
    limit,
    () => new UploadTooLargeError(limit, 'A slice'),
    () => new UploadTypeError('the slice', 'application/octet-stream'),
  )
}

/** A request's body, unless another middleware has already read it. */
function readBytes(
  req: Request,
  limit: number,
  tooLarge = () => new UploadTooLargeError(limit),
  spent = () => new UploadTypeError(),
): Promise<Buffer> {
  if (req.readableEnded) {
    return Promise.reject(spent())
  }
  // Refused before reading when the client says up front it is too large.
  if (Number(req.headers['content-length']) > limit) {
    return Promise.reject(tooLarge())
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(tooLarge())
        // Stop reading, but leave the socket open for the 413.
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    // A client that gave up: the body never ends.
    req.on('close', () => {
      if (!req.readableEnded) reject(new Error('The request was closed before its body ended'))
    })
  })
}
