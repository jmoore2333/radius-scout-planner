import exifr from 'exifr'

export interface ExtractedMediaMetadata {
  widthPx: number | null
  heightPx: number | null
  capturedAt: string | null
  capturedLat: number | null
  capturedLng: number | null
  deviceMake: string | null
  deviceModel: string | null
  lensModel: string | null
}

export async function extractMediaMetadata(file: File, bytes: ArrayBuffer): Promise<ExtractedMediaMetadata | null> {
  if (!file.type.startsWith('image/')) {
    return null
  }

  const parsed = await exifr.parse(bytes, {
    tiff: true,
    ifd0: {},
    exif: true,
    gps: true,
    ihdr: true,
  }).catch(() => null)

  const dimensions = extractImageDimensions(bytes, file.type)
  const metadata = normalizeExtractedMediaMetadata({
    widthPx: dimensions?.width ?? readNumber(parsed?.['ExifImageWidth']) ?? readNumber(parsed?.['ImageWidth']),
    heightPx: dimensions?.height ?? readNumber(parsed?.['ExifImageHeight']) ?? readNumber(parsed?.['ImageHeight']),
    capturedAt: toIsoString(parsed?.['DateTimeOriginal'] ?? parsed?.['CreateDate'] ?? parsed?.['ModifyDate']),
    capturedLat: readNumber(parsed?.['latitude']) ?? readNumber(parsed?.['GPSLatitude']),
    capturedLng: readNumber(parsed?.['longitude']) ?? readNumber(parsed?.['GPSLongitude']),
    deviceMake: readString(parsed?.['Make']),
    deviceModel: readString(parsed?.['Model']),
    lensModel: readString(parsed?.['LensModel']),
  })

  return hasMetadata(metadata) ? metadata : null
}

export function normalizeExtractedMediaMetadata(
  partial: Partial<ExtractedMediaMetadata>,
): ExtractedMediaMetadata {
  return {
    widthPx: coerceInteger(partial.widthPx),
    heightPx: coerceInteger(partial.heightPx),
    capturedAt: partial.capturedAt ?? null,
    capturedLat: coerceCoordinate(partial.capturedLat),
    capturedLng: coerceCoordinate(partial.capturedLng),
    deviceMake: cleanString(partial.deviceMake),
    deviceModel: cleanString(partial.deviceModel),
    lensModel: cleanString(partial.lensModel),
  }
}

export function extractImageDimensions(
  bytes: ArrayBuffer,
  mimeType: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes)

  if (mimeType === 'image/png' && view.byteLength >= 24) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
    }
  }

  if ((mimeType === 'image/jpeg' || mimeType === 'image/jpg') && view.byteLength >= 4) {
    let offset = 2

    while (offset + 9 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1
        continue
      }

      const marker = view.getUint8(offset + 1)
      const blockLength = view.getUint16(offset + 2)

      if (blockLength < 2) {
        break
      }

      if (isStartOfFrameMarker(marker) && offset + 8 < view.byteLength) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        }
      }

      offset += 2 + blockLength
    }
  }

  return null
}

function isStartOfFrameMarker(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function hasMetadata(metadata: ExtractedMediaMetadata) {
  return Object.values(metadata).some(value => value !== null)
}

function coerceInteger(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Math.round(value)
}

function coerceCoordinate(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Number(value.toFixed(6))
}

function cleanString(value: string | null | undefined) {
  if (!value?.trim()) {
    return null
  }

  return value.trim()
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function toIsoString(value: unknown) {
  if (!value) {
    return null
  }

  const parsed = value instanceof Date ? value : new Date(String(value))

  if (Number.isNaN(parsed.valueOf())) {
    return null
  }

  return parsed.toISOString()
}
