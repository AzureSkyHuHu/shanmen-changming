"""Original authored SVG pixel assets. Standard-library only; no third-party art/fonts.
Run from this directory to reproduce the checked-in sprite strips and scene pieces.
"""
from pathlib import Path
ROOT = Path(__file__).parent
def fill(c):
    return f'fill="{c[:7]}" fill-opacity="{int(c[7:],16)/255:.3f}"' if len(c)==9 else f'fill="{c}"'
class Art:
    def __init__(self, w, h): self.w=w; self.h=h; self.parts=[]
    def rect(self,x,y,w,h,c):
        if w>0 and h>0: self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" {fill(c)}/>')
    def poly(self,points,c): self.parts.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in points)}" {fill(c)}/>')
    def group(self,x,y,fn): self.parts.append(f'<g transform="translate({x} {y})">'); fn(); self.parts.append('</g>')
    def save(self,path):
        (ROOT/path).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" shape-rendering="crispEdges">'+''.join(self.parts)+'</svg>\n')
PALETTES=[
    dict(robe='#c29a59', light='#efd38c', mid='#d8b571', dark='#856842', trim='#fff0c2', hair='#483b36', shine='#75614b', accent='#829b75'),
    dict(robe='#4d989d', light='#a3d4c4', mid='#74b5b1', dark='#32666f', trim='#e1eddb', hair='#263e49', shine='#47606c', accent='#d9bd75'),
    dict(robe='#af6e62', light='#e9b893', mid='#cf9278', dark='#794b4b', trim='#f4e1bd', hair='#343740', shine='#565260', accent='#cbaa65'),
    dict(robe='#8c80ae', light='#cdc3db', mid='#ada0c6', dark='#625878', trim='#f0e9da', hair='#c2cbd0', shine='#eef0de', accent='#b6ceaf'),
]

