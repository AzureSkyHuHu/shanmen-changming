# Editable art sources

Runtime PNGs live in `public/assets/`; editable SVGs, generators and provenance live here so Vite does not publish the development tools or proof sheets.

Current characters and enemies: run `python3 assets-source/generate-96-art.py` from the project root. This creates native96×96 integer-grid SVGs, versioned576×288 PNG sheets (six poses × three directions),96×96 seed PNGs, file hashes and static proof sheets. It uses the installed Inkscape renderer with `--export-png-antialias=0`; runtime alpha is binary and sprite frames are never resampled. Run `python3 assets-source/characters/inspect-96-art.py` for read-only pixel validation and its JSON report.

`generate-pixel-art.py` reproduces the unchanged environments and the historical48×64 character SVGs. `enemies/generate-enemies.py` reproduces historical48×64 enemies. Those unversioned sprites remain solely for before/after comparison and are not loaded by the current art manifest. They must not replace the versioned96px files.

Current native96px static review compositions live in `assets-source/characters/*-96-v2.png`; historical compositions live in `docs/visual-proofs/`. They are not browser screenshots. The generated portrait atlas remains in `public/assets/portraits/`, with creation provenance here in `portraits/PROVENANCE.md`.
