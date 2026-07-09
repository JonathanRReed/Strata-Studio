# Strata Studio — Agent Notes

Project layout: the Vite + React app lives inside `web/`. The repo root keeps `Design-idea.md` and build artifacts.

## Commands

The `--cwd` flag belongs **after** the `bun` subcommand, not before it:

```bash
bun install --cwd web
bun run --cwd web dev
bun run --cwd web build
bun run --cwd web test
bun run --cwd web lint
bun run --cwd web typecheck
bun run --cwd web format
```

`bun --cwd web <cmd>` is not valid for these commands.

## Verification

Run the full check before finishing work:

```bash
bun run --cwd web lint && bun run --cwd web typecheck && bun run --cwd web test
```

## Deployment

`bun run --cwd web build` produces `web/dist/`. This is a static site and can be deployed to Cloudflare Pages.

## Data sources

- Map tiles: OpenStreetMap (raster) via MapLibre
- Terrain tiles: Mapzen Terrain Tiles on AWS S3 (`s3://elevation-tiles-prod/terrarium`)
