# The game client and the visual builders come before the two-week soak; Phaser 4 renders it

At the Guild Master's direction (2026-10-20), the pixel game client and the drag-and-drop builders are built before the two-week Core Loop soak. This supersedes the ordering in ADR-0003. The plain ledger was unusable for designing a guild by hand-editing config, and the soak starts only once the UI is polished. The governed core and the event stream are unchanged; the game renders that stream and decides nothing.

The game client uses **Phaser 4**, not the SPEC's PixiJS v8. Phaser runs under Guildhall's strict CSP with nothing to configure, loads Tiled maps natively and has a one-flag pixel-art mode. PixiJS needs an eval polyfill and a separate tilemap add-on. Its bundle, about 350 KB gzipped, is lazy-loaded on the game route only. Unreal has no browser export, and Unity or Godot web builds cost megabytes and need `wasm-unsafe-eval`, so they are out.

Art starts with Kenney CC0 placeholders. Custom Members and tilesets come later from the PixelLab MCP, whose output we own, cleaned up in Aseprite and laid out in Tiled. The org and workflow builders use React Flow v12 (@xyflow/react), as SPEC section 27.7 planned.
