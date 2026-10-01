# 山门长明 · 山居绘卷视觉方向

## 2026-10-01 refinement

The scene is a warm, readable cultivation village, seen from a restrained top-down three-quarter camera. Jade roof tiles, cedar beams, pale plaster, old brass, warm paper and moss are the shared material language. Distant misty peaks frame a bright courtyard. Character bodies are deliberately chibi, with detailed portrait illustrations in the interface.

### Native 96px redraw (2026-10-01 09:32 UTC)

The four approved portrait illustrations remain unchanged. Scene sprites were re-authored from integer-coordinate shapes at native96×96, rather than enlarging the previous48×64 artwork or centering a small figure on an empty96px canvas. Every runtime frame has binary transparent/opaque alpha; Inkscape export explicitly disables anti-aliasing. The common foot anchor is `(48,91)`.

- Four disciples: native visible heights85–88px, widths53–73px depending on pose/direction
- Two human enemies: native visible heights85–88px, widths57–67px
- Moss boar: visible78–80px tall; guardian87–88px; floating lantern84px
- Nine96×96 seed PNGs and nine576×288 sheets; each sheet has six distinct poses in each of three separately drawn directions (162 directional poses total). Left still mirrors right
- New filenames use the `-96-v2` suffix for both seeds and sheets. World/battle metadata imports the same96px frame contract and version. Old48px files are retained as a historical comparison and are not referenced by the current manifest
- Pixel inspection verified no edge clipping, alpha only0/255, stable grounded foot lines, distinct direction rows, and exact equality of each seed with sheet frame0

The redraw adds iris highlights and eyelids, individual hair locks, cross-collar layering, skirt folds, stitched hems, belt ornaments, bamboo book bindings, jade jewelry, a wrapped scabbard, and a carved staff. Shen Yan has the portrait’s mature jaw/moustache; Elder Lu has white swept hair, age lines, a gentle smile and no beard. Walk cycles now change leg stride, arm counter-swing, skirt/sleeve sweep and secondary accessory movement. These are still walking/idle presentation poses, not new combat attack animation states.

### Assets and authorship

- `public/assets/characters/*-96-v2.png` and `public/assets/enemies/*-96-v2.png`: original authored96×96 pixel characters/enemies. Native SVG source and `assets-source/generate-96-art.py` reproduce the versioned runtime files and static proofs; `assets-source/characters/inspect-96-art.py` reproduces the read-only pixel QA report with the already-installed Pillow. No scraped or external art packs
- Xiaohe: visibly smaller novice, ochre robe, green ribbon and a bamboo book
- Lin Qing: teal robe, long draped sleeves, gold hair ornament and hanging jade tassel
- Shen Yan: broader shoulders, terracotta robe, longer ponytail, visible scabbard and mature brows
- Elder Lu: lowered, slightly stooped silhouette, lavender robe, white hair, age lines and wooden staff; a grandmother, no beard
- `public/assets/environment/`: original144×144 transparent worksite paintings with roof tiles, masonry, lattice windows, lanterns, timber, tools, crates and herb beds. Pine/blossom sprites frame the outside of the playable map
- `public/assets/portraits/disciples-atlas-v1.png`: original four-character portrait atlas generated with OpenAI image generation on2026-10-01. It uses the same identities, ages, costumes and accessories; it is not third-party scraped artwork. CSS selects quadrants of the unmodified2×2 atlas
- SVG-to-PNG conversion uses the already installed Inkscape renderer; no new dependency or package was installed
- All runtime asset URLs use `import.meta.env.BASE_URL`, supporting both the private root preview and repository-subpath hosting

### Rendering contract

The renderer owns appearance only. A disciple's screen anchor is always calculated from its authoritative grid cell. Walking poses advance from simulation ticks only while the real job is travelling. Pause freezes the pose. There is no decorative wandering, speculative route interpolation, extra worker, fake job or synthetic resource change. Phase labels, work progress and storage-delivery state remain sourced from the application projection.

World character frames render at0.86× logical scale (82.56px square before camera/CSS fitting, with roughly73–76px of visible human height). Buildings retain0.86× scale, so higher source resolution does not make people cover whole buildings. The battle renderer multiplies its existing cell-dependent sprite scale by2/3, retaining approximately the previous on-field height; ring, bar and hit-target geometry is unchanged. Both use the exact91/96 foot origin. The desktop camera remains1.1× and small screens1.8×. Zoom controls cover0.85–2.2×; selecting an existing accessible character/building control recentres the camera on that authoritative object. Reset and keyboard access are unchanged.

Ground variation and low shrubs are cosmetic. Only authoritative tiles determine passability. Worksite sprite bases mark their real grid targets. Tall border vegetation does not occupy simulated tiles. Ordinary transit may overlap because the current simulation allows shared transit cells; these sprites do not add collision rules.

### Interface

The playfield keeps the largest share of the screen. The inspector uses warm paper, dark readable ink, prominent illustrated portraits and restrained jade action buttons. The resource bar and roster use lacquered-jade surfaces, brass highlights and consistent portrait identity. Worksite and disciple selection, production controls, pause/speed, language, save/recovery controls and all localized strings retain their existing behavior. Mobile stacks the paper inspector under the map.

### Evidence and remaining work

The current static proofs are `assets-source/characters/contact-sheet-96-v2.png`, `before-after-96-v2.png` (old48px at1.5× versus native96px at1×), and `world-scale-96-v2.png` (actual new sprites beside unchanged building PNGs at runtime logical scale). These embed the shipped PNG bytes and were visually inspected. Historical proofs under `docs/visual-proofs/` predate this redraw. The file/hash manifest and read-only pixel report are `asset-manifest-96-v2.json` and `quality-report-96-v2.json` beside the proofs. The approved portrait atlas SHA-256 remains `d26789c943b79e88bff680c46d52ea9ddbd08d9cd442f65be3f89efe2f2b6c5e`.

Static review and PNG pixel inspection passed; browser animation, real canvas overlap and mobile interaction were not run by the art worker. Parent integration owns type checks, tests, production build, browser review and publishing. No gameplay, projection, simulation clock or event-authority logic was changed in this art revision.

This is a cohesive first art pass, not final commercial artwork. Remaining review includes actual desktop/mobile canvas composition, portrait crops in the rendered UI, animation feel under1×/3×, crowded-label behavior and touch-target interactions. Movement retains discrete simulation-cell anchoring; walk poses improve readability without interpolating or inventing motion.
