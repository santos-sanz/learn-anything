/**
 * S24 audio duration policy (server half of the recording budget). The
 * browser already stops recording at `MAX_RECORDING_SECONDS` (S15), but the
 * server never trusts a client: this module reads the duration the container
 * itself declares — MP4 `mvhd` and Matroska/WebM Segment `Info > Duration` —
 * so an over-long upload is refused with `413 AUDIO_TOO_LONG` before any
 * provider request. Containers that do not declare a duration (OGG, and
 * WebM streams recorded live without a Segment Duration) fall back to the
 * documented byte cap: `null` means "unknown", never "unbounded", because
 * the 8 MiB request cap still applies. Every parse is bounds-checked and
 * returns `null` on anything it does not fully understand — a malformed
 * header can never crash a route or smuggle a value through.
 */

export const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 60;
export const MIN_MAX_AUDIO_DURATION_SECONDS = 5;
export const MAX_MAX_AUDIO_DURATION_SECONDS = 600;

/** Bounded, validated deployment configuration; malformed values fall back. */
export function maxAudioDurationSeconds(): number {
  const raw = Number(process.env.MAX_AUDIO_DURATION_SECONDS);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_AUDIO_DURATION_SECONDS;
  return Math.min(Math.max(Math.trunc(raw), MIN_MAX_AUDIO_DURATION_SECONDS), MAX_MAX_AUDIO_DURATION_SECONDS);
}

export function maxAudioDurationMs(): number {
  return maxAudioDurationSeconds() * 1000;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[offset + index]);
  return out;
}

/** ISO-BMFF `mvhd` payload → duration in milliseconds, or null when unusable. */
function mvhdDurationMs(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = payload[0];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (payload.length < 32) return null;
    timescale = view.getUint32(20, false);
    const high = view.getUint32(24, false);
    const low = view.getUint32(28, false);
    duration = high * 2 ** 32 + low;
  } else {
    if (payload.length < 20) return null;
    timescale = view.getUint32(12, false);
    duration = view.getUint32(16, false);
  }
  if (timescale <= 0) return null;
  return (duration / timescale) * 1000;
}

/** Scans MP4 top-level boxes for `moov/mvhd`; a safe parse or null. */
export function parseMp4DurationMs(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return null;
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      size = high * 2 ** 32 + low;
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < header || offset + size > bytes.length) return null;
    if (type === "moov") {
      const moov = bytes.subarray(offset + header, offset + size);
      const inner = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
      let innerOffset = 0;
      while (innerOffset + 8 <= moov.length) {
        const innerSize = inner.getUint32(innerOffset, false);
        const innerType = ascii(moov, innerOffset + 4, 4);
        if (innerSize < 8 || innerOffset + innerSize > moov.length) break;
        if (innerType === "mvhd") {
          return mvhdDurationMs(moov.subarray(innerOffset + 8, innerOffset + innerSize));
        }
        innerOffset += innerSize;
      }
      return null;
    }
    offset += size;
  }
  return null;
}

type EbmlValue = { id: number; contentOffset: number; contentSize: number; nextOffset: number };

/** Reads one EBML element header (ID vint + size vint) or null when malformed. */
function readEbmlElement(bytes: Uint8Array, offset: number): EbmlValue | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let idLength = 1;
  let mask = 0x80;
  while (idLength <= 4 && (first & mask) === 0) {
    mask >>= 1;
    idLength += 1;
  }
  if (idLength > 4 || offset + idLength >= bytes.length) return null;
  let id = 0;
  for (let index = 0; index < idLength; index += 1) id = id * 256 + bytes[offset + index];

  const sizeStart = offset + idLength;
  const sizeFirst = bytes[sizeStart];
  if (sizeFirst === 0) return null;
  let sizeLength = 1;
  let sizeMask = 0x80;
  while (sizeLength <= 8 && (sizeFirst & sizeMask) === 0) {
    sizeMask >>= 1;
    sizeLength += 1;
  }
  if (sizeLength > 8 || sizeStart + sizeLength > bytes.length) return null;
  let size = sizeFirst & (0xff >> sizeLength);
  let unknownSize = true;
  for (let index = 1; index < sizeLength; index += 1) {
    const byte = bytes[sizeStart + index];
    if (byte !== 0xff) unknownSize = false;
    size = size * 256 + byte;
  }
  if (sizeLength === 1 && (sizeFirst & 0x80) !== 0) unknownSize = false;
  const contentOffset = sizeStart + sizeLength;
  return { id, contentOffset, contentSize: unknownSize ? bytes.length - contentOffset : size, nextOffset: unknownSize ? bytes.length : contentOffset + size };
}