def character(a,index,direction=0,frame=0):
    p=PALETTES[index]; r=a.rect; q=a.poly
    if index==0: a.parts.append('<g transform="translate(3 6) scale(.88 .9)">')
    step=[0,1,2,0,-1,-2][frame]; bob=-1 if frame in (1,2,4,5) else 0
    # Boots, trouser cuffs and independently stepped soles.
    r(16,53,7,7,'#d3d4c1'); r(27,53,7,7,'#bec8ba')
    r(15,58+max(0,step),9,3,'#273b43'); r(26,58+max(0,-step),9,3,'#273b43')
    r(15,58+max(0,step),8,1,'#63777b'); r(26,58+max(0,-step),8,1,'#63777b')
    def body():
        # Equipment remains attached through all poses.
        if index==2:
            q([(7,21),(11,20),(13,53),(9,55)],'#273e49'); r(8,23,2,28,'#6b8591'); r(7,26,5,2,p['accent']); r(8,46,5,2,p['accent']); r(4,20,12,3,p['accent']); r(8,13,3,8,'#665345'); r(8,13,3,2,'#ddc295')
        if index==3:
            r(7,28,3,33,'#6c5142'); r(6,28,5,3,'#9c7958'); r(6,23,5,6,'#405953'); r(7,22,3,6,'#a5cbb3')
        # Long robe with a shaped, outlined silhouette and multi-tone folds.
        q([(17,31),(31,31),(36,36),(35,45),(39,55),(32,57),(26,55),(19,57),(11,55),(14,44),(13,37)],'#2d4247')
        q([(18,32),(30,32),(34,37),(32,44),(36,54),(29,55),(24,54),(18,55),(14,54),(17,43),(15,37)],p['robe'])
        q([(18,34),(23,36),(22,52),(18,54),(16,53),(18,44)],p['light'])
        q([(29,35),(32,38),(30,44),(34,53),(29,54),(27,46)],p['dark'])
        r(23,44,3,10,p['mid']); r(16,52,6,2,p['mid']); r(29,52,5,2,p['mid'])
        if index==2:
            q([(13,32),(18,33),(17,42),(9,43),(7,39),(10,34)],p['dark']); q([(30,32),(35,33),(40,39),(38,43),(32,41)],p['dark']); r(11,34,5,2,p['accent']); r(33,34,4,2,p['accent'])
        # Sleeves and hands counter-swing against the legs.
        left=step//2; right=-step//2
        q([(15,34+left),(18,38+left),(14,47+left),(9,46+left),(10,38+left)],p['dark'])
        q([(14,35+left),(16,38+left),(13,44+left),(10,44+left),(11,38+left)],p['mid'])
        r(9,44+left,5,2,p['trim']); r(10,46+left,3,3,'#dfad8a'); r(11,46+left,2,2,'#f3ceb0')
        q([(32,34+right),(36,36+right),(40,43+right),(37,47+right),(32,44+right)],p['dark'])
        q([(33,35+right),(35,37+right),(38,43+right),(36,45+right),(33,43+right)],p['mid'])
        r(35,44+right,4,2,p['trim']); r(36,46+right,3,3,'#dfad8a')
        if index==1:
            q([(9,39),(15,39),(15,52),(12,55),(7,51)],p['dark']); q([(10,40),(13,40),(13,51),(9,50)],p['light']); r(8,50,6,2,p['trim']); q([(35,40),(39,40),(42,51),(38,55),(35,51)],p['dark']); r(36,42,3,9,p['mid']); r(36,51,5,2,p['trim'])
        # Cross-collar, belt, stitched hems, jade knot and tassel.
        q([(19,31),(24,36),(30,31),(30,34),(24,41),(18,34)],p['trim'])
        q([(27,33),(29,33),(22,41),(21,39)],'#f8edd2')
        r(15,42,19,3,p['dark']); r(16,42,17,1,p['accent']); r(22,42,5,3,p['trim']); r(24,44,2,7,p['accent']); r(23,49,4,2,p['accent'])
        r(15,53,7,1,p['trim']); r(29,53,5,1,p['trim'])
        if index==0: r(31,44,5,7,'#506b60'); r(32,45,3,5,'#e0d8b4'); r(33,45,1,5,'#a09267')
        if index==1: r(31,46,3,4,'#325960'); r(31,45,3,3,'#b8dbb1'); r(32,49,1,4,p['accent'])
        # Hair silhouette / ears / carefully stepped face, not an oversized square.
        q([(18,9),(29,9),(34,12),(37,18),(36,28),(32,34),(15,33),(11,28),(11,18),(14,12)],'#293842' if index!=3 else '#72838c')
        q([(18,10),(29,10),(33,13),(35,18),(34,27),(31,32),(16,31),(13,27),(13,18),(15,13)],p['hair'])
        r(12,23,3,5,'#c88f76'); r(34,23,3,5,'#c88f76')
        if direction!=2:
            q([(18,16),(30,16),(33,20),(33,28),(30,32),(21,33),(17,30),(16,22)],'#dba27e')
            q([(18,17),(29,17),(32,20),(31,28),(28,31),(21,31),(18,28)],'#f1c9a4')
            r(19,20,10,7,'#f8d7b6'); r(19,27,3,2,'#e9ae91'); r(29,27,3,2,'#e7ac8c'); r(25,27,1,2,'#d49b7d'); r(24,30,4,1,'#c78c79')
            if direction==0:
                r(18,22,5,1,'#816149'); r(28,22,5,1,'#816149'); r(19,23,4,4,'#fcf0cf'); r(28,23,4,4,'#fcf0cf'); r(21,23,2,4,'#33444a'); r(28,23,2,4,'#33444a'); r(21,23,1,1,'#f9f3de'); r(28,23,1,1,'#f9f3de')
            else:
                r(29,23,4,1,'#684d42'); r(30,24,3,3,'#faf0ce'); r(31,24,2,3,'#33444a'); r(31,24,1,1,'#fff6da'); r(33,26,2,2,'#edbb94')
            # Swept bangs, side locks, hair gloss clusters.
            q([(16,12),(30,12),(34,16),(33,21),(29,18),(27,20),(23,15),(20,19),(16,21),(14,23),(14,16)],p['hair'])
            q([(17,13),(23,11),(30,13),(32,15),(25,14),(21,16),(17,17)],p['shine'])
            r(14,20,3,10,p['hair']); r(15,21,1,7,p['shine']); r(33,19,2,12,p['hair'])
            if index==2:
                r(18,22,5,2,'#4b4542'); r(28,22,5,2,'#4b4542'); r(21,30,2,1,'#937662'); r(25,31,4,1,'#937662'); r(30,29,1,2,'#937662')
            if index==3:
                r(18,21,5,1,'#d0cbb6'); r(28,21,5,1,'#d0cbb6'); r(18,27,2,1,'#bd8f79'); r(31,27,2,1,'#bd8f79'); r(19,28,2,1,'#c69485'); r(30,28,2,1,'#c69485'); r(22,30,2,1,'#cb9580'); r(27,30,2,1,'#cb9580'); r(15,22,1,8,'#eff0de')
        else:
            q([(17,13),(24,11),(31,13),(34,18),(32,29),(30,34),(19,34),(15,29),(14,19)],p['hair'])
            q([(18,14),(23,12),(27,13),(25,16),(18,18)],p['shine']); r(18,20,2,8,p['shine']); r(30,20,1,10,p['shine'])
            r(21,31,8,13,p['hair']); r(23,32,2,10,p['shine']); r(20,29,10,3,p['accent'])
        # Four recognisable silhouettes: novice ribbon, jade hairpin, tied ponytail, sage crown.
        if index==0:
            r(20,5,10,7,'#36413f'); r(21,4,7,6,p['hair']); r(21,5,3,2,p['shine']); r(18,9,15,2,p['accent']); r(30,11,3,9,p['accent'])
        elif index==1:
            r(20,4,9,7,p['hair']); r(21,3,6,5,p['shine']); r(16,8,17,2,p['accent']); r(31,7,6,4,'#f0d48c'); r(33,5,2,8,'#f3df9e'); r(32,8,4,3,'#b7dbb8'); r(35,11,1,12,p['accent']); r(34,20,3,4,'#b7dbb8'); r(35,24,1,4,p['accent'])
        elif index==2:
            r(22,4,8,7,p['hair']); r(23,5,3,3,p['shine']); r(19,9,14,2,p['accent']); q([(31,9),(35,11),(40,17),(41,29),(37,37),(33,34),(35,25),(34,18)],p['hair']); r(36,14,2,12,p['shine']); r(37,27,1,6,p['shine'])
        else:
            r(20,3,10,9,'#75848d'); r(22,4,6,7,p['hair']); r(19,8,12,3,p['accent']); r(23,6,4,2,'#eff0dc')
    a.group(-1 if index==3 else 0,bob+2 if index==3 else bob,body)
    if index==0: a.parts.append('</g>')

