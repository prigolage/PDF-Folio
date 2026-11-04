import sys
from fontTools.ttLib import TTCollection, TTFont, newTable
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

def ranges(spec):
    out=set()
    for a,b in spec: out.update(range(a,b+1))
    return out
CORE=[(0x20,0x7E),(0xA0,0x24F),(0x250,0x2AF),(0x2B0,0x2FF),(0x370,0x3FF),(0x400,0x4FF),(0x1E00,0x1EFF),(0x2000,0x206F),(0x2070,0x209F),(0x20A0,0x20CF),
      (0x2100,0x214F),(0x2150,0x218F),(0x2190,0x21FF),(0x2200,0x22FF),(0x2300,0x23FF),(0x2460,0x24FF),(0x2500,0x257F),(0x25A0,0x25FF),(0x2600,0x26FF),(0x2700,0x27BF),
      (0x3000,0x303F),(0x3040,0x309F),(0x30A0,0x30FF),(0x3130,0x318F),(0x1100,0x11FF),(0x3200,0x32FF),(0x3300,0x33FF),(0xAC00,0xD7A3),(0xFF00,0xFFEF)]
CJK=[(0x20,0x7E),(0x3400,0x4DBF),(0x4E00,0x9FFF),(0xF900,0xFAFF)]

def build(src_idx, ttc, uni, out):
    f=TTCollection(ttc).fonts[src_idx]
    opts=subset.Options(); opts.layout_features=[]; opts.hinting=False; opts.name_IDs=['*']; opts.notdef_outline=True; opts.drop_tables+=['GSUB','GPOS','GDEF','BASE','VORG','vmtx','vhea','DSIG']
    s=subset.Subsetter(opts); s.populate(unicodes=uni); s.subset(f)
    # CFF -> glyf
    go=f.getGlyphOrder(); gs=f.getGlyphSet()
    glyf={}
    for name in go:
        pen=TTGlyphPen(gs); gs[name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True)); glyf[name]=pen.glyph()
    del f['CFF ']
    f['glyf']=newTable('glyf'); f['glyf'].glyphOrder=go; f['glyf'].glyphs=glyf
    f['loca']=newTable('loca')
    f['maxp']=newTable('maxp'); m=f['maxp']; m.tableVersion=0x00010000; m.numGlyphs=len(go)
    for k in ['maxZones','maxTwilightPoints','maxStorage','maxFunctionDefs','maxInstructionDefs','maxStackElements','maxSizeOfInstructions','maxComponentElements','maxPoints','maxContours','maxCompositePoints','maxCompositeContours','maxComponentDepth']: setattr(m,k,0)
    m.maxZones=1
    f['head'].indexToLocFormat=1; f['head'].glyphDataFormat=0
    f['post'].formatType=3.0
    f.sfntVersion='\x00\x01\x00\x00'
    f.save(out)
    import os; print(out, len(go), os.path.getsize(out))

R='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; B='/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
which=sys.argv[1]
if which=='core':
    build(1,R,ranges(CORE),'uni-regular.ttf'); build(1,B,ranges(CORE),'uni-bold.ttf')
else:
    build(1,R,ranges(CJK),'cjk-regular.ttf'); build(1,B,ranges(CJK),'cjk-bold.ttf')
