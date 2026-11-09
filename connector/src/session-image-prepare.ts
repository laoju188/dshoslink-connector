import { createHash } from 'node:crypto'
import { prepareImageFile } from '@deepseek-ai/dsh-attachment-local'
import { imageReference, SESSION_IMAGE_MAX_BYTES, SESSION_IMAGE_MAX_DIMENSION,
  SESSION_IMAGE_MAX_PIXELS } from './session-image-contract.js'

export type SessionImagePreparer = (input: {
  data: Buffer; mediaType: string; name: string
}) => Promise<{ data: Buffer; mediaType: string }>

// The native decoder admits up to 64M source pixels. Never decode uploads in parallel.
let preparing = false
export const prepareSessionImage: SessionImagePreparer = async input => {
  if (preparing) throw new Error('Image preparation busy')
  if (input.mediaType !== 'image/png' && input.mediaType !== 'image/jpeg'
    && input.mediaType !== 'image/webp' && input.mediaType !== 'image/gif') throw new Error('Invalid image type')
  preparing = true
  let prepared: Awaited<ReturnType<typeof prepareImageFile>> | undefined
  try {
    prepared = await prepareImageFile({ ...input, mediaType: input.mediaType }, {
      maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 20, maxImagePixels: 64_000_000, maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    }, { maxPixels: SESSION_IMAGE_MAX_PIXELS, maxDimension: SESSION_IMAGE_MAX_DIMENSION,
      maxBytes: SESSION_IMAGE_MAX_BYTES })
    // maxBytes is only the official encoder's target. Check the actual result independently.
    if (imageReference(prepared.ref, 0) === undefined || prepared.data.byteLength !== prepared.ref.bytes
      || `sha256:${createHash('sha256').update(prepared.data).digest('hex')}` !== prepared.ref.attachmentId) {
      throw new Error('Prepared image exceeds the phone contract')
    }
    return { data: Buffer.from(prepared.data), mediaType: prepared.ref.mediaType }
  } finally {
    if (prepared !== undefined && prepared.data.buffer !== input.data.buffer) prepared.data.fill(0)
    preparing = false
  }
}
