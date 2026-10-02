/** Small runtime-neutral encodings used by the agent bridge (no Node-only APIs). */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(value));
}

export function utf8String(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let result = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    result += BASE64URL_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 6) & 63];
  }
  return result;
}

export function base64UrlDecode(value: string): Uint8Array {
  const clean = value.replace(/=+$/, "");
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const char of clean) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid base64url character");
    bitBuffer = (bitBuffer << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >> bitCount) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
