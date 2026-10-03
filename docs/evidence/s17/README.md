# S17 visual evidence

Synthetic-fixture screenshots of the spoken-conversation state machine at
desktop (1280×1000) and mobile (390×844) widths. No account, tutor or
provider data appears in these images: the transcript, history, citations and
every stage come from the DEV-only fixtures in `packages/app/src/preview.tsx`
(`#/preview/conversation-*`), and the audio bytes are a four-byte synthetic
blob — nothing here calls a provider.

| File | Viewport | State shown |
| --- | --- | --- |
| `conversation-ready-desktop.png` | 1280×1000 | Resting: all five stages visible, `Ready — reached`, history with one stored turn, "Record a turn" |
| `conversation-listening-desktop.png` | 1280×1000 | `Listening — in progress`, recording clock `00:02 of 01:00`, Stop and transcribe / Cancel turn |
| `conversation-transcribing-desktop.png` | 1280×1000 | `Transcribing — in progress` with the stage status line and the S15 Cancel |
| `conversation-generating-desktop.png` | 1280×1000 | `Retrieving & generating — in progress`, editable transcript, `Cancel turn` / `New turn` |
| `conversation-speaking-desktop.png` | 1280×1000 | `Speaking — in progress`, answer transcript in the player, `Stop speaking` / `New turn` |
| `conversation-error-desktop.png` | 1280×1000 | Failed stage visible (`Retrieving & generating — failed`) with the typed alert and `Retry` / `Discard response` |
| `conversation-*-mobile.png` | 390×844 | The same six states at mobile width (stage tiles stack vertically) |

The cancelled/aborted capture states, the retry-after-reconnect path and the
"old results rejected" races are asserted in code instead, where they are
observable: `packages/app/tests/spoken-conversation.test.tsx`,
`conversation-controller.test.ts` and `conversation-state.test.ts`.

## Layout check

A headless-Chrome pass over the same twelve routes reports
`documentElement.scrollWidth == clientWidth` at both viewports for every
state (no horizontal overflow), and the stage tiles wrap their labels and
state words inside the tile at 1280 px.

## Reproduce locally

```sh
pnpm --filter @learn-anything/app exec vite --port 5216 --strictPort &
npx playwright screenshot --channel=chrome --viewport-size="1280,1000" \
  --wait-for-timeout=2500 "http://localhost:5216/#/preview/conversation-generating" conversation-generating-desktop.png
npx playwright screenshot --channel=chrome --viewport-size="390,844" \
  --wait-for-timeout=2500 "http://localhost:5216/#/preview/conversation-listening" conversation-listening-mobile.png
```

`--channel=chrome` reuses the installed Google Chrome; plain
`chrome --headless --screenshot` cannot be used because Chrome clamps
headless window widths to 500 px on macOS, which would crop a 390 px layout.
The `#/preview/conversation-*` routes exist only in `vite dev` builds
(`import.meta.env.DEV`); `vite build` drops them, so neither the fixtures nor
the mocked playback environment ship (verified: `dist/` contains no
`preview-` string).