for index in range(4):
    a=Art(48*6,64*3)
    for direction in range(3):
        for frame in range(6): a.group(frame*48,direction*64,lambda d=direction,f=frame:character(a,index,d,f))
    a.save(Path('characters')/f'disciple-{index}-sheet.svg')
    portrait=Art(48,64); character(portrait,index); portrait.save(Path('characters')/f'disciple-{index}.svg')

# Environment assets share a consistent top-down 3/4 projection, 2px clusters and warm upper-left light.
def lantern(a,x,y):
    a.rect(x+3,y-4,2,5,'#5a5140'); a.rect(x,y,9,12,'#784733'); a.rect(x+1,y+1,7,9,'#db9459'); a.rect(x+2,y+2,3,7,'#f2cc83'); a.rect(x+4,y+12,1,5,'#bc8050')
def crate(a,x,y,w=20,h=17):
    a.rect(x,y,w,h,'#655745'); a.rect(x+2,y+2,w-4,h-4,'#ad8958'); a.rect(x+3,y+3,w-6,2,'#d5b575'); a.rect(x+2,y+h-5,w-4,2,'#7d6146'); a.rect(x+4,y,2,h,'#dbc08a'); a.rect(x+w-6,y,2,h,'#806748')
def tree(a,x,y,scale=1,pink=False):
    colors=['#334f48','#426957','#578567','#74a172','#99b883'] if not pink else ['#7f5d70','#ad7888','#cc94a0','#e6b3b2','#f2cebf']
    def draw():
        a.rect(x-3,y-29,7,34,'#5d5146'); a.rect(x-1,y-27,3,32,'#93816a'); a.rect(x-11,y-7,24,8,'#476752')
        for dx,dy,w,h,c in [(-25,-42,35,14,0),(-14,-55,39,17,1),(-30,-30,47,13,0),(1,-39,29,18,1),(-20,-43,41,15,2),(-13,-55,28,12,3),(-24,-32,21,9,2),(3,-39,22,10,3),(-10,-54,14,5,4),(-21,-40,10,4,4),(13,-36,7,3,4)]: a.rect(x+dx,y+dy,w,h,colors[c])
        for dx,dy in [(-15,-48),(3,-51),(-25,-30),(11,-30),(21,-26),(-7,-37),(4,-23)]:
            a.rect(x+dx,y+dy,3,2,colors[4]); a.rect(x+dx-2,y+dy+2,4,2,colors[3])
        a.rect(x-4,y-22,2,7,'#8a765b'); a.rect(x+3,y-15,4,2,'#655543')
    if scale==1: draw()
    else:
        a.parts.append(f'<g transform="translate({x} {y}) scale({scale}) translate({-x} {-y})">'); draw(); a.parts.append('</g>')

