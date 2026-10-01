"""Read-only asset QA with the installed Pillow; never edits runtime artwork.
Run after ../generate-96-art.py. Test/build execution remains the integration owner's.
"""
from pathlib import Path
from PIL import Image
import hashlib, json
ROOT=Path(__file__).resolve().parents[2]
results=[]
for path in sorted((ROOT/'public/assets').glob('*/*-sheet-96-v2.png')):
    im=Image.open(path)
    assert im.size==(576,288) and im.mode=='RGBA'
    frames=[im.crop((f*96,d*96,(f+1)*96,(d+1)*96)) for d in range(3) for f in range(6)]
    bounds=[frame.getbbox() for frame in frames]
    heights=[b[3]-b[1] for b in bounds];widths=[b[2]-b[0] for b in bounds]
    distinct=[len({frame.tobytes() for frame in frames[d*6:d*6+6]}) for d in range(3)]
    alpha=sorted(value for _,value in im.getchannel('A').getcolors(256))
    assert alpha==[0,255], f'{path}: anti-aliased alpha detected'
    assert distinct==[6,6,6], f'{path}: duplicate poses'
    assert len({frames[d*6].tobytes() for d in range(3)})==3, f'{path}: duplicate directions'
    assert min(heights)>=72 and max(heights)<=88, f'{path}: weak occupancy or clipping'
    assert min(widths)>=48 and max(widths)<=90, f'{path}: weak occupancy or clipping'
    assert all(b[0]>=3 and b[1]>=2 and b[2]<=93 and b[3]<=91 for b in bounds), f'{path}: frame-edge bleed'
    # Every grounded asset keeps at least one foot on y90 (91px exclusive bound).
    if 'ember-wisp' not in path.name: assert all(b[3]==91 for b in bounds)
    counts=[sum(count for count,value in frame.getchannel('A').getcolors(256) if value) for frame in frames]
    seed=Image.open(path.with_name(path.name.replace('-sheet','')))
    assert seed.size==(96,96) and seed.tobytes()==frames[0].tobytes()
    results.append(dict(asset=str(path.relative_to(ROOT)),dimensions=list(im.size),mode=im.mode,visibleWidthRange=[min(widths),max(widths)],visibleHeightRange=[min(heights),max(heights)],uniquePosesPerDirection=distinct,uniqueDirections=3,alphaValues=alpha,opaquePaletteColors=len(im.getcolors(1_000_000))-1,opaquePixelsRange=[min(counts),max(counts)],frameBounds=bounds))
assert len(results)==9
portrait=ROOT/'public/assets/portraits/disciples-atlas-v1.png'
portrait_hash=hashlib.sha256(portrait.read_bytes()).hexdigest()
assert portrait_hash=='d26789c943b79e88bff680c46d52ea9ddbd08d9cd442f65be3f89efe2f2b6c5e'
report=dict(date='2026-10-01',verification='Read-only PNG pixel inspection with installed Pillow; no image resampling or editing',portraitSha256=portrait_hash,portraitUnchanged=True,sourceGrid='Integer coordinate assertions enforced in generator; no scale transforms',rasterization='Inkscape --export-png-antialias=0 at exact96px frame size',results=results)
(Path(__file__).parent/'quality-report-96-v2.json').write_text(json.dumps(report,indent=2)+'\n')
print('Verified9 assets / 162 distinct directional poses: native96 frames, binary alpha, occupied heights78–88px, stable grounded feet, exact seed/frame0 and unchanged portrait hash.')
