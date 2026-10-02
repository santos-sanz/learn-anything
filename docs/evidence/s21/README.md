# S21 visual evidence

Synthetic-fixture screenshots of the project dashboard, onboarding and project
detail screens at desktop (1280 px) and mobile (390 px) widths. No account,
project or provider data appears in these images; the projects are the DEV-only
fixtures from `packages/app/src/preview.tsx`.

| File | Viewport | Route |
| --- | --- | --- |
| `dashboard-desktop.png` | 1280×900 | `#/preview/dashboard` → `#/projects` |
| `dashboard-mobile.png` | 390×844 | `#/preview/dashboard` → `#/projects` |
| `onboarding-desktop.png` | 1280×1000 | `#/preview/onboarding` → `#/projects/new` |
| `onboarding-mobile.png` | 390×844 | `#/preview/onboarding` → `#/projects/new` |
| `project-detail-desktop.png` | 1280×1100 | `#/preview/detail` → `#/projects/:id` |
| `project-detail-mobile.png` | 390×844 | `#/preview/detail` → `#/projects/:id` |

## Reproduce locally

```sh
pnpm --filter @learn-anything/app dev --port 5199 &
pnpm dlx playwright@1.56.1 screenshot --channel=chrome --viewport-size="390,844" \
  --wait-for-timeout=5000 "http://localhost:5199/#/preview/dashboard" dashboard-mobile.png
```

`--channel=chrome` reuses the installed Google Chrome; plain
`chrome --headless --screenshot` cannot be used because Chrome clamps
headless window widths to 500 px on macOS, which crops a 390 px layout.
The `#/preview/*` routes exist only in `vite dev` builds (`import.meta.env.DEV`);
`vite build` drops them, so neither the fixtures nor the mock backend ship.
