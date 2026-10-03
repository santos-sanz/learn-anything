# S16 visual evidence

Synthetic-fixture screenshots of the tutor-response speech player at desktop
(1280×1000) and mobile (390×844) widths. No account, tutor or provider data
appears in these images: the transcript, the running-turn banner and the
playback behaviour come from the DEV-only fixtures in
`packages/app/src/preview.tsx` (`#/preview/player-*`), and the audio bytes are
a four-byte synthetic blob — nothing here calls a provider.

| File | Viewport | Route | State shown |
| --- | --- | --- | --- |
| `player-playing-desktop.png` | 1280×1000 | `#/preview/player-playing` | Autoplay started: full transcript, `Playing.`, Pause/Stop, language picker, running-turn Cancel action |
| `player-blocked-desktop.png` | 1280×1000 | `#/preview/player-blocked` | Browser blocked autoplay: alert copy + `Play audio` user-gesture button, transcript intact |
| `player-failed-desktop.png` | 1280×1000 | `#/preview/player-failed` | Synthesis failure (`429` rate limited): full transcript + `Retry`, never a blank panel |
| `player-playing-mobile.png` | 390×844 | `#/preview/player-playing` | Same playing state at mobile width |
| `player-blocked-mobile.png` | 390×844 | `#/preview/player-blocked` | Same blocked state at mobile width |
| `player-failed-mobile.png` | 390×844 | `#/preview/player-failed` | Same failure state at mobile width |

At 390 px all three states keep `documentElement.scrollWidth == clientWidth`
(no horizontal overflow) and the transcript, status line and controls wrap
legibly (verified with a headless-Chrome pass over the same routes).

## Reproduce locally

```sh
pnpm --filter @learn-anything/app exec vite --port 5216 --strictPort &
npx playwright screenshot --channel=chrome --viewport-size="1280,1000" \
  --wait-for-timeout=3500 "http://localhost:5216/#/preview/player-playing" player-playing-desktop.png
npx playwright screenshot --channel=chrome --viewport-size="390,844" \
  --wait-for-timeout=3500 "http://localhost:5216/#/preview/player-blocked" player-blocked-mobile.png
```

`--channel=chrome` reuses the installed Google Chrome; plain
`chrome --headless --screenshot` cannot be used because Chrome clamps
headless window widths to 500 px on macOS, which would crop a 390 px layout.
The `#/preview/player-*` routes exist only in `vite dev` builds
(`import.meta.env.DEV`); `vite build` drops them, so neither the fixtures nor
the mocked playback environment ship (verified: `dist/` contains no
`preview-` string).

The other player states — play/pause/resume/stop, cancellation dropping late
audio, unsupported voice, anonymous/cross-user denial — are asserted in
`packages/app/tests/response-player.test.tsx` and `packages/api/tests/tts.test.ts`;
they need interaction or typed errors that a static screenshot cannot show.
