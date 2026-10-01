"""Native 96px redraw, authored on an integer grid (not resampled legacy art).

Run `python3 assets-source/generate-96-art.py` to regenerate only character/enemy
SVGs, transparent runtime PNGs and static contact sheets. No packages required;
rasterization uses the already-installed Inkscape. Portraits are never written.
"""
from pathlib import Path
from contextlib import contextmanager
import base64, json, os, struct, subprocess, hashlib
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets-source'
VERSION = '96-v2'
INK = '#293b43'
SKIN = dict(shadow='#bf866c', mid='#dfa582', base='#f0c6a2', light='#f8d9b6', blush='#e8a991', eye='#fff0d2')
GOLD = '#c6a665'; GOLD_LIGHT = '#e9d294'; JADE = '#a6c8a6'
class Art:
    def __init__(self,w=96,h=96): self.w=w;self.h=h;self.parts=[]
    def rect(self,x,y,w,h,c):
        assert all(isinstance(n,int) for n in (x,y,w,h)), (x,y,w,h)
        if w>0 and h>0:self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{c}"/>')
    def poly(self,pts,c):
        assert all(isinstance(n,int) for p in pts for n in p), pts
        self.parts.append('<polygon points="'+' '.join(f'{x},{y}' for x,y in pts)+f'" fill="{c}"/>')
    @contextmanager
    def at(self,x=0,y=0):
        assert isinstance(x,int) and isinstance(y,int)
        self.parts.append(f'<g transform="translate({x} {y})">');yield;self.parts.append('</g>')
    def save(self,path):
        path.parent.mkdir(exist_ok=True,parents=True)
        path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" shape-rendering="crispEdges">'+''.join(self.parts)+'</svg>\n')
    def text(self,x,y,content,size=14,color=INK):
        self.parts.append(f'<text x="{x}" y="{y}" fill="{color}" font-family="sans-serif" font-size="{size}">{content}</text>')
PALETTES = [
    dict(robe='#ba8c4e', mid='#d5ac66', light='#e8c887', dark='#805e3e', deep='#674d3b', trim='#eee1bc', hair='#453832', hairmid='#655044', shine='#8b6b4d', accent='#81946b'),
    dict(robe='#579195', mid='#79b1ad', light='#abd0bf', dark='#37666f', deep='#2b515d', trim='#e4e9d6', hair='#29323f', hairmid='#404b5c', shine='#647081', accent='#d6b777'),
    dict(robe='#a26452', mid='#c28b6c', light='#dfb08b', dark='#714b42', deep='#583d39', trim='#f0dfbd', hair='#3d3332', hairmid='#5c4942', shine='#82634d', accent='#bf9d60'),
    dict(robe='#9181a6', mid='#b09cc0', light='#cec0d6', dark='#675b7e', deep='#514f68', trim='#ece4d3', hair='#b7b5b0', hairmid='#d6d0c1', shine='#f1e9d7', accent='#aec6a3'),
]
STEP=[0,3,5,-1,-3,-5]
BOB=[0,-1,-2,0,-1,-2]

def flower(a,x,y):
    r=a.rect;q=a.poly
    q([(x,y-5),(x+3,y-3),(x+3,y),(x+7,y+1),(x+5,y+5),(x+1,y+4),(x-2,y+7),(x-5,y+4),(x-3,y),(x-4,y-3)],GOLD)
    r(x-1,y-3,2,4,GOLD_LIGHT);r(x+2,y+1,3,2,GOLD_LIGHT);r(x-3,y+2,3,2,'#ecdeaf');r(x,y,3,3,'#dce5bf');r(x+1,y+1,1,1,'#fcf3d2')

def leaf_motif(a,x,y,c):
    q=a.poly;r=a.rect
    q([(x,y+8),(x+3,y+3),(x+4,y+3),(x+1,y+9)],c)
    q([(x+2,y+5),(x-2,y+3),(x-3,y),(x+1,y+2)],c)
    q([(x+3,y+4),(x+6,y),(x+8,y),(x+6,y+3)],c)