function readEbmlUint(bytes: Uint8Array, offset: number, length: number): number | null {
  if (length < 1 || length > 8 || offset + length > bytes.length) return null;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return value;
}

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

/**
 * Reads Segment > Info > TimecodeScale/Duration from a WebM/Matroska header.
 * Duration is expressed in TimecodeScale units (default 1 ms), so the result
 * is `duration * timecodeScale / 1e6` milliseconds. Unknown sizes, trailing
 * live-stream data and anything unexpected resolve to null instead of a guess.
 */
export function parseWebmDurationMs(bytes: Uint8Array): number | null {
  let offset = 0;
  const header = readEbmlElement(bytes, offset);
  if (header === null || header.id !== EBML_HEADER) return null;
  offset = header.nextOffset;
  const segment = readEbmlElement(bytes, offset);
  if (segment === null || segment.id !== SEGMENT) return null;

  let timecodeScale = 1_000_000;
  let durationUnits: number | null = null;
  let cursor = segment.contentOffset;
  const segmentEnd = segment.contentSize === bytes.length - segment.contentOffset ? bytes.length : segment.contentOffset + segment.contentSize;
  while (cursor < segmentEnd && cursor < bytes.length && durationUnits === null) {
    const element = readEbmlElement(bytes, cursor);
    if (element === null || element.nextOffset <= cursor) break;
    if (element.id === INFO) {
      let infoCursor = element.contentOffset;
      const infoEnd = element.contentOffset + element.contentSize;
      while (infoCursor < infoEnd && infoCursor < bytes.length && durationUnits === null) {
        const child = readEbmlElement(bytes, infoCursor);
        if (child === null || child.nextOffset <= infoCursor) break;
        if (child.id === TIMECODE_SCALE) {
          const value = readEbmlUint(bytes, child.contentOffset, child.contentSize);
          if (value !== null && value > 0) timecodeScale = value;
        } else if (child.id === DURATION) {
          if (child.contentSize === 4 || child.contentSize === 8) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            durationUnits = child.contentSize === 4 ? view.getFloat32(child.contentOffset, false) : view.getFloat64(child.contentOffset, false);
          }
        }
        infoCursor = child.nextOffset;
      }
    } else if (element.id === TIMECODE_SCALE) {
      const value = readEbmlUint(bytes, element.contentOffset, element.contentSize);
      if (value !== null && value > 0) timecodeScale = value;
    } else if (element.id === DURATION && (element.contentSize === 4 || element.contentSize === 8)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      durationUnits = element.contentSize === 4 ? view.getFloat32(element.contentOffset, false) : view.getFloat64(element.contentOffset, false);
    }
    cursor = element.nextOffset;
  }
  if (durationUnits === null || !Number.isFinite(durationUnits) || durationUnits < 0) return null;
  return (durationUnits * timecodeScale) / 1_000_000;
}

/**
 * Container duration for the three supported compressed types, or null when
 * the container does not declare one (OGG by design; WebM recorded live).
 */
export function parseAudioDurationMs(bytes: Uint8Array, contentType: string): number | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "audio/mp4") return parseMp4DurationMs(bytes);
  if (type === "audio/webm") return parseWebmDurationMs(bytes);
  return null;
}
