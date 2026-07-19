---
name: verify
description: Drive the built Strata Studio launch flow and observe proxy-first behavior.
---

# Verify Strata Studio at runtime

1. Build the deterministic production fixture with `bun run build:fixture`.
2. Start `bun run preview:test`; wait for `http://127.0.0.1:4173/build-info.json`.
3. Launch Playwright Chromium at 1440×1000. Fulfill OpenFreeMap's `/styles/dark` with a minimal style, proxy `/terrain/*` with `tests/launch/terrain-fixture.png`, proxy `/overpass` with `{ "elements": [] }`, and Nominatim reverse with a locality. Abort every other HTTPS request.
4. Observe `build-info.json`: `dataPolicy` must be `proxy-first`, and app/terrain/Overpass URLs must match the fixture origins.
5. Drive the UI by role: wait for Generate, expand the map, choose Manhattan, collapse, select Experimental Lab, open Composition, enter a label, generate, open Export, choose 1024 with keyboard focus + Space, and observe a PNG download.
6. Record proxy terrain/Overpass requests and confirm no request reached AWS terrain or public Overpass hosts. Capture the export dialog and rendered artwork in a screenshot.

Gotchas:

- Use the root `preview:test` script so the verification port and fixture origins stay consistent with Playwright.
- Styled export radios are visually hidden. Keyboard focus + Space is reliable across Chromium, Firefox, and WebKit; forced pointer checks are not.
- Keep `tests/launch/terrain-fixture.png` as a valid 256×256 PNG; malformed tiny PNGs make every terrain tile fail during `createImageBitmap`.