def building(kind):
    a=Art(144,144); r=a.rect;q=a.poly
    q([(12,111),(124,111),(136,118),(128,128),(18,130),(5,122)],'#364e4359')
    if kind in ['housing','kitchen','workshop','storage']:
        # Masonry foundations and steps.
        r(23,100,101,21,'#566c68'); r(19,111,105,9,'#849489');r(22,111,99,3,'#b8b9a0');r(21,121,105,3,'#455d57')
        for x in range(26,117,18): r(x,116,1,5,'#5f756d')
        r(29,57,87,52,'#6b6851');r(32,60,80,47,'#cbbd91');r(34,63,74,35,'#e3d3aa');r(34,100,75,5,'#aa9a77')
        # Small plaster patches and bamboo timber.
        r(35,67,14,2,'#eee0b5');r(93,94,13,2,'#b8aa82');r(30,58,6,52,'#705541');r(33,60,2,43,'#bc966a');r(107,59,6,51,'#705541');r(108,59,2,48,'#b08b60')
        r(61,76,24,34,'#4a534b');r(63,78,20,30,'#755f49');r(66,79,2,26,'#9c8056');r(75,79,2,26,'#9c8056');r(74,92,2,3,'#d4b876')
        # Paper lattice windows.
        for x in [40,88]:
            r(x,74,15,17,'#715b43');r(x+2,76,11,12,'#c5bf94');r(x+3,77,5,5,'#efe3ab');r(x+7,75,2,15,'#91784f');r(x+1,81,14,2,'#91784f');r(x-1,91,17,3,'#90724e')
        # Deep eaves with raised corners and layered tiled roof.
        q([(10,55),(17,46),(23,46),(34,41),(109,41),(121,46),(127,44),(134,38),(133,58),(124,64),(19,65),(10,61)],'#2b464b')
        q([(13,53),(24,50),(37,36),(46,25),(95,25),(106,37),(120,50),(132,48),(129,56),(120,61),(23,61),(14,58)],'#3e686b')
        q([(25,49),(38,33),(48,24),(93,24),(108,41),(119,52),(26,53)],'#527e7d')
        q([(40,32),(48,23),(93,23),(101,32)],'#7fa299'); r(46,22,51,3,'#a9bdaa')
        for row,span in [(33,(38,103)),(39,(32,110)),(45,(25,117)),(51,(18,125))]:
            r(span[0],row,span[1]-span[0],2,'#31545a')
            for x in range(span[0]+3,span[1]-2,8): r(x,row-4,2,4,'#739892');r(x+2,row-3,1,3,'#3f676b')
        r(20,56,106,3,'#7c9f92');r(22,60,102,3,'#263f46');r(28,64,88,3,'#9c8055');r(29,67,87,2,'#795f45')
        r(42,23,7,4,'#3b6263');r(94,22,8,5,'#3b6263');r(43,21,5,2,'#bbcaad');r(96,20,5,2,'#bbcaad')
        # Hanging wooden sign with painted non-letter ornament.
        r(59,64,25,8,'#5e5141');r(60,65,23,5,'#b39161');r(65,67,12,1,'#e4d3a1')
        lantern(a,25,74);lantern(a,113,74)
        r(58,111,31,5,'#a4ad96');r(55,116,38,4,'#c8c6a4')
        if kind=='housing':
            tree(a,12,105,pink=True);r(100,109,13,8,'#7a644f');r(99,104,15,6,'#718968');r(103,100,6,8,'#a9b988')
        elif kind=='kitchen':
            r(101,21,10,21,'#6c6c62');r(100,20,13,4,'#999885');r(103,25,2,12,'#b8ac8d');r(12,105,18,11,'#5e5d4d');r(14,101,14,5,'#aab4a0');r(16,99,10,2,'#d7d3af');r(118,99,15,18,'#866144');r(120,100,11,5,'#c79764');r(121,98,9,3,'#e1c993')
        elif kind=='workshop':
            r(7,107,30,5,'#b69662');r(10,112,4,12,'#70543d');r(29,112,4,12,'#70543d');r(14,101,18,6,'#586d70');r(19,98,11,3,'#9ba69b');crate(a,110,105,22,17)
        else:
            crate(a,7,102,22,19);crate(a,110,100,23,22);crate(a,117,86,17,15);r(40,98,14,12,'#b7a073');r(42,96,10,5,'#d6be89');r(46,94,3,4,'#716649')
    elif kind=='herb-garden':
        r(20,65,100,54,'#6b7050');r(18,64,104,4,'#b0a77b');r(18,117,104,5,'#b0a77b');r(18,64,4,55,'#928664');r(118,64,4,55,'#928664')
        for row in range(3):
            y=72+row*15;r(25,y,90,10,'#765b47');r(25,y,90,2,'#92754f')
            for x in range(31,113,15):
                r(x,y-6,3,13,'#567d50');q([(x+1,y),(x-5,y-5),(x-5,y-8),(x,y-5),(x+1,y-2)],'#8cad6f');q([(x+2,y+2),(x+8,y-4),(x+8,y-7),(x+3,y-4)],'#729861');r(x-1,y-8,6,4,'#b29ec0' if row!=1 else '#d8be8b');r(x,y-9,3,3,'#e0c5d2' if row!=1 else '#eee1af')
        r(18,33,5,36,'#765e44');r(116,33,5,36,'#765e44');r(14,32,112,5,'#987c50');r(16,29,108,3,'#c6b381');r(25,37,88,3,'#506d49')
        for x in range(22,122,14): r(x,26,8,8,'#709362');r(x+2,22,8,7,'#9bb576')
        r(7,102,9,18,'#866a4e');r(6,105,11,2,'#cfb181');r(127,108,10,10,'#809996');r(127,106,8,3,'#b1c9bb')
    elif kind=='forest':
        tree(a,49,109);tree(a,93,108);tree(a,74,89,pink=False)
        for x,y in [(24,109),(31,118),(57,115)]:
            r(x,y,23,8,'#77604a');r(x+2,y,18,2,'#ac8b5e');r(x+22,y+1,4,6,'#d4b47b');r(x+23,y+2,2,3,'#987449')
        r(101,111,4,13,'#785d43');r(97,107,14,5,'#9a8766');r(99,105,10,3,'#d0bd8a')
    elif kind=='mine':
        q([(12,117),(16,77),(31,59),(47,48),(86,43),(113,61),(128,83),(133,119)],'#516b68');q([(19,105),(23,75),(48,53),(84,49),(103,62),(116,100)],'#7f9285');q([(25,74),(47,53),(70,51),(63,68),(43,78)],'#b3b6a0');q([(93,59),(110,74),(120,108),(101,102),(88,79)],'#607c76')
        r(45,82,53,36,'#2c4346');r(39,76,7,44,'#735b44');r(96,76,7,44,'#735b44');r(36,74,70,8,'#a1855b');r(37,74,67,2,'#d5b583');r(42,82,2,33,'#bd9b69');r(98,82,2,33,'#bd9b69');r(51,116,3,14,'#8d8b73');r(86,116,3,14,'#8d8b73')
        lantern(a,108,90);crate(a,12,111,24,14);q([(110,113),(118,105),(125,110),(127,119),(111,121)],'#c2c1a4')
    else:
        q([(22,105),(71,88),(122,105),(118,119),(70,134),(24,119)],'#506f69');q([(26,103),(71,88),(119,103),(72,122)],'#b9c7af');q([(31,102),(71,90),(113,102),(71,116)],'#7daba1');r(68,90,5,28,'#d5e6c4')
        q([(54,84),(62,49),(76,31),(90,60),(86,99),(69,106)],'#3f8288');q([(62,49),(76,31),(73,93),(69,106),(59,89)],'#9cd8cc');q([(76,34),(87,60),(80,87),(74,94)],'#dcf0d5');r(72,48,3,28,'#f1f4d9')
        for x,y in [(35,96),(102,94)]:r(x,y,9,14,'#556e66');r(x-3,y-4,15,6,'#a7bfa6');r(x+2,y-6,5,3,'#dfd2a0')
    a.save(Path('environment')/f'{kind}.svg')
for kind in ['housing','kitchen','workshop','storage','herb-garden','forest','mine','spirit-vein']: building(kind)
# Reusable border vegetation in clear, high-density pixels.
for kind,pink in [('pine',False),('blossom',True)]:
    a=Art(96,96);tree(a,48,85,pink=pink);a.save(Path('environment')/f'{kind}.svg')
