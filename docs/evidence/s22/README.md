# S22 visual evidence

Synthetic-fixture screenshots of the document management screen and the
citation source viewer at desktop and mobile widths. No account, project,
document or provider data appears in these images; every row and passage is
the DEV-only fixture from `packages/app/src/preview.tsx`.

| File | Viewport | Route | Shows |
| --- | --- | --- | --- |
| `documents-desktop.png` | 1280×1400 | `#/preview/documents` → `#/projects/:id/documents` | Upload form plus all five real job states: ready, processing, retrying with backoff, unsupported and dead-lettered (with retry) |
| `documents-mobile.png` | 390×844 (full page) | `#/preview/documents` → `#/projects/:id/documents` | The same list stacked at phone width |
| `source-desktop.png` | 1280×1100 | `#/preview/source` → `#/projects/:id/sources/:doc/:chunk?hash=` | A citation opened at its page with the cited badge, focus passage and bounded neighbours |
| `source-mobile.png` | 390×844 | `#/preview/source` → the same route | The viewer at phone width |
| `unavailable-desktop.png` | 1280×900 | `#/preview/unavailable` → the same route | The explicit unavailable state for a deleted source (never a broken link or empty panel) |
| `unavailable-mobile.png` | 390×844 | `#/preview/unavailable` → the same route | The unavailable state at phone width |
| `citations-desktop.png` | 1280×900 (full page) | `#/preview/citations` → `#/preview/source` | Clickable citations (`CitationLink`) with the source they open above |
| `citations-mobile.png` | 390×844 (full page) | `#/preview/citations` → `#/preview/source` | The same citation list at phone width |

## Reproduce locally

```sh
# Port 5199 may already be taken by another worktree; pick a free port.
pnpm --filter @learn-anything/app exec vite --port 5210 --strictPort &
pnpm dlx playwright@1.56.1 screenshot --channel=chrome --wait-for-timeout=4000 \
  --viewport-size="1280,1400" "http://localhost:5210/#/preview/documents" documents-desktop.png
pnpm dlx playwright@1.56.1 screenshot --channel=chrome --wait-for-timeout=4000 \
  --full-page --viewport-size="390,844" "http://localhost:5210/#/preview/documents" documents-mobile.png
```

`--channel=chrome` reuses the installed Google Chrome; plain
`chrome --headless --screenshot` cannot be used because Chrome clamps
headless window widths to 500 px on macOS, which crops a 390 px layout.
The `#/preview/*` routes exist only in `vite dev` builds
(`import.meta.env.DEV`); `vite build` drops them, so neither the fixtures nor
the mock backend ship.
