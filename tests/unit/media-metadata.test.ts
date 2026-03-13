import { describe, expect, it } from 'vitest'
import { extractImageDimensions, normalizeExtractedMediaMetadata } from '../../edge/lib/media-metadata'

describe('media metadata helpers', () => {
  it('extracts png dimensions from the IHDR header', () => {
    const bytes = new Uint8Array(24)
    const view = new DataView(bytes.buffer)

    view.setUint32(16, 1920)
    view.setUint32(20, 1080)

    expect(extractImageDimensions(bytes.buffer, 'image/png')).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it('extracts jpeg dimensions from a start-of-frame segment', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10,
      0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00,
      0x03, 0x11, 0x00,
    ])

    expect(extractImageDimensions(bytes.buffer, 'image/jpeg')).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it('normalizes extracted metadata into a stable shape', () => {
    expect(
      normalizeExtractedMediaMetadata({
        widthPx: 3024.4,
        heightPx: 4032.2,
        capturedAt: '2026-03-08T18:00:00.000Z',
        capturedLat: 40.1234567,
        capturedLng: -76.4567891,
        deviceMake: '  Apple ',
        deviceModel: ' iPhone 15 Pro ',
        lensModel: '',
      }),
    ).toEqual({
      widthPx: 3024,
      heightPx: 4032,
      capturedAt: '2026-03-08T18:00:00.000Z',
      capturedLat: 40.123457,
      capturedLng: -76.456789,
      deviceMake: 'Apple',
      deviceModel: 'iPhone 15 Pro',
      lensModel: null,
    })
  })
})
