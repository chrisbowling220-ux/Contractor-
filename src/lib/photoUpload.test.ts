import { describe, expect, it } from 'vitest'
import { contentTypeFor, fitWithin, safeFileName } from './photoUpload'

describe('photo upload helpers', () => {
  it('always produces an image content type (storage rules reject anything else)', () => {
    expect(contentTypeFor({ type: 'image/png', name: 'a.png' })).toBe('image/png')
    expect(contentTypeFor({ type: '', name: 'IMG_0042.HEIC' })).toBe('image/heic')
    expect(contentTypeFor({ type: '', name: 'photo' })).toBe('image/jpeg')
    expect(contentTypeFor({ type: 'application/octet-stream', name: 'x.JPG' })).toBe('image/jpeg')
  })
  it('scales the long edge to 2000px and keeps the shape', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2000, height: 1500 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1500, height: 2000 })
    expect(fitWithin(1600, 1200)).toEqual({ width: 1600, height: 1200 })
  })
  it('cleans file names for storage paths', () => {
    expect(safeFileName('my photo (1).jpg', 'x.jpg')).toBe('my_photo__1_.jpg')
    expect(safeFileName('', 'photo-1.jpg')).toBe('photo-1.jpg')
  })
})
