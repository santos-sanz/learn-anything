#!/usr/bin/env node
/* global process, console, setTimeout, window, document, navigator, MediaRecorder, Blob, Audio, URL */
/**
 * S26 browser/device probe: observes REAL browser microphone-grant,
 * microphone-denial and <audio> playback behaviour with synthetic media only.
 *
 * It never touches a provider, never sends audio anywhere and never reads a
 * secret: `--use-fake-device-for-media-stream` makes Chrome generate its own
 * test tone, and the playback probe synthesises a silent WAV locally.
 *
 * Each observation runs in its own browser launch and degrades to a recorded
 * failure instead of hanging, so the JSON output is always produced.
 *
 * Run it from a directory that has the `playwright` package installed
 * (system Google Chrome is reused via `channel: "chrome"`; no browser
 * download is needed):
 *
 *   mkdir -p /tmp/s26-probe && cd /tmp/s26-probe
 *   npm init -y && npm i playwright@1.63.0
 *   node browser-probe.mjs http://localhost:5216
 *
 * The dev server must already be running (`pnpm --filter @learn-anything/app
 * exec vite --port 5216 --strictPort`). Output is a JSON report on stdout.
 */

import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5216";
const report = { url, chrome: null, deny: null, playback: null, grant: null };

/** One-shot observation: launch, run, close — a crash becomes data, not a hang. */
async function observe(name, launchOptions, body, permissions = ["microphone"]) {
  let browser = null;
  try {
    browser = await chromium.launch(launchOptions);
    if (report.chrome === null) report.chrome = browser.version();
    const context = await browser.newContext({ permissions });
    const page = await context.newPage();
    await page.goto(url, { timeout: 15_000 });
    const settled = body(page).catch((error) => ({ error: String(error?.message ?? error).slice(0, 300) }));
    return await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve({ error: `timeout: ${name} did not settle in 15s` }), 15_000)),
    ]);
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300) };
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
  }
}

/* ---- 1. getUserMedia with the microphone permission withheld ----------- */
report.deny = await observe(
  "getUserMedia denial",
  { channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream"] },
  async (page) =>
    page.evaluate(async () => {
      const attempt = navigator.mediaDevices.getUserMedia({ audio: true });
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000));
      const outcome = await Promise.race([
        attempt.then(
          (stream) => {
            for (const track of stream.getTracks()) track.stop();
            return { granted: true };
          },
          (error) => ({ granted: false, name: error?.name ?? String(error) }),
        ),
        timeout,
      ]);
      return outcome;
    }),
  [], // microphone permission is deliberately NOT granted here
);

/* ---- 2. <audio> playback of a locally synthesised WAV ------------------ */
report.playback = await observe("audio playback", { channel: "chrome", headless: true }, async (page) => {
  const loaded = await page.evaluate(async () => {
    // 0.25 s of 8 kHz mono 16-bit silence, standard RIFF/WAVE header.
    const sampleRate = 8000;
    const samples = sampleRate / 4;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => {
      for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, samples * 2, true);

    const blob = new Blob([buffer], { type: "audio/wav" });
    const audio = new Audio(URL.createObjectURL(blob));
    window.__s26Audio = audio;
    window.__s26Playback = "idle";
    const button = document.createElement("button");
    button.id = "s26-play";
    button.textContent = "Play probe audio";
    button.addEventListener("click", () => {
      audio
        .play()
        .then(() => {
          window.__s26Playback = "playing";
        })
        .catch((error) => {
          window.__s26Playback = `error:${error?.name ?? error}`;
        });
    });
    document.body.appendChild(button);
    return { objectUrl: audio.src.startsWith("blob:") };
  });
  // A trusted (Playwright) click provides the user gesture Chrome requires.
  await page.click("#s26-play");
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => ({
    state: window.__s26Playback,
    currentTime: window.__s26Audio.currentTime,
    paused: window.__s26Audio.paused,
    duration: window.__s26Audio.duration,
  }));
  return { ...loaded, ...state };
});

/* ---- 3. getUserMedia with the fake device granted ---------------------- */
report.grant = await observe(
  "getUserMedia grant",
  {
    channel: "chrome",
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  async (page) =>
    page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        const settings = track.getSettings();
        let recorder = { attempted: false, bytes: 0, mimeType: null };
        if (typeof MediaRecorder === "function") {
          const chunks = [];
          const rec = new MediaRecorder(stream);
          rec.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          rec.start();
          await new Promise((resolve) => setTimeout(resolve, 500));
          await new Promise((resolve) => {
            rec.onstop = resolve;
            rec.stop();
          });
          recorder = { attempted: true, bytes: chunks.reduce((total, chunk) => total + chunk.size, 0), mimeType: rec.mimeType };
          track.stop();
        }
        return {
          granted: true,
          trackReadyState: track.readyState,
          hasDeviceId: typeof settings.deviceId === "string" && settings.deviceId.length > 0,
          recorder,
        };
      } catch (error) {
        return { granted: false, name: error?.name ?? String(error), message: error?.message ?? "" };
      }
    }),
);

console.log(JSON.stringify(report, null, 2));