def boots(a,d,f,novice=False):
    r=a.rect;q=a.poly;s=STEP[f];y=83 if not novice else 84
    # A planted foot remains at y91; the passing leg lifts instead of shifting the anchor.
    left=-max(0,s)//2;right=-max(0,-s)//2
    if d==1:
        rear=35-s;front=50+s
        q([(rear,y-5),(rear+10,y-5),(rear+10,88+left),(rear+15,89+left),(rear+15,91+left),(rear-2,91+left),(rear-2,88+left)],INK)
        r(rear+1,y-4,7,8,'#b7c4b5');r(rear+1,y-4,7,2,'#e5dfc2');r(rear,88+left,11,1,'#647a7a')
        q([(front,y-5),(front+10,y-5),(front+10,88+right),(front+16,88+right),(front+17,91+right),(front-1,91+right),(front-1,87+right)],INK)
        r(front+1,y-4,7,8,'#dedbc0');r(front+1,y-4,7,2,'#f1e4c5');r(front,88+right,13,1,'#738884')
    else:
        for x,lift,side in [(34-(s//3),left,0),(53+(s//3),right,1)]:
            q([(x,y-5),(x+10,y-5),(x+10,87+lift),(x+12,89+lift),(x+12,91+lift),(x-2,91+lift),(x-2,88+lift)],INK)
            r(x+1,y-3,8,8,'#becabb' if side else '#dbdcc1');r(x+1,y-3,8,2,'#efdfc0');r(x-1,88+lift,11,1,'#768b85')

def robe(a,index,d,f):
    p=PALETTES[index];r=a.rect;q=a.poly;s=STEP[f];short=index==0
    top=48 if short else 45;hem=82 if short else 85;shift=s//2
    # The outer skirts fan in opposite directions; front and back use different seams.
    q([(32,top),(62,top),(69,53),(65,65),(73+shift,hem-3),(66+shift,hem+1),(56,hem),(49,hem-3),(40,hem+1),(24+shift,hem-1),(29,65),(26,54)],INK)
    q([(33,top+2),(60,top+2),(65,54),(62,65),(69+shift,hem-4),(64+shift,hem-1),(56,hem-2),(49,hem-6),(39,hem-1),(28+shift,hem-3),(34,63),(29,54)],p['robe'])
    q([(34,51),(43,54),(42,65),(36+shift,hem-3),(29+shift,hem-4),(35,65)],p['mid'])
    q([(35,52),(38,55),(36,65),(32+shift,hem-5),(30+shift,hem-5),(34,63)],p['light'])
    q([(60,51),(65,56),(60,65),(68+shift,hem-5),(62+shift,hem-3),(55,66)],p['dark'])
    q([(49,62),(52,64),(54,hem-5),(50,hem-6),(45,hem-2),(44,74)],p['deep'])
    q([(45,67),(49,66),(47,hem-4),(40,hem-1)],p['light'])
    q([(53,68),(56,67),(60,hem-4),(56,hem-4)],p['mid'])
    r(29+shift,hem-4,10,2,p['trim']);r(59+shift,hem-5,9,2,p['trim'])
    if d!=2:
        # Real wrap collar, inner shirt and narrow embroidered edging.
        q([(38,45),(47,49),(56,45),(62,48),(51,64),(44,66),(33,51)],p['deep'])
        q([(38,46),(47,50),(55,46),(58,49),(45,64),(42,60),(34,50)],p['trim'])
        q([(39,47),(47,53),(52,48),(55,47),(48,58),(44,58)],'#faf0d5')
        q([(55,48),(59,49),(47,65),(44,64)],p['light'])
        q([(35,49),(37,48),(45,59),(43,61)],GOLD if index in (0,2) else p['mid'])
        r(33,65,30,6,p['deep']);r(33,65,29,1,p['accent']);r(34,70,28,1,p['dark'])
        q([(47,64),(52,64),(55,67),(51,71),(47,70),(45,67)],GOLD);r(48,66,4,3,GOLD_LIGHT);r(49,67,2,1,p['deep'])
        q([(51,71),(55,71),(58+shift,82),(54+shift,82)],p['accent']);r(54+shift,80,5,2,GOLD_LIGHT)
        if index in (0,1,3):leaf_motif(a,30,72,p['light']);leaf_motif(a,61,73,p['mid'])
        if index==2:
            q([(30,48),(35,47),(60,67),(57,71)],p['deep']);q([(31,49),(33,49),(59,68),(58,69)],GOLD)
            r(36,56,4,3,GOLD);r(37,57,2,1,GOLD_LIGHT)
    else:
        q([(35,48),(42,46),(57,47),(62,51),(54,55),(43,55)],p['dark'])
        r(34,65,29,5,p['deep']);r(34,65,28,1,p['accent']);r(46,64,6,7,p['accent'])
        q([(46,70),(50,70),(43+shift,80),(40+shift,80)],p['mid']);q([(50,70),(54,70),(61+shift,78),(58+shift,80)],p['accent'])
        q([(49,72),(51,73),(53,83),(50,81)],p['dark'])
        leaf_motif(a,34,74,p['light'])

def sleeve(a,p,x,y,left=True,long=False,swing=0):
    # Asymmetrical wide cuff, visible lining and a separately posed hand.
    r=a.rect;q=a.poly
    with a.at(x,y):
        if left:
            pts=[(0,0),(9,1),(12,8),(7+swing,20),(2+swing,25),(-7+swing,21),(-8,15),(-4,6)]
            inner=[(0,2),(7,3),(9,8),(4+swing,18),(-3+swing,19),(-5,14),(-2,7)]
        else:
            pts=[(0,0),(8,2),(12,8),(17+swing,18),(14+swing,24),(5+swing,23),(0,13),(-3,6)]
            inner=[(1,3),(7,4),(9,9),(14+swing,18),(11+swing,20),(7+swing,19),(3,11),(-1,6)]
        q(pts,INK);q(inner,p['robe']);q([(0,4),(4,3),(5,10),(1+swing,17),(-2+swing,16),(-1,9)] if left else [(3,4),(6,5),(10+swing,16),(8+swing,17),(4,11)],p['mid'])
        if left:
            q([(-5+swing,18),(6+swing,20),(3+swing,24),(-6+swing,21)],p['trim'])
            r(-3+swing,23,6,4,SKIN['shadow']);r(-2+swing,23,4,3,SKIN['base']);r(-2+swing,23,3,1,SKIN['light'])
        else:
            q([(6+swing,19),(15+swing,17),(14+swing,22),(7+swing,24)],p['trim'])
            r(9+swing,23,5,4,SKIN['shadow']);r(9+swing,23,4,3,SKIN['base']);r(9+swing,23,3,1,SKIN['light'])
        if long:
            if left:q([(-5+swing,14),(5+swing,17),(4+swing,30),(-2+swing,34),(-10+swing,27)],p['dark']);q([(-5+swing,17),(2+swing,19),(1+swing,29),(-4+swing,30),(-7+swing,25)],p['light']);r(-6+swing,28,8,2,p['trim'])
            else:q([(7+swing,15),(14+swing,15),(21+swing,28),(14+swing,34),(8+swing,29)],p['dark']);q([(9+swing,18),(12+swing,17),(18+swing,27),(14+swing,30),(10+swing,28)],p['mid']);r(12+swing,29,6,2,p['trim'])

def face(a,index,d):
    p=PALETTES[index];r=a.rect;q=a.poly
    if d==2:return
    if d==0:
        # A 30x26px face gives enough native pixels for iris, eyelid and mouth.
        q([(34,23),(59,22),(65,28),(64,39),(58,47),(49,50),(40,47),(33,41),(31,31)],SKIN['shadow'])
        q([(35,24),(58,24),(62,28),(62,39),(57,45),(49,48),(41,45),(35,40),(33,31)],SKIN['base'])
        q([(36,26),(57,25),(60,28),(60,34),(54,37),(38,36),(34,32)],SKIN['light'])
        q([(34,31),(31,29),(28,31),(29,37),(33,39)],SKIN['mid']);r(29,32,2,3,SKIN['base']);r(31,33,1,3,SKIN['shadow'])
        q([(63,31),(66,30),(68,32),(67,37),(63,39)],SKIN['mid']);r(65,32,2,3,SKIN['base'])
        r(35,39,5,2,SKIN['blush']);r(58,39,5,2,SKIN['blush']);r(48,37,2,4,SKIN['mid']);r(49,37,1,2,SKIN['light'])
        # Slightly different eye apertures convey age and temperament.
        for x in (36,54):
            y=33 if index==0 else 34
            if index in (0,1):
                q([(x,y),(x+2,y-1),(x+7,y-1),(x+9,y+1),(x+8,y+5),(x+1,y+5),(x,y+3)],p['hair'])
                r(x+1,y+1,7,4,SKIN['eye']);r(x+4,y,3,5,'#716048' if index==0 else '#53645e');r(x+5,y+1,2,4,INK);r(x+4,y,2,2,'#fff5de');r(x+1,y+5,6,1,SKIN['mid'])
                if index==1:r(x-1,y,2,1,p['hair']);r(x+7,y-1,2,1,p['hair'])
            else:
                q([(x,y),(x+3,y-1),(x+8,y),(x+9,y+2),(x+7,y+4),(x+1,y+3)],p['hair'] if index==2 else '#827060')
                r(x+1,y+1,7,2,SKIN['eye']);r(x+4,y,3,4,'#4d544b');r(x+4,y,1,1,'#fff0d3')
            brow_y=30 if index!=2 else 29
            q([(x,brow_y),(x+3,brow_y-1),(x+8,brow_y),(x+8,brow_y+1),(x+3,brow_y),(x,brow_y+1)],p['hairmid'] if index!=3 else '#96958c')
        if index==0:r(45,43,7,1,'#a96f59');r(47,44,6,1,'#d48d71');r(47,45,3,1,'#f4d3ac')
        elif index==1:q([(45,43),(48,44),(54,42),(53,44),(49,45),(45,44)],'#b77868');r(48,43,4,1,'#eec0a0')
        elif index==2:
            r(42,43,5,1,'#6f5144');r(49,43,7,1,'#6f5144');r(46,42,6,1,'#745646');q([(39,42),(41,44),(46,47),(51,48),(57,44),(58,41),(60,43),(58,47),(52,50),(47,50),(41,47)],'#896b55');r(46,45,7,1,SKIN['shadow']);r(47,46,5,1,SKIN['mid'])
        else:
            q([(42,43),(46,44),(52,44),(57,41),(56,44),(52,46),(46,46)],'#a77563');r(46,44,7,1,'#f6dbc0');r(37,39,4,1,'#b78771');r(59,39,4,1,'#b78771');r(38,41,3,1,'#c1917a');r(59,41,2,1,'#c1917a');r(43,28,12,1,'#cba58a');r(41,30,5,1,'#d8b597');r(54,29,5,1,'#d8b597')
    else:
        q([(38,23),(60,23),(66,29),(66,35),(70,38),(68,41),(64,42),(61,47),(53,50),(43,47),(36,40),(35,30)],SKIN['shadow'])
        q([(41,25),(59,25),(64,29),(64,36),(68,38),(67,40),(63,40),(60,45),(54,47),(45,44),(39,38),(38,30)],SKIN['base'])
        q([(43,25),(58,25),(62,29),(62,35),(51,36),(41,33)],SKIN['light'])
        r(62,36,2,3,SKIN['light']);r(61,40,3,2,SKIN['blush'])
        q([(39,31),(35,30),(33,32),(34,38),(39,40),(41,37)],SKIN['mid']);r(35,32,3,5,SKIN['base']);r(36,34,2,2,SKIN['shadow'])
        q([(54,33),(57,32),(63,33),(64,35),(62,38),(55,38)],p['hair']);r(55,34,8,3,SKIN['eye']);r(59,33,3,5,'#526055');r(60,34,2,3,INK);r(59,33,1,1,'#fff1d2')
        q([(54,29),(58,28),(64,30),(63,31),(57,30),(54,30)],p['hairmid'] if index!=3 else '#98988d')
        r(59,43,5,1,'#a87561');r(58,44,4,1,SKIN['mid'])
        if index==2:q([(43,40),(46,43),(54,47),(60,45),(64,41),(63,46),(56,50),(50,48),(45,46)],'#80634f');r(57,42,7,1,'#755545')
        if index==3:r(53,39,3,1,'#ba8b73');r(61,39,3,1,'#ba8b73');r(52,27,8,1,'#d0aa8c');r(59,41,2,1,'#c3967e')

def head(a,index,d,f):
    p=PALETTES[index];r=a.rect;q=a.poly;s=STEP[f]
    # Silhouette is separately drawn for profile and back, never a front face with one eye erased.
    q([(32,17),(36,12),(43,10),(55,10),(65,15),(70,23),(70,34),(67,41),(61,46),(55,45),(36,44),(29,38),(27,28)],p['deep'] if index==3 else INK)
    q([(33,18),(37,14),(44,12),(55,12),(63,16),(67,23),(67,35),(63,41),(55,44),(37,42),(31,36),(30,27)],p['hair'])
    if d==2:
        q([(33,19),(39,14),(48,12),(59,14),(65,19),(67,29),(64,41),(56,48),(39,46),(31,38),(29,28)],p['hair'])
        q([(34,20),(39,16),(45,14),(52,14),(48,17),(42,19),(38,23),(34,29)],p['hairmid'])
        q([(37,20),(44,15),(49,14),(46,16),(40,20),(37,24)],p['shine'])
        q([(59,17),(62,20),(64,27),(62,35),(60,39),(60,26)],p['hairmid'])
        q([(34,30),(37,24),(39,23),(37,33),(39,42),(35,38)],p['hairmid'])
        r(46,19,1,8,p['hairmid']);r(48,32,1,6,p['hairmid'])
    else:
        face(a,index,d)
        if d==0:
            q([(30,25),(32,18),(39,13),(48,12),(60,14),(66,20),(67,28),(63,29),(58,24),(55,21),(52,28),(48,25),(46,19),(41,25),(37,28),(38,22),(33,30),(29,33)],p['hair'])
            q([(33,21),(37,17),(44,14),(51,14),(46,16),(41,20),(37,22),(34,27)],p['hairmid'])
            q([(37,18),(44,15),(49,14),(46,16),(41,18),(37,21)],p['shine'])
            q([(51,15),(57,16),(63,20),(64,23),(57,21),(55,18)],p['hairmid'])
            q([(44,19),(45,17),(47,20),(48,25),(46,23)],p['hairmid'])
            q([(31,25),(34,24),(34,33),(36,41),(32,39),(30,34)],p['hair'])
            r(32,28,1,7,p['hairmid']);q([(64,26),(67,27),(66,37),(63,43),(62,40),(64,34)],p['hair']);r(65,29,1,6,p['hairmid'])
        else:
            q([(31,24),(34,17),(40,13),(50,12),(60,15),(66,22),(66,29),(62,28),(58,23),(51,20),(48,25),(43,29),(42,35),(39,39),(36,33),(32,36),(30,30)],p['hair'])
            q([(34,22),(39,17),(47,14),(54,15),(49,17),(42,20),(36,25),(33,30)],p['hairmid'])
            q([(38,19),(45,15),(50,15),(45,17),(40,20),(36,24)],p['shine'])
            q([(52,16),(58,18),(63,23),(64,26),(59,23)],p['hairmid'])
            q([(40,25),(43,23),(42,30),(39,36),(38,34)],p['hairmid'])
    if index==0:
        # Tousled boy's topknot and two sage ribbon tails.
        q([(39,12),(37,8),(40,3),(46,2),(51,4),(58,3),(62,8),(60,14),(54,16),(44,15)],INK)
        q([(40,10),(42,5),(46,4),(50,7),(56,5),(60,9),(57,13),(47,13)],p['hair']);q([(43,6),(47,5),(50,8),(47,10),(42,11)],p['hairmid']);r(44,5,3,1,p['shine'])
        q([(35,13),(42,11),(56,12),(61,15),(57,17),(42,15)],p['accent']);r(41,12,14,1,'#b3bd85')
        q([(37,15),(33,19),(25+s,28),(22+s,34),(17+s,34),(21+s,28),(28+s,21),(32,14)],'#667954')
        q([(33,16),(31,22),(29+s,35),(25+s,42),(21+s,43),(23+s,34),(28,22)],p['accent']);r(23+s,34,2,5,'#afbb83')
        if d!=2:q([(28,23),(31,20),(31,28),(28,32),(26,32)],p['hair']);q([(67,24),(71,28),(74,30),(69,30),(67,28)],p['hair'])
    elif index==1:
        q([(42,14),(39,9),(43,3),(52,2),(61,5),(64,11),(60,17),(49,18)],INK)
        q([(43,12),(42,9),(45,5),(52,4),(59,7),(61,11),(57,15)],p['hair']);q([(45,8),(49,5),(55,6),(57,8),(50,8),(46,11)],p['hairmid']);r(49,5,4,1,p['shine'])
        r(42,13,24,2,GOLD);r(59,12,20,1,GOLD);r(77,10,2,5,GOLD_LIGHT);flower(a,64,10)
        r(72,16,1,16,GOLD);r(71,18,3,4,JADE);r(71,25,3,3,GOLD_LIGHT);q([(71,29),(74,29),(77+s//2,42),(73+s//2,44),(70+s//2,42)],'#76a398');r(72+s//2,32,1,10,'#b4d4ba')
        if d!=2:r(33,39,1,6,GOLD);r(32,43,3,5,JADE);r(65,40,1,5,GOLD);r(64,44,3,5,JADE)
    elif index==2:
        q([(41,13),(41,8),(45,4),(52,3),(59,7),(61,12),(58,17),(48,17)],INK)
        q([(44,11),(44,8),(48,5),(53,5),(58,9),(57,13)],p['hair']);q([(46,7),(51,5),(54,6),(55,8),(48,10)],p['hairmid'])
        q([(39,13),(43,10),(58,12),(62,16),(60,18),(47,14),(41,16)],'#a46d51');r(45,12,11,1,'#d49e71')
        if d!=2:r(39,31,6,1,p['hair']);r(55,31,7,1,p['hair'])
    else:
        q([(42,14),(38,10),(40,5),(47,2),(56,3),(64,7),(64,14),(59,18)],'#7c8585')
        q([(42,12),(41,9),(44,5),(50,4),(58,6),(62,10),(60,14),(51,15)],p['hair']);q([(43,8),(49,5),(55,6),(52,8),(46,10)],p['shine']);q([(55,7),(59,9),(59,13),(55,14)],p['hairmid'])
        r(38,13,28,2,GOLD);r(57,11,21,1,GOLD);flower(a,63,12);r(71,17,1,10,GOLD);r(70,22,3,4,JADE)
        q([(34,20),(37,16),(42,14),(40,17),(35,23),(33,29),(31,29)],p['shine']);q([(56,15),(60,18),(64,23),(65,26),(62,24),(60,20)],p['shine'])
        q([(32,30),(34,32),(36,42),(39,45),(37,47),(33,44),(31,37)],p['hairmid']);r(33,34,1,6,p['shine'])

def back_hair(a,index,d,f):
    p=PALETTES[index];q=a.poly;r=a.rect;s=STEP[f]//2
    if index==1:
        q([(32,30),(39,29),(58,29),(66,32),(68,48),(73+s,62),(70+s,69),(64+s,64),(58,59),(54,50),(38,50),(35,59),(28+s,63),(30+s,51)],INK)
        q([(34,31),(40,31),(58,32),(63,35),(64,48),(69+s,63),(67+s,65),(60,58),(54,48),(37,49),(31+s,59),(34,45)],p['hair'])
        q([(60,35),(62,37),(62,47),(67+s,59),(67+s,62),(63+s,57),(58,47)],p['hairmid']);r(35,38,1,12,p['hairmid'])
    elif index==2:
        q([(55,12),(65,14),(73+s,22),(76+s,36),(73+s,49),(78+s,59),(71+s,63),(63+s,55),(65+s,41),(61,26),(56,20)],INK)
        q([(58,15),(64,17),(70+s,24),(72+s,36),(69+s,49),(74+s,58),(71+s,59),(66+s,53),(68+s,40),(64,25)],p['hair']);q([(65,20),(69+s,26),(71+s,37),(68+s,46),(67+s,45),(68+s,34)],p['hairmid']);r(69+s,50,1,5,p['shine'])
    elif index==3:
        q([(33,34),(38,40),(39,48),(35,55),(31,53),(33,49),(31,42)],p['hair']);r(34,42,1,7,p['shine']);q([(61,34),(67,37),(66,47),(69,54),(64,56),(62,50)],p['hairmid']);r(64,41,1,8,p['shine'])

def sword(a,f,d):
    r=a.rect;q=a.poly;s=STEP[f]//2
    with a.at(s,0):
        q([(19,25),(25,26),(30,76),(27,83),(22,81),(16,29)],INK);q([(20,29),(23,30),(27,76),(25,79),(23,76)],'#586971');r(20,34,2,29,'#8b9a91')
        q([(15,25),(28,27),(29,31),(15,29)],GOLD);r(16,26,10,1,GOLD_LIGHT)
        q([(18,11),(22,11),(24,26),(19,26)],'#403d3c');r(19,12,3,2,GOLD);r(19,17,4,1,'#9c9075');r(20,21,3,1,'#9c9075');r(17,10,7,3,GOLD);r(18,10,4,1,GOLD_LIGHT)
        r(22,69,6,3,GOLD);r(23,78,4,2,GOLD);r(14,15,1,12,GOLD);r(13,18,3,3,'#cbad79');q([(13,25),(15,25),(17,40),(13,42),(11,39)],'#a76b51');r(13,28,1,10,'#d3996b')

def staff(a,f):
    r=a.rect;q=a.poly
    q([(76,90),(73,88),(76,34),(75,28),(80,22),(86,21),(89,25),(88,28),(84,26),(80,28),(80,35),(79,89)],'#493f37')
    q([(76,88),(78,36),(77,28),(81,24),(85,23),(87,25),(82,26),(80,29),(79,47),(78,88)],'#896b4d');r(77,41,1,24,'#bb9565');r(76,71,1,10,'#bb9565');r(75,36,7,2,'#96746d');r(75,40,7,2,'#ab8677');r(84,28,1,8,GOLD)
    q([(82,35),(85,33),(88,36),(88,39),(85,42),(82,39)],'#679d91');r(83,35,2,4,'#bad2ae');r(84,42,1,4,GOLD);q([(83,46),(86,46),(88,59),(84,61),(81,58)],'#9b83af');r(84,48,1,11,'#d4bfd5')

def disciple(a,index,d,f):
    p=PALETTES[index];r=a.rect;q=a.poly;s=STEP[f];bob=BOB[f]
    boots(a,d,f,index==0)
    with a.at(0,bob + (3 if index==1 else 2 if index==2 else 0)):
        back_hair(a,index,d,f)
        if index==2:sword(a,f,d)
        robe(a,index,d,f)
        if d==1:
            # Far arm is recessed; near arm crosses the robe with an actual swing.
            sleeve(a,p,56,47,left=False,long=index==1,swing=-s//2)
            sleeve(a,p,34,48,left=True,long=index==1,swing=s//2)
        else:
            sleeve(a,p,29,47 if index!=0 else 50,left=True,long=index==1,swing=s//2)
            sleeve(a,p,62,47 if index!=0 else 50,left=False,long=index==1,swing=-s//2)
        if index==0 and d!=2:
            # Bamboo book is held against the body, with binding cords and fingers.
            q([(58,53),(72,55),(70,73),(55,70)],p['deep']);q([(59,54),(70,56),(68,71),(57,69)],'#b59458')
            for x in range(59,70,3):q([(x,55),(x+1,55),(x-1,70),(x-2,70)],'#e0c483')
            q([(57,58),(71,60),(71,62),(57,60)],'#5d7360');q([(56,66),(69,68),(69,70),(56,68)],'#5d7360')
            r(61,61,8,6,SKIN['shadow']);r(60,61,8,4,SKIN['base']);r(61,60,5,2,SKIN['light']);r(62,64,6,1,SKIN['mid'])
        if index==1:
            r(62,67,2,7,GOLD);q([(61,73),(64,72),(66,75),(64,79),(61,78)],JADE);r(62,74,1,3,'#d9e3bb');r(63,79,1,6,GOLD)
        if index==3:
            # Slightly stooped neckline and a staff-gripping hand; no beard.
            staff(a,f);r(74,62,7,6,SKIN['shadow']);r(74,62,6,4,SKIN['base']);r(75,62,5,1,SKIN['light']);r(76,66,4,1,SKIN['mid'])
        r(42,42,13,8,SKIN['shadow']);q([(44,43),(54,43),(53,49),(49,52),(44,48)],SKIN['base'])
        with a.at(0,4 if index==0 else 3 if index==3 else 0):head(a,index,d,f)
        if index==1 and d==2:
            # Back view retains free-hanging hair rather than exposing a front collar.
            q([(37,36),(43,39),(57,37),(62,39),(62,56),(58+s//2,68),(55+s//2,72),(50,66),(42,66),(35+s//2,71),(34,63)],p['hair']);q([(40,40),(43,41),(42,57),(39+s//2,65),(37,66)],p['hairmid']);q([(58,41),(60,42),(60,56),(55+s//2,66),(56,60)],p['hairmid']);r(46,40,1,17,p['hairmid'])

# Enemy redraws are appended below. They use the same 96px anchor/palette discipline.
PALETTES.extend([
    dict(robe='#97634d',mid='#c28b64',light='#d8ab7b',dark='#624740',deep='#493b3b',trim='#d8c093',hair='#343735',hairmid='#53584b',shine='#838371',accent='#bca369'),
    dict(robe='#607c69',mid='#87a184',light='#b3c49a',dark='#405d55',deep='#35464c',trim='#d3d5af',hair='#555069',hairmid='#7e6a88',shine='#a38b9e',accent='#b6ae78'),
])

def enemy_human(a,d,f,venom=False):
    index=5 if venom else 4;p=PALETTES[index];r=a.rect;q=a.poly;s=STEP[f];bob=BOB[f]
    boots(a,d,f)
    with a.at(0,bob + (1 if venom else 0)):
        if venom:
            q([(28,24),(33,17),(59,14),(68,24),(70,46),(74+s//2,58),(69+s//2,64),(63,59),(34,56),(24-s//2,64),(21-s//2,58),(27,42)],p['deep'])
            q([(30,28),(35,21),(60,19),(65,27),(65,45),(70+s//2,57),(67,59),(61,54),(34,52),(25-s//2,59),(28,43)],p['hair'])
            q([(30,30),(34,23),(37,22),(34,45),(30,55),(27,56)],p['hairmid'])
        else:
            # Hanging scarf tails and backpack emphasize the human raider silhouette.
            q([(58,31),(65,33),(70,46),(72+s,55),(68+s,57),(64,49),(59,45)],'#774c45')
            q([(25,45),(32,42),(41,46),(40,65),(30,68),(24,61)],p['deep']);r(27,48,11,12,'#846d51');r(28,50,2,10,'#b49b6c');r(26,55,13,2,GOLD)
        robe(a,index,d,f)
        sleeve(a,p,29,47,True,False,s//2);sleeve(a,p,62,47,False,False,-s//2)
        # Shoulder overlays and leather ties have their own highlight clusters.
        if not venom:
            q([(27,45),(35,47),(33,56),(22,58),(20,53),(23,48)],p['deep']);q([(26,47),(32,49),(30,53),(23,54)],p['dark']);r(23,50,8,1,GOLD);r(23,54,7,1,GOLD)
            q([(61,46),(68,47),(73,54),(68,58),(61,54)],p['deep']);q([(63,48),(67,49),(70,54),(67,55),(63,52)],p['mid']);r(64,51,5,1,GOLD)
            q([(33,49),(36,48),(59,67),(56,70)],'#423e3b');r(41,56,5,4,GOLD);r(42,57,3,2,GOLD_LIGHT)
        else:
            q([(29,46),(39,46),(36,52),(28,55),(23,53)],'#675970');q([(59,46),(66,46),(71,53),(64,56),(60,52)],'#675970');r(26,50,9,1,GOLD);r(63,51,6,1,GOLD)
            # Stitched herb bag is visible beside a jade poison flask.
            q([(24,67),(36,66),(39,79),(34,84),(24,83),(21,76)],'#344d47');q([(25,69),(34,68),(36,77),(32,81),(25,80),(23,75)],'#84986e');r(25,69,9,2,'#b5bd8a');r(24,73,2,5,GOLD);r(33,73,2,4,GOLD);r(26,80,6,1,GOLD)
            r(62,61,5,5,'#715d51');r(61,62,7,2,GOLD);q([(62,65),(67,65),(70,70),(69,77),(66,80),(61,78),(59,72)],'#2f514e');q([(63,67),(66,67),(68,71),(66,77),(62,76),(61,71)],'#96b58b');r(62,68,2,5,'#d0d8a0');r(62,77,5,1,GOLD)
        # Different head construction from the disciples: hood versus short wild hair.
        q([(30,16),(36,10),(46,8),(59,10),(67,16),(71,25),(69,38),(64,47),(53,51),(40,47),(30,39),(27,28)],INK)
        q([(32,18),(37,13),(47,11),(58,13),(65,18),(67,27),(65,39),(59,45),(51,48),(40,44),(33,38),(30,29)],p['hair'])
        if d==2:
            q([(32,22),(38,15),(47,12),(58,15),(65,22),(65,34),(58,45),(43,46),(33,38)],p['hair']);q([(34,22),(40,16),(47,14),(54,16),(46,18),(39,24),(35,30)],p['hairmid']);q([(60,20),(63,24),(61,35),(58,39),(59,28)],p['hairmid'])
            r(35,40,28,4,GOLD if venom else '#995e4a')
        else:
            face_x=3 if d==1 else 0
            with a.at(face_x,0):
                q([(36,24),(57,24),(63,29),(63,39),(57,47),(48,49),(39,45),(33,37),(33,29)],SKIN['shadow']);q([(37,26),(56,26),(60,30),(60,38),(55,44),(48,46),(40,42),(35,36),(35,30)],SKIN['base']);r(38,28,20,8,SKIN['light'])
                eyes=[(38,33),(53,33)] if d==0 else [(54,33)]
                for x,y in eyes:
                    q([(x,y),(x+3,y-2),(x+8,y-1),(x+8,y+3),(x+1,y+3)],'#433d40');r(x+1,y,7,2,'#dce4af' if venom else SKIN['eye']);r(x+4,y-1,2,4,'#687d51' if venom else '#655340');r(x+4,y,1,1,'#f4e6b9')
                    q([(x-1,y-4),(x+3,y-5),(x+8,y-4),(x+8,y-3),(x+2,y-3)],p['hairmid'])
                if venom:
                    r(49,39,2,3,SKIN['mid']);r(46,44,9,1,'#926976');r(44,41,2,1,SKIN['shadow']);r(57,41,2,1,SKIN['shadow'])
                else:
                    q([(33,37),(42,38),(49,40),(61,37),(64,39),(61,46),(52,50),(41,47),(35,44)],'#784a46');q([(35,38),(43,40),(51,42),(61,39),(60,42),(51,46),(41,43),(36,42)],'#b57b61');r(42,44,11,1,'#8d5b4d')
        if venom:
            q([(28,24),(29,17),(36,9),(47,4),(56,7),(66,15),(69,25),(65,28),(60,23),(56,18),(47,15),(39,18),(34,27),(30,31)],'#50465d');q([(30,23),(32,17),(38,11),(47,7),(53,9),(58,14),(48,11),(39,15),(34,21)],'#88728d');q([(33,18),(39,12),(46,9),(49,10),(40,15),(36,20)],'#b094a8')
            q([(29,25),(34,23),(35,35),(39,46),(34,48),(30,40),(28,32)],'#655772');q([(64,24),(68,25),(68,39),(64,47),(61,44),(64,36)],'#655772');r(31,28,1,11,'#a08aa0');r(65,29,1,11,'#8b7993')
            r(40,8,16,2,GOLD);q([(47,4),(50,7),(48,11),(45,9),(45,6)],'#83a486');r(47,6,1,3,'#cadca7')
        else:
            q([(29,23),(30,16),(37,11),(36,6),(43,8),(49,6),(56,10),(62,10),(63,15),(69,20),(70,28),(66,30),(61,25),(56,21),(51,25),(47,20),(42,24),(38,21),(33,28),(28,31)],p['hair']);q([(33,19),(38,13),(43,12),(47,10),(51,12),(45,14),(39,18),(34,24)],p['hairmid']);q([(51,13),(57,13),(63,18),(65,22),(60,20),(56,17)],p['hairmid']);r(39,14,4,1,p['shine'])
            q([(33,16),(39,13),(55,15),(65,21),(64,24),(54,18),(39,17)],'#835344');r(38,15,14,1,'#c79563')
            # Curved saber: large native blade with bevel, notch and braided handle.
            q([(77,30),(84,19),(86,21),(85,43),(82,58),(77,66),(73,62),(77,50)],INK)
            q([(79,32),(83,24),(83,43),(80,56),(77,60),(76,59),(80,43)],'#94aaa2');q([(82,28),(83,26),(82,44),(80,52),(79,52)],'#e5e3bf')
            q([(72,60),(84,62),(85,65),(71,63)],GOLD);r(75,65,5,18,'#59443a');r(76,65,2,17,'#b18e5c')
            for yy in (68,72,76,80):r(75,yy,5,1,GOLD_LIGHT)
            r(74,81,7,3,GOLD)

def boar(a,d,f):
    r=a.rect;q=a.poly;s=STEP[f];bob=BOB[f]
    # Four independently planted/lifted legs and hoof rims.
    for x,lift in [(26,-max(0,s)//2),(55,-max(0,-s)//2)]:
        q([(x,69),(x+12,69),(x+13,86+lift),(x+15,88+lift),(x+14,91+lift),(x-1,91+lift),(x-2,87+lift)],INK);r(x+1,73,9,12,'#5e6e5d');r(x,86+lift,13,3,'#a69d7a');r(x+2,86+lift,8,1,'#d2c59b')
    with a.at(0,bob):
        q([(15,37),(22,28),(36,23),(57,24),(73,31),(82,45),(81,66),(73,80),(60,86),(33,85),(18,79),(11,65),(10,49)],INK)
        q([(17,39),(25,31),(38,27),(55,28),(70,35),(77,46),(77,64),(70,76),(58,81),(34,80),(22,75),(16,63),(14,49)],'#637560')
        q([(19,43),(26,33),(38,29),(53,30),(62,35),(63,42),(55,46),(26,50)],'#8d9875')
        q([(67,41),(77,46),(77,63),(69,76),(59,80),(56,72),(64,60)],'#405b53')
        q([(18,54),(23,48),(28,52),(28,64),(33,76),(25,74),(19,66)],'#77886a')
        # Coarse bristle clusters and overgrown moss saddle; no blur or texture noise.
        for x,y in [(25,47),(21,56),(31,69),(64,49),(69,61),(54,74)]:
            q([(x,y),(x+2,y-2),(x+5,y),(x+5,y+4),(x+2,y+5)],'#91a17e');r(x+1,y,2,2,'#b5bb8d')
        if d==2:
            q([(25,39),(37,33),(55,33),(68,41),(72,54),(65,69),(52,77),(34,73),(23,61)],'#54775b');q([(28,42),(39,37),(52,37),(60,40),(56,46),(35,48)],'#95aa79');q([(48,72),(53,69),(58,73),(57,81),(52,83),(49,80)],INK);r(51,74,3,6,'#a7ad84')
        else:
            hx=11 if d==1 else 0
            with a.at(hx,0):
                # Curled ears sit above the brow, with a dense face and broad snout.
                q([(22,40),(19,23),(22,17),(28,19),(36,34),(33,42)],INK);q([(23,35),(22,23),(24,21),(28,24),(33,35)],'#a69a79');q([(25,24),(28,28),(29,34),(25,32)],'#d0b78e')
                q([(56,35),(63,18),(68,17),(73,21),(70,38),(64,43)],INK);q([(60,35),(65,22),(68,21),(70,24),(67,36)],'#9b9473');r(65,25,2,9,'#d1b88e')
                q([(23,42),(32,34),(53,34),(65,41),(68,55),(62,67),(49,74),(32,68),(23,58)],'#405b50');q([(27,43),(34,38),(53,38),(62,44),(63,54),(56,64),(44,68),(32,63),(27,55)],'#778969')
                eye_xs=(30,53) if d==0 else (52,)
                for x in eye_xs:
                    q([(x-2,46),(x+2,43),(x+10,45),(x+11,48),(x+2,49)],INK);r(x+3,47,5,4,'#cfa76a');r(x+5,47,2,4,'#302e31');r(x+3,47,1,1,'#f3dfa3')
                q([(33,54),(50,51),(61,56),(63,63),(57,70),(37,70),(27,63),(27,59)],'#8f8868');q([(34,56),(50,54),(58,58),(59,64),(54,67),(36,67),(31,62)],'#c5b390');r(35,57,17,2,'#e5cf9f');r(34,60,5,4,'#576356');r(50,59,5,4,'#576356');r(35,60,2,1,'#354a43');r(52,59,2,1,'#354a43');r(40,68,13,1,'#665e4b')
                q([(26,56),(29,62),(31,66),(32,72),(27,73),(22,68),(19,58),(21,54)],INK);q([(23,57),(26,62),(27,68),(30,70),(27,70),(24,67),(22,59)],'#efe0b4');r(24,62,1,4,'#fff0c7')
                q([(62,58),(68,53),(72,53),(71,62),(66,71),(60,73),(59,68),(63,64)],INK);q([(65,60),(69,56),(68,63),(64,69),(62,70),(62,68)],'#efe0b4');r(67,59,1,4,'#fff0c7')
        # Moss crown/ward chains span the entire body in every direction.
        q([(20,31),(26,24),(36,24),(41,19),(50,24),(58,20),(65,26),(65,34),(54,39),(41,37),(31,41),(23,38)],'#3c634e');q([(24,30),(29,27),(37,27),(40,23),(45,27),(52,28),(57,24),(61,28),(59,32),(49,35),(38,32),(29,37)],'#78986c');q([(29,28),(35,28),(34,32),(27,34)],'#b6c38b');r(44,26,7,3,'#afbb83');r(55,26,3,2,'#ccd099');q([(46,23),(48,15),(51,13),(54,15),(53,24)],'#c6bd83');r(49,16,2,7,'#efdda4')
        q([(23,74),(32,78),(46,80),(62,77),(70,72),(69,76),(62,81),(47,84),(31,82),(22,78)],GOLD);r(34,79,3,2,GOLD_LIGHT);r(57,79,3,2,GOLD_LIGHT);q([(44,79),(51,79),(54,85),(50,89),(44,88),(41,84)],'#584f3e');r(44,81,7,5,GOLD);r(46,82,3,3,'#749a7b')

def guardian(a,d,f):
    r=a.rect;q=a.poly;s=STEP[f];bob=BOB[f]//2
    for x,lift in [(23,-max(0,s)//2),(53,-max(0,-s)//2)]:
        q([(x,66),(x+17,66),(x+18,83+lift),(x+21,87+lift),(x+20,91+lift),(x-4,91+lift),(x-3,83+lift)],INK);q([(x+2,70),(x+14,70),(x+13,83+lift),(x+17,86+lift),(x+16,88+lift),(x,88+lift),(x,80)],'#829581');r(x+2,73,4,8,'#bcc2a2');r(x-1,86+lift,17,2,'#b0bba0');r(x+10,78,2,8,'#4b6b60')
    with a.at(0,bob + 2):
        # Broad upper shell with separate moving stone arms.
        q([(23,33),(34,29),(60,29),(75,36),(73,62),(64,76),(49,81),(30,75),(23,64),(19,45)],INK)
        q([(26,36),(36,32),(59,32),(70,38),(68,62),(61,71),(48,76),(33,71),(28,60),(24,45)],'#6e8879')
        q([(27,36),(36,33),(44,34),(43,46),(36,62),(30,61),(25,45)],'#acb79a');q([(29,38),(33,37),(34,50),(30,55)],'#d0ceb0')
        q([(59,35),(68,40),(66,62),(59,69),(54,66),(58,50)],'#48695f')
        for x,y,flip in [(8,35+s//3,False),(71,34-s//3,True)]:
            q([(x+2,y),(x+13,y-5),(x+20,y),(x+21,y+12),(x+17,y+28),(x+5,y+33),(x-1,y+25),(x-3,y+10)],INK)
            q([(x+4,y+1),(x+12,y-2),(x+17,y+2),(x+17,y+13),(x+13,y+25),(x+6,y+27),(x+2,y+22),(x,y+10)],'#75907e' if flip else '#96a78c')
            q([(x+2,y+4),(x+9,y+1),(x+12,y+3),(x+10,y+12),(x+3,y+14)],'#c0c4a2');r(x+5,y+17,10,2,'#47665c');r(x+5,y+22,2,5,'#566f61');r(x+10,y+22,2,4,'#566f61');r(x+4,y+28,8,2,'#b8bd9b')
            q([(x+12,y+3),(x+13,y+9),(x+10,y+11),(x+12,y+16),(x+10,y+15),(x+8,y+10),(x+11,y+8)],'#405c55')
        q([(28,64),(40,67),(59,66),(69,62),(67,69),(60,73),(39,74),(28,70)],'#524e40');q([(29,64),(40,68),(58,67),(68,63),(67,66),(58,70),(40,71),(29,68)],GOLD);r(34,67,5,2,GOLD_LIGHT);r(57,68,5,1,GOLD_LIGHT)
        if d!=2:
            # Jade inset has an ornamental frame and distinct light planes.
            q([(44,39),(52,39),(58,47),(56,60),(50,66),(42,62),(37,52),(39,44)],'#304e49');q([(44,42),(51,42),(55,48),(53,58),(49,62),(44,59),(40,51)],'#72ad91');q([(44,43),(48,42),(48,58),(45,58),(42,51)],'#c4e4af');q([(49,44),(52,47),(51,57),(49,59)],'#9bd0a1');r(45,47,2,7,'#f0eed0')
        else:
            r(37,39,22,3,'#a9b89a');r(37,42,3,15,'#a9b89a');r(42,54,17,3,'#a9b89a');r(54,43,3,13,'#a9b89a');r(43,45,7,3,'#b9c5a3');r(45,46,3,13,'#b9c5a3')
        # Heavy stone face, chipped crown and inset copper eyebrows.
        q([(28,14),(35,7),(53,5),(65,11),(70,21),(66,35),(57,41),(42,42),(30,36),(24,25)],INK)
        q([(31,15),(37,10),(53,8),(62,13),(66,21),(62,33),(56,38),(43,39),(33,33),(28,24)],'#a4b398')
        q([(32,15),(38,11),(48,10),(47,20),(39,24),(30,23)],'#cfceab');q([(54,11),(62,16),(63,25),(60,32),(55,36),(51,30)],'#657f6e')
        if d==0:
            q([(32,23),(41,22),(44,25),(43,28),(34,27)],'#47675c');r(34,24,7,2,'#c0ebbd');r(35,24,3,1,'#f1f2cd')
            q([(51,24),(55,21),(62,22),(61,27),(53,28)],'#47675c');r(53,24,7,2,'#c0ebbd');r(53,24,3,1,'#f1f2cd');q([(46,25),(49,24),(51,31),(46,33),(43,31)],'#7d937b');r(43,35,13,2,'#506d60')
        elif d==1:
            q([(50,22),(61,22),(64,24),(61,28),(52,28)],'#47675c');r(53,24,9,2,'#c0ebbd');r(56,24,4,1,'#f1f2cd');q([(62,25),(67,30),(64,33),(59,31)],'#7d937b');r(52,35,11,2,'#506d60')
        else:
            q([(36,16),(41,14),(42,20),(40,24),(43,30),(41,34),(39,29),(37,24),(40,20)],'#5b7969');r(47,14,10,2,'#cbd0aa');r(59,20,2,9,'#78917a')
        q([(30,13),(38,9),(56,9),(66,15),(65,18),(55,13),(39,13),(30,17)],GOLD);r(40,10,13,1,GOLD_LIGHT)
        q([(28,10),(29,5),(34,3),(39,6),(38,12),(32,14)],'#456b56');r(30,5,4,4,'#97ac75');r(32,4,3,2,'#c9c995');q([(60,11),(61,4),(66,2),(72,5),(70,12),(65,16)],'#456b56');r(63,5,6,3,'#96ab77');r(67,4,2,2,'#c9c995')
        q([(35,53),(38,57),(35,61),(37,65),(34,63),(32,60),(36,57),(33,54)],'#3f5d52');r(59,55,3,1,'#a2b494');r(60,57,2,3,'#a2b494')

def wisp(a,d,f):
    r=a.rect;q=a.poly;s=[0,2,3,1,-2,-3][f];lift=[0,-2,-3,-1,-2,-1][f]
    with a.at(0,lift):
        # An asymmetric curling flame is a separate silhouette from the solid lantern.
        q([(43+s,6),(48+s,12),(50,23),(60,17),(68+s,12),(67+s,26),(77,29),(83,23),(81,39),(88,48),(84,60),(89,68),(81,75),(69,74),(65,84),(57,88),(47,83),(38,89),(31,82),(25,75),(16,78),(9,71),(14,62),(9,54),(13,42),(20,38),(17,29),(26,33),(32,28),(32,18),(37,23)],'#4b3c4a')
        q([(43+s,11),(47+s,21),(47,30),(58,27),(64+s,19),(62,32),(75,36),(79,31),(77,42),(83,49),(80,60),(83,67),(77,71),(67,68),(62,80),(56,83),(48,78),(39,84),(34,77),(28,70),(18,73),(14,70),(19,60),(14,54),(18,45),(26,44),(24,36),(31,38),(37,32),(36,26),(40,29)],'#945557')
        q([(43,20),(44,33),(55,33),(62,28),(60,38),(71,41),(77,50),(73,59),(76,64),(66,63),(57,76),(48,74),(40,78),(37,71),(29,65),(22,67),(25,56),(20,52),(29,48),(30,43),(38,42)],'#cb8461')
        q([(43,31),(46,39),(57,39),(66,45),(68,54),(61,63),(55,67),(46,69),(37,64),(31,56),(34,47)],'#eab77b')
        q([(45,40),(55,41),(61,48),(59,58),(51,63),(41,59),(37,51)],'#f3d998')
        # Brass-and-cedar frame, paper panels, ritual seal and chain tassel.
        r(45,15,4,9,'#596252');r(43,13,8,3,GOLD);r(43,14,3,1,GOLD_LIGHT);r(44,22,6,3,'#8b7752')
        q([(29,28),(35,23),(58,23),(67,28),(64,33),(31,33)],'#513e3c');q([(31,28),(36,25),(57,25),(64,28),(62,30),(33,30)],GOLD);r(36,25,18,1,GOLD_LIGHT)
        q([(31,32),(64,32),(66,64),(61,70),(35,70),(29,65)],'#684a41');q([(34,33),(60,33),(62,62),(58,67),(36,67),(32,63)],'#c79a6c')
        r(36,34,22,28,'#e4c490' if d!=2 else '#c3a174');r(37,36,17,23,'#f4dfac');r(39,37,10,2,'#fff0c6');r(36,62,24,2,'#dfb579')
        r(32,33,3,30,'#835440');r(60,33,3,30,'#835440');r(46,33,2,30,'#a26d49');r(35,43,25,2,'#b98b60');r(35,56,25,2,'#b98b60')
        if d!=2:
            q([(41,38),(52,38),(54,60),(42,61)],'#eee3bd');r(43,39,8,1,'#b97655');r(45,41,2,5,'#a56450');r(47,44,4,2,'#a56450');r(44,47,8,2,'#a56450');r(49,48,2,5,'#a56450');r(44,52,6,2,'#a56450');r(46,54,2,4,'#a56450')
        else:r(39,39,16,2,'#ccb37c');r(39,59,17,2,'#ccb37c');r(39,43,2,12,'#ccb37c');r(54,43,2,12,'#ccb37c')
        if d==1:
            # The profile shows a beveled dark side panel and a narrower forward seal.
            q([(54,34),(60,34),(62,62),(54,65)],'#a97954');r(54,34,2,30,'#73503e');r(57,37,2,23,'#cfab76')
            q([(42,38),(51,39),(52,60),(43,61)],'#eee3bd');r(45,41,2,6,'#a56450');r(44,47,6,2,'#a56450');r(48,48,2,6,'#a56450');r(45,53,5,2,'#a56450');r(46,55,2,3,'#a56450')
        q([(28,64),(66,64),(67,67),(62,71),(34,71),(28,68)],'#65483e');r(31,65,33,2,GOLD);r(34,65,26,1,GOLD_LIGHT);r(44,71,7,3,GOLD);r(47,74,2,8,'#927150');q([(46,81),(50,81),(53+s,89),(48+s,91),(44+s,89)],'#c48b60');r(47+s,84,1,5,'#f0c389')
        # Detached embers follow the six-pose silhouette rhythm.
        r(19+s,24,3,5,'#e1a36c');r(76-s,76,3,4,'#e1a36c');r(12,48+s,2,3,'#f0cc87');r(67+s,7,2,4,'#c98a66')

ASSETS=[('characters',f'disciple-{i}',lambda a,d,f,i=i:disciple(a,i,d,f)) for i in range(4)]+[
    ('enemies','ridge-raider',lambda a,d,f:enemy_human(a,d,f,False)),
    ('enemies','venom-adept',lambda a,d,f:enemy_human(a,d,f,True)),
    ('enemies','moss-boar',boar),('enemies','ruin-guardian',guardian),('enemies','ember-wisp',wisp)]

def rasterize(source,target,antialias=0):
    subprocess.run(['inkscape',str(source),'--export-type=png',f'--export-png-antialias={antialias}',f'--export-filename={target}'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,env=os.environ|{'XDG_CONFIG_HOME':'/tmp/native96-art-config','XDG_CACHE_HOME':'/tmp/native96-art-cache'})

def proof():
    # Proofs embed the runtime PNG bytes, so a source/export mismatch cannot hide here.
    a=Art(1080,824);r=a.rect
    r(0,0,1080,824,'#eee2c4');a.text(30,34,'SHANMEN CHANGMING / NATIVE 96 PX REDRAW',21);a.text(30,59,'Actual runtime PNGs · integer source grid · front / side / back · 6 poses each',13)
    for i,(group,slug,_) in enumerate(ASSETS):
        col=i%3;row=i//3;x=22+col*352;y=83+row*244
        r(x,y,336,226,'#d9d2b3');a.text(x+12,y+23,slug.upper(),14)
        for d in range(3):
            # Clipping shows frame0 from each direction of the shipped sheet, at 1x.
            clip=f'clip{i}-{d}';xx=x+18+d*102;yy=y+36
            a.parts.append(f'<defs><clipPath id="{clip}"><rect x="{xx}" y="{yy}" width="96" height="96"/></clipPath></defs>')
            encoded=base64.b64encode((ROOT/f'public/assets/{group}/{slug}-sheet-{VERSION}.png').read_bytes()).decode()
            for tx in range(0,96,12):
                for ty in range(0,96,12):
                    if (tx//12+ty//12)%2:r(xx+tx,yy+ty,12,12,'#c9c5a8')
            a.parts.append(f'<image href="data:image/png;base64,{encoded}" x="{xx}" y="{yy-d*96}" width="576" height="288" image-rendering="pixelated" clip-path="url(#{clip})"/>')
        # All front walk frames, 0.5x contact size for silhouette rhythm.
        encoded=base64.b64encode((ROOT/f'public/assets/{group}/{slug}-sheet-{VERSION}.png').read_bytes()).decode()
        clip=f'walk{i}';xx=x+18;yy=y+151
        a.parts.append(f'<defs><clipPath id="{clip}"><rect x="{xx}" y="{yy}" width="288" height="48"/></clipPath></defs>')
        a.parts.append(f'<image href="data:image/png;base64,{encoded}" x="{xx}" y="{yy}" width="288" height="144" image-rendering="pixelated" clip-path="url(#{clip})"/>')
        a.text(x+18,y+218,'Native 96×96 frames / 576×288 sheet',11)
    a.text(30,816,'Static art proof. Browser animation, camera fit and input review remain separate acceptance checks.',11)
    path=SOURCE/'characters/contact-sheet-96-v2.svg';a.save(path);rasterize(path,path.with_suffix('.png'),2)
    # Equal-height before/after: old art at 1.5x vs new art at native 1x.
    b=Art(1056,370);b.rect(0,0,1056,370,'#eee2c4');b.text(24,32,'96 PX REDRAW / SAME DISPLAY HEIGHT COMPARISON',20);b.text(24,55,'Left: previous 48×64 at 1.5×. Right: native 96×96. Portrait illustrations remain unchanged.',13)
    for i,(group,slug,_) in enumerate(ASSETS):
        x=20+(i%5)*206;y=80+(i//5)*142
        b.rect(x,y,194,130,'#d4cdae');b.text(x+9,y+18,slug,12)
        old=(ROOT/f'public/assets/{group}/{slug}.png').read_bytes();new=(ROOT/f'public/assets/{group}/{slug}-{VERSION}.png').read_bytes()
        for data,xx,w,h in [(old,x+12,72,96),(new,x+91,96,96)]:
            b.parts.append(f'<image href="data:image/png;base64,{base64.b64encode(data).decode()}" x="{xx}" y="{y+25}" width="{w}" height="{h}" image-rendering="pixelated"/>')
    path=SOURCE/'characters/before-after-96-v2.svg';b.save(path);rasterize(path,path.with_suffix('.png'),2)

def scale_proof():
    a=Art(900,330);a.rect(0,0,900,330,'#e8ddbd');a.text(24,32,'WORLD DISPLAY SCALE / ACTUAL RUNTIME PNGs',19)
    a.text(24,56,'Character 0.86× · building 0.86× · shown before camera / CSS fitting',13)
    a.rect(20,76,860,220,'#849780')
    for x in range(24,878,64):a.rect(x,249,60,2,'#b8bea0')
    def put(path,x,y,w,h):
        encoded=base64.b64encode(path.read_bytes()).decode()
        a.parts.append(f'<image href="data:image/png;base64,{encoded}" x="{x}" y="{y}" width="{w}" height="{h}" image-rendering="pixelated"/>')
    for i,building in enumerate(['housing','kitchen','workshop','storage']):
        x=55+i*213
        put(ROOT/f'public/assets/environment/{building}.png',x,104,123.84,123.84)
        put(ROOT/f'public/assets/characters/disciple-{i}-96-v2.png',x+47,220-91*.86,82.56,82.56)
        a.text(x+17,277,building.upper(),12)
    a.text(24,317,'Static composition check only. Pixel camera filtering, real overlap and animation require browser review.',12)
    path=SOURCE/'characters/world-scale-96-v2.svg';a.save(path);rasterize(path,path.with_suffix('.png'),2)

def main():
    for group,slug,draw in ASSETS:
        for suffix,w,h in [('',96,96),('-sheet',576,288)]:
            a=Art(w,h)
            for d in range(3 if suffix else 1):
                for f in range(6 if suffix else 1):
                    with a.at(96*f,96*d):draw(a,d,f)
            source=SOURCE/group/f'{slug}{suffix}-{VERSION}.svg';a.save(source)
            rasterize(source,ROOT/f'public/assets/{group}/{slug}{suffix}-{VERSION}.png')
    proof()
    scale_proof()
    records=[]
    for group,slug,_ in ASSETS:
        for suffix in ('','-sheet'):
            path=ROOT/f'public/assets/{group}/{slug}{suffix}-{VERSION}.png';data=path.read_bytes();w,h=struct.unpack('>II',data[16:24]);records.append(dict(path=str(path.relative_to(ROOT)),width=w,height=h,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
    (SOURCE/'characters/asset-manifest-96-v2.json').write_text(json.dumps(dict(version=VERSION,author='Original project-owned, direct SVG integer-grid authorship',source='assets-source/generate-96-art.py',created='2026-10-01',externalAssets=False,frame=dict(width=96,height=96,columns=6,rows=3,anchor=[48,91],directions=['front','right','back']),files=records),indent=2)+'\n')
    print(f'Generated {len(records)} native runtime PNGs plus contact proofs; portraits untouched.')
if __name__=='__main__':main()
