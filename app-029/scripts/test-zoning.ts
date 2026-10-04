import {
  planZoning,
  diffZoning,
  toSnapshot,
  defaultZoneCfg,
  strategyLabel,
  r2,
  type ZoningResult
} from '../src/logic/zoning'
import type { PlacedChar } from '../src/logic/layout'
import type { GlyphGeom } from '../src/logic/glyphAnalysis'
import type { LedCfg, ZoneCfg } from '../src/logic/types'
import { emptySamples } from '../src/logic/geometry'

const preset = {
  usableRatio: 0.8,
  maxDropV: 0.6,
  resistivity: 0.02,
  feederMm: 300,
  wirePriceCentsPerM: 320,
  spec: 'RVV',
  gauges: [
    { mm2: 0.5, spec: '0.5', ampacityA: 3 },
    { mm2: 0.75, spec: '0.75', ampacityA: 6 },
    { mm2: 1.0, spec: '1.0', ampacityA: 10 },
    { mm2: 1.5, spec: '1.5', ampacityA: 15 },
    { mm2: 2.5, spec: '2.5', ampacityA: 24 }
  ]
}

let fails = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    fails++
    console.log('FAIL:', msg)
  } else console.log('PASS:', msg)
}

// 造一个字形 geom：nBlocks 个块，每块外轮廓 perimeter 单位（本地单位），inkW=1000 使 k=sizeMm/1000
function makeGeom(char: string, blocks: number, perimeter: number): GlyphGeom {
  const rings: GlyphGeom['rings'] = []
  const blockBBoxes: GlyphGeom['blockBBoxes'] = []
  for (let b = 0; b < blocks; b++) {
    rings.push({
      ring: [
        { x: b * 100, y: 0 },
        { x: b * 100 + 50, y: 0 },
        { x: b * 100 + 50, y: 50 },
        { x: b * 100, y: 50 }
      ],
      area: 2500,
      perimeter,
      isHole: false,
      depth: 0,
      block: b,
      bbox: { x0: b * 100, y0: 0, x1: b * 100 + 50, y1: 50 },
      pathData: '',
      minStroke: 30,
      minStrokePoint: null
    })
    blockBBoxes.push({ x0: b * 100, y0: 0, x1: b * 100 + 50, y1: 50 })
  }
  return {
    char,
    fontId: 'hei',
    weight: 400,
    missing: false,
    blank: false,
    rings,
    strokeBlocks: blocks,
    strokeBlocksByNesting: blocks,
    minStroke: 30,
    minStrokePoint: null,
    bbox: { x0: 0, y0: 0, x1: blocks * 100, y1: 50 },
    inkW: blocks * 100,
    inkH: 50,
    samples: emptySamples(),
    outerPerimeter: perimeter * blocks,
    blockBBoxes,
    pathData: '',
    advance: blocks * 100
  }
}

// 造 n 个字，每字 2 块，每块面板周长 perMm（k=inkW/geom.inkW=1，本地=面板）
function makeChars(n: number, perMm: number, gapMm = 200): PlacedChar[] {
  const out: PlacedChar[] = []
  let x = 0
  for (let i = 0; i < n; i++) {
    const geom = makeGeom(String(i), 2, perMm)
    out.push({
      index: i,
      char: String(i),
      geom,
      missing: false,
      blank: false,
      x,
      y: 400,
      inkW: 200,
      inkH: 5,
      gapAfter: null,
      overlapAfter: false,
      line: 0,
      item: { char: String(i), trackMm: 0, offsetYMm: 0, mode: 'solid', line: 0 }
    })
    x += 200 + gapMm
  }
  return out
}

const led: LedCfg = { moduleSpacingMm: 100, modulePowerW: 1, moduleLumen: 60, safetyFactor: 1, psuEfficiency: 0.85 }
// 每块面板周长 600mm → 6 模组 → 6W；每字 2 块 = 12W；k=1（inkW=geom.inkW）
const chars = makeChars(20, 600)

const cfg = (patch: Partial<ZoneCfg> = {}): ZoneCfg => ({ ...defaultZoneCfg(), ...patch })

// 1. byChar：100W 档可用 80W → 每字 12W，6 字一区（72W）
let r: ZoningResult = planZoning(chars, led, 12, [60, 100, 150, 200], preset, cfg({ psuTierW: 100 }), 800)
assert(r.zoneCount === 4 && r.zones[0].modules === 72 && r.zones[0].loadW === 72, `byChar 100W: 4 区（6/6/6/2 字），1 区 72 只/72W；实际 ${r.zoneCount} 区 ${r.zones[0].modules}/${r.zones[0].loadW}`)
assert(r.splitChars.length === 0, 'byChar 无跨区字')
assert(r.ok, 'byChar 正常方案通过校核')

