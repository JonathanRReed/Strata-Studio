# Portable export reliability

APNG compression runs in an on-demand module worker instead of blocking the UI.
Cancel, worker failure, timeout, and success all terminate the worker. Frames are
transferred rather than copied where safe; duplicated or sliced backing buffers
are copied before transfer. The existing 128 MiB frame budget remains enforced.

UPNG 2.1.0 allocated its output container from raw pixel size plus 100 bytes. That
is insufficient for small or incompressible multi-frame PNGs because chunk headers
and compressed payloads can exceed that estimate. The checked-in Bun patch sizes
the container from actual compressed chunks and metadata. Tests independently
check every PNG chunk boundary/CRC and decode RGBA pixels and frame timing.

Poster SVGs embed the application's licensed Archivo variable and IBM Plex Mono
WOFF2 faces, including the font licenses in metadata. Font loading is bounded,
shared between simultaneous exports, and abortable per caller. SVG viewers must
support embedded CSS webfonts; editors without that support can still substitute
fonts. This is not a claim of arbitrary-script glyph coverage or text-to-paths.
Plain-label SVGs retain their existing generic sans-serif behavior.

Browser regressions exercise real APNG downloads, preview-speed timing, cancellation
once the stalled encoder worker has been requested, and font loading in a fresh
standalone SVG document rather than inheriting the application's font state.
