import { Readable } from 'node:stream'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { readSlice, UploadTooLargeError } from './upload.js'

// Unit tests rather than requests: a server refusing a body mid-upload
// cancels the client's write, which supertest reports as an error on
// Windows and macOS rather than the answer.
const requestOf = (stream: Readable, headers: Record<string, string> = {}) =>
  Object.assign(stream, { headers }) as unknown as Request

describe('reading a slice', () => {
  it('reads a slice within the limit', async () => {
    const request = requestOf(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    await expect(readSlice(request, 6)).resolves.toEqual(Buffer.from('abcdef'))
  })

  it('refuses a slice its Content-Length says is too large, before reading it', async () => {
    const request = requestOf(Readable.from([Buffer.from('abc')]), { 'content-length': '7' })
    await expect(readSlice(request, 6)).rejects.toThrow(new UploadTooLargeError(6, 'A slice'))
  })

  it('refuses a slice that grows past the limit as it arrives', async () => {
    const request = requestOf(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]))
    await expect(readSlice(request, 6)).rejects.toBeInstanceOf(UploadTooLargeError)
  })

  it('gives up on a slice whose request closes before its body ends', async () => {
    const stream = new Readable({ read() {} })
    const reading = readSlice(requestOf(stream), 6)
    stream.push(Buffer.from('abc'))
    stream.destroy()
    await expect(reading).rejects.toThrow('closed before its body ended')
  })
})
