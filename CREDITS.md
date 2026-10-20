# Credits

Every third-party asset Guildhall ships, with its licence. Our own art is listed too, so nothing is unaccounted for.

## Fonts (SIL Open Font License 1.1, self-hosted through `@fontsource`)

| Font | Author | Licence | URL |
| --- | --- | --- | --- |
| Pixelify Sans | Stefie Justprince | OFL 1.1 | https://fonts.google.com/specimen/Pixelify+Sans |
| Jersey 10 | Sorkin Type | OFL 1.1 | https://fonts.google.com/specimen/Jersey+10 |
| Silkscreen | Jason Kottke | OFL 1.1 | https://fonts.google.com/specimen/Silkscreen |
| VT323 | Peter Hull | OFL 1.1 | https://fonts.google.com/specimen/VT323 |

The packages are `@fontsource/pixelify-sans`, `@fontsource/jersey-10`, `@fontsource/silkscreen` and `@fontsource/vt323`; each ships its licence file in `node_modules/@fontsource/<name>/LICENSE`.

## Art

| Asset | Author | Licence | Notes |
| --- | --- | --- | --- |
| `apps/web/src/assets/pixel/*.png` (wood frame, Member walking sheet, icon and pattern masks) | Guildhall | Same licence as this repository | Drawn by `scripts/gen-pixel-art.ts` from the token palette in `apps/web/src/styles/tokens.css`. |
| `apps/web/public/game/tiles.png` (hall, plaza, Archive, vault and trail tiles) | Kenney | CC0 1.0 | Roguelike/RPG pack, https://kenney.nl/assets/roguelike-rpg-pack. The page lists "Creative Commons CC0" (checked 2026-10-20). |
| `apps/web/public/game/chars.png` (Member and Guild Master characters) | Kenney | CC0 1.0 | Roguelike Characters, https://kenney.nl/assets/roguelike-characters. The page lists "Creative Commons CC0" (checked 2026-10-20). The walk cycle is four poses made in code, not drawn frames. |
| `apps/web/public/game/font.png`, `font.fnt` (bitmap font) | Kenney | CC0 1.0 | Rasterised from Kenney Fonts, https://kenney.nl/assets/kenney-fonts. The page lists "Creative Commons CC0" (checked 2026-10-20). |
| `apps/web/src/game/*.tiled.json` | Guildhall | Same licence as this repository | The hall is hand-written Tiled JSON; plaza, archive, vault and trail are written by `scripts/gen-town-maps.ts`. |

Nothing from Nintendo, Game Freak, Creatures, The Pokémon Company or ConcernedApe is used.
