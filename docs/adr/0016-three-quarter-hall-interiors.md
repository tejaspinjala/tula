# The world is oblique three-quarter pixel art in Phaser 4, with a room model and a client-only Guild Map

Milestone 8 turns the Hall from one flat overview into rooms you walk through. The question is how "more 3D" is reached.

**Phaser 4 stays; no 3D engine.** "More 3D" means oblique three-quarter pixel art: the floor seen from above, the front faces of walls and furniture, drawn in 2D. Height comes from y-sort depth ordering, a separate top layer on furniture, three-tile back walls and hard-edged pixel shadows. We rejected a 3D engine or isometric projection: it would replace the renderer, the tile pipeline and the asset contract for a look the 2D oblique view already gives.

**The room model.** The Guildhall is a set of rooms. The **Great Hall** is the entrance (Steward's desk, Seal desk, Quest Board, Mailbox, Gate); every Hall is its own room behind a doorway, furnished by a room style chosen from the Hall's kind and name unless the Guild Master picks one. A room grows a larger template when a Hall gains Members. The town maps (plaza, Archive, Counting House, trail) use the same view and the same doorway transitions. A doorway steps to black and back, and cuts instantly under reduced motion. The last room is remembered per viewer; a saved id that was renamed (the Treasury map `vault`, now `counting-house`) is mapped once on read.

**The Guild Map reads only client scene state.** The mini map and the full Guild Map are drawn from the scene the client already derives (Members, Seals waiting, unread Missives, Halls, doorways). They add no endpoint and no server state, so they cannot show anything the Guild Master could not already see.

**Asset contract.** 16 px tiles, three-tile back walls, whole-tile furniture footprints with a top layer, 16x24 characters with a 16x8 shadow, one locked palette shared with the UI tokens (day and night), packed PNG atlases with a JSON frame map, and a CREDITS.md line per file. The contract is written in the pixel-ui skill reference.

**Pokémon DS is a reference for feel only.** Nothing is copied: no sprite, frame, font, sound, layout or name. Every asset is original or properly licensed and recorded in CREDITS.md.

**Renames that ride with it.** The Bag page "Guild chat" is **Missives**; the Treasury map `vault` is the **Counting House**; the Hall object `coins` is the **Treasury chest**. Glossary: Great Hall, Guild Map, Mailbox, HUD, Bag.