// 2. 单字超容量：12W 字配手动 10W 档（可用 8W）→ 拦截
r = planZoning(chars, led, 12, [10, 100], preset, cfg({ psuTierW: 10 }), 800)
assert(!r.ok && r.zones.some((z) => z.overCapacity), '单字超容量拦截')
assert(r.fixes.some((f) => f.includes('换大电源')) && r.fixes.some((f) => f.includes('缩小分区')), '越界给两类改法')

// 3. byProximity：40 块 ×6W，80W 档装 13 块（78W）后第 14 块放不下
//    → 区边界落在字内部（每字 2 块），必出现跨区字
r = planZoning(chars, led, 12, [60, 100], preset, cfg({ strategy: 'byProximity', psuTierW: 100 }), 800)
assert(r.zoneCount >= 2, `proximity 100W: 多区，实际 ${r.zoneCount}`)
assert(r.splitChars.length >= 1, `proximity 有跨区字，实际 ${r.splitChars.length}`)
assert(r.splitChars.every((s) => s.instruction.includes('区')), '跨区字有接法说明')
// 跨区字的块归属并集完整（每个被拆字的块总数=2）
assert(
  r.splitChars.every((s) => s.blocksByZone.reduce((n, b) => n + b.blocks.length, 0) === 2),
  '跨区字笔画块归属齐全（每字 2 块）'
)

// 4. auto 档位：块级分区 60W（可用48W=8块）不越界 → 选 60W
const autoR = planZoning(chars, led, 12, [60, 100, 200], preset, cfg({ strategy: 'byProximity', psuTierW: 'auto' }), 800)
assert(autoR.psuTierW === 60 && autoR.zones.every((z) => !z.overCapacity), `auto 选 60W 且不越界，实际 ${autoR.psuTierW}`)

// 5. 压降模型手算：单区单字 12W（2 块各 6W），引线 300mm，块间距 100mm
//    I首=12/12=1A；末段下游 6W→0.5A；0.5 线载流 3A 满足
//    drop=2×0.02×(0.3×1 + 0.1×0.5)/0.5=0.028→0.03V ≤ 0.6 → 选 0.5
const one = planZoning(chars.slice(0, 1), led, 12, [60, 100], preset, cfg({ psuTierW: 60 }), 800)
const z0 = one.zones[0]
const expectDrop = r2((2 * 0.02 * (0.3 * 1 + 0.1 * 0.5)) / 0.5)
assert(z0.wire.currentA === 1, `首段电流 1A，实际 ${z0.wire.currentA}`)
assert(z0.wire.dropV === expectDrop, `最远压降 ${expectDrop}V，实际 ${z0.wire.dropV}`)
assert(z0.wire.spec === '0.5' && z0.wire.dropOk && z0.wire.ampacityOk, '选最细可用线径 0.5 且压降/载流达标')

// 6. 长引线拦截：6 字 72W（100W 档），feederMm=20000，I=6A，2.5 线 drop=2×.02×20×6/2.5=1.92V >0.6
const longR = planZoning(chars.slice(0, 6), led, 12, [100], preset, cfg({ psuTierW: 100, feederMm: 20000 }), 800)
assert(!longR.ok && longR.blockReasons.some((x) => x.includes('压降')), '超长引线压降拦截')
assert(longR.fixes.some((f) => f.includes('换更粗的线')), '压降改法含换更粗线')

// 7. 两位小数
assert([r2(1.235), r2(40), r2(0.8333)].every((v) => Math.round(v * 100) === v * 100), 'r2 输出两位小数')

// 8. diff：沿用走法，换档位，分区数变化能列出
const a = planZoning(chars, led, 12, [100], preset, cfg({ strategy: 'byProximity', psuTierW: 100 }), 800)
const snap = toSnapshot(cfg({ strategy: 'byProximity', psuTierW: 100 }), a)
const b = planZoning(chars, led, 12, [60], preset, cfg({ strategy: 'byProximity', psuTierW: 60 }), 800)
const d = diffZoning(snap, b)
assert(d.changed && d.items.some((i) => i.text.includes('分区数')), 'diff 列出分区数变化')

// 9. diff：换走法有提示
const c2 = planZoning(chars, led, 12, [100], preset, cfg({ strategy: 'byChar', psuTierW: 100 }), 800)
const d2 = diffZoning(snap, c2)
assert(d2.items.some((i) => i.text.includes('走法')), 'diff 提示走法切换')

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`)
process.exit(fails === 0 ? 0 : 1)
