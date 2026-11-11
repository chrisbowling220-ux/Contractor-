// Gets a photo ready to upload from a phone on a job site.
//
// Phone cameras produce 4-12 MB files. On a weak cell signal that is a long,
// failure-prone upload for a picture that will be viewed at screen size. Large
// photos are scaled down to 2000px on the long edge and re-saved as JPEG
// (typically 300-700 KB) before upload. If anything about that fails (an
// image format the browser can't decode, such as HEIC on some Android
// browsers), the original file is uploaded untouched.
//
// It also settles the content type: some devices hand over a file with an
// empty type, and the storage rules only accept image/* uploads.

const MAX_EDGE = 2000
const JPEG_QUALITY = 0.85
const SKIP_BELOW_BYTES = 900 * 1024   // already small: not worth re-encoding

export interface PreparedPhoto { blob: Blob; contentType: string; name: string }

export function contentTypeFor(file: { type?: string; name?: string }): string {
  if (file.type && file.type.startsWith('image/')) return file.type
  const ext = (file.name || '').toLowerCase().split('.').pop() || ''
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  }
  return byExt[ext] || 'image/jpeg'
}

// Target size for a wide × high image so its long edge is at most maxEdge.
export function fitWithin(width: number, height: number, maxEdge: number = MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height)
  if (!(long > maxEdge)) return { width, height }
  const k = maxEdge / long
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

export function safeFileName(name: string, fallback: string): string {
  return (name || '').replace(/[^A-Za-z0-9._-]/g, '_') || fallback
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const original: PreparedPhoto = { blob: file, contentType: contentTypeFor(file), name: file.name }
  if (file.size < SKIP_BELOW_BYTES || original.contentType === 'image/gif' || original.contentType === 'image/svg+xml') return original
  try {
    // createImageBitmap honours the EXIF rotation phones write.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return original
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    // Keep whichever is smaller.
    if (!blob || blob.size >= file.size) return original
    return { blob, contentType: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg' }
  } catch {
    return original
  }
}
