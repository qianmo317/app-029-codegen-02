/**
 * 供电分区与线损校核。
 *
 * 背景：一整排字不能只按总长度配一台电源（现场一台带不动就得临时分区）。
 * 本模块拿排好版的每个字（面板位置 + 笔画块 + 外轮廓长度）划供电区，两种走法二选一：
 *   - byChar：按字逐个分区，每个字整套连在同一个区（字形完整、接线好认；区数/线材偏多）；
 *   - byProximity：按面板位置就近分区（走线短、省线；同一个字可能被挤到两区交界，
 *     此时把字按笔画块拆给两区并输出跨区接法，车间多一道手续）。
 *
 * 约束：每区模组数与功率都不许超过所选电源的「可用功率」（档位 × 降额比例）。
 * 每区计算线长、最远一颗灯珠压降、建议线径；压降或线径（载流）不达标即拦截并给改法。
 *
 * 精度纪律：分区规模（功率/模组/线长/电流）、线径系数（电阻率/线径）、压降
 * 一律先四舍五入到两位小数再做界线比较，避免浮点误差把结果算到界线外。
 */

import type { PlacedChar } from './layout'
import type { LedCfg, ZoneCfg, ZoneStrategy } from './types'

export interface WireGauge {
  mm2: number
  spec: string
  ampacityA: number
}

export interface WiringPreset {
  usableRatio: number
  maxDropV: number
  resistivity: number
  feederMm: number
  wirePriceCentsPerM: number
  spec: string
  gauges: WireGauge[]
}

/** 两位小数（界线比较前的统一口径） */
export const r2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

/** 一个「可分配单元」：一个笔画块（按字分区时同字的块始终同区；就近分区时块可跨区） */
export interface ZoneAtom {
  /** 唯一键：字序-块序 */
  key: string
  charIndex: number
  char: string
  line: number
  block: number
  /** 该块外轮廓周长（mm，面板尺寸下） */
  perimeterMm: number
  /** 该块上的模组数（ceil(周长/间距)） */
  modules: number
  /** 额定功率 W（模组 × 单模组功率 × 安全系数，两位小数） */
  powerW: number
  /** 块中心（面板坐标 mm，y 向下），就近分区与引线计算用 */
  cx: number
  cy: number
}

/** 字被拆给两区时的接法说明 */
export interface SplitChar {
  charIndex: number
  char: string
  /** 该字接入的区号（升序） */
  zoneNos: number[]
  /** 每区带哪几个笔画块（1 起编号，与工艺卡料件编号一致） */
  blocksByZone: Array<{ zoneNo: number; blocks: number[] }>
  /** 车间接线说明 */
  instruction: string
}

export interface ZoneWireEval {
  /** 建议线径规格 */
  spec: string
  mm2: number
  /** 区内最远灯珠（首段）电流 A */
  currentA: number
  /** 最远灯珠压降 V（往返线，两位小数） */
  dropV: number
  /** 用所选线径能否满足压降 */
  dropOk: boolean
  /** 载流是否满足 */
  ampacityOk: boolean
  /** 即便用最粗可选线，压降仍不达标 */
  impossibleDrop: boolean
  /** 所有可选线都载不动 */
  impossibleAmpacity: boolean
}

export interface ZoneInfo {
  zoneNo: number
  psuTierW: number
  /** 可用功率 = 档位 × 降额比例（两位小数） */
  usableW: number
  /** 原子键（字序-块序） */
  atomKeys: string[]
  /** 区内字（含跨区字，去重，按字序） */
  chars: Array<{ charIndex: number; char: string }>
  modules: number
  /** 区负载额定功率 W（两位小数） */
  loadW: number
  /** 负载率（两位小数） */
  loadRatio: number
  /** 线长 mm（引线 + 链式走线，两位小数） */
  wireMm: number
  wire: ZoneWireEval
  /** 电源引线落点（面板坐标 mm，接线图/预览用） */
  feedX: number
  feedY: number
  /** 是否越界（功率/模组超可用功率） */
  overCapacity: boolean
}

export interface ZoningResult {
  strategy: ZoneStrategy
  /** 实际使用的电源档位（auto 时为自动选出的档位） */
  psuTierW: number
  usableW: number
  zones: ZoneInfo[]
  zoneCount: number
  psuCount: number
  totalModules: number
  totalLoadW: number
  totalWireMm: number
  splitChars: SplitChar[]
  /** 整体是否通过（无越界、无压降/载流不达标） */
  ok: boolean
  blockReasons: string[]
  /** 改法建议（换更粗的线 / 缩小分区 / 换大电源） */
  fixes: string[]
  warnings: string[]
  /** 逐块归属（预览上色用）：atomKey → 区号 */
  atomZone: Map<string, number>
  signature: string
}

export function defaultZoneCfg(): ZoneCfg {
  return {
    strategy: 'byChar',
    psuTierW: 'auto',
    usableRatio: 0.8,
    maxDropV: 0.6,
    resistivity: 0.02,
    feederMm: 300,
    baseline: null
  }
}

/** 规整旧项目/手工存储里缺字段的分区配置（线损参数两位小数） */
export function normalizeZoneCfg(cfg: Partial<ZoneCfg> | null | undefined, preset: WiringPreset): ZoneCfg {
  const d = defaultZoneCfg()
  const out: ZoneCfg = {
    strategy: cfg?.strategy === 'byProximity' ? 'byProximity' : 'byChar',
    psuTierW:
      cfg && (cfg.psuTierW === 'auto' || (typeof cfg.psuTierW === 'number' && Number.isFinite(cfg.psuTierW) && cfg.psuTierW > 0))
        ? (cfg.psuTierW as number | 'auto')
        : 'auto',
    usableRatio: num2(cfg?.usableRatio, preset.usableRatio, d.usableRatio, 0.01, 1),
    maxDropV: num2(cfg?.maxDropV, preset.maxDropV, d.maxDropV, 0.01, 60),
    resistivity: num2(cfg?.resistivity, preset.resistivity, d.resistivity, 0.01, 1),
    feederMm: num2(cfg?.feederMm, preset.feederMm, d.feederMm, 0, 100000),
    baseline: cfg?.baseline ?? null
  }
  return out
}

function num2(v: unknown, presetV: number, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : presetV ?? fallback
  return r2(Math.min(max, Math.max(min, n)))
}

/** 由排版结果拆出可分配单元（每个笔画块一个，位置取面板坐标） */
export function buildAtoms(chars: PlacedChar[], cfg: LedCfg): ZoneAtom[] {
  const spacing = Math.max(1, cfg.moduleSpacingMm)
  const atoms: ZoneAtom[] = []
  chars.forEach((c) => {
    if (c.missing || c.blank) return
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    c.geom.rings
      .filter((r) => !r.isHole)
      .forEach((r) => {
        const per = r.perimeter * k
        const modules = Math.max(0, Math.ceil(per / spacing - 1e-9))
        const powerW = modules * cfg.modulePowerW * cfg.safetyFactor
        const b = c.geom.blockBBoxes[r.block] ?? r.bbox
        const bx0 = c.x + (b.x0 - c.geom.bbox.x0) * k
        const by0 = c.y + (b.y0 - c.geom.bbox.y0) * k
        const bx1 = c.x + (b.x1 - c.geom.bbox.x0) * k
        const by1 = c.y + (b.y1 - c.geom.bbox.y0) * k
        atoms.push({
          key: `${c.index}-${r.block}`,
          charIndex: c.index,
          char: c.char,
          line: c.line,
          block: r.block,
          perimeterMm: r2(per),
          modules,
          powerW: r2(powerW),
          cx: (bx0 + bx1) / 2,
          cy: (by0 + by1) / 2
        })
      })
  })
  return atoms
}

interface PackedZone {
  atoms: ZoneAtom[]
}

function zoneLoad(atoms: ZoneAtom[]): { modules: number; powerW: number } {
  return {
    modules: atoms.reduce((s, a) => s + a.modules, 0),
    powerW: r2(atoms.reduce((s, a) => s + a.powerW, 0))
  }
}

/**
 * 按字逐个装箱：严格按字序贪心，一个字的全部块同进同出，宁多开一区也不拆字。
 * 单个字本身超一区容量时无法装入（独占一区并标记越界，交给校核拦截）。
 */
function packByChar(all: ZoneAtom[], usableW: number, moduleCap: number): PackedZone[] {
  const byChar = new Map<number, ZoneAtom[]>()
  for (const a of all) {
    const arr = byChar.get(a.charIndex) ?? []
    arr.push(a)
    byChar.set(a.charIndex, arr)
  }
  const groups = [...byChar.entries()].sort((p, q) => p[0] - q[0]).map(([, arr]) => arr)
  const zones: PackedZone[] = []
  let cur: ZoneAtom[] = []
  const fits = (atoms: ZoneAtom[]): boolean => {
    const l = zoneLoad([...cur, ...atoms])
    return l.powerW <= usableW && l.modules <= moduleCap
  }
  for (const g of groups) {
    if (cur.length > 0 && !fits(g)) {
      zones.push({ atoms: cur })
      cur = []
    }
    cur.push(...g)
    const l = zoneLoad(cur)
    if (l.powerW > usableW || l.modules > moduleCap) {
      zones.push({ atoms: cur })
      cur = []
    }
  }
  if (cur.length) zones.push({ atoms: cur })
  return zones
}

/**
 * 按面板位置就近装箱：块按（行，蛇形 x）排序后贪心，能塞下就同区；
 * 一个块塞不下就给下一区——同一个字因此可能落在两区交界（splitChars 写清接法）。
 */
function packByProximity(all: ZoneAtom[], usableW: number, moduleCap: number): PackedZone[] {
  const lineNos = [...new Set(all.map((a) => a.line))].sort((p, q) => p - q)
  const ordered: ZoneAtom[] = []
  lineNos.forEach((ln, li) => {
    const arr = all.filter((a) => a.line === ln).sort((p, q) => p.cx - q.cx)
    // 蛇形：偶数行从左到右、奇数行从右到左，行间引线最短
    if (li % 2 === 1) arr.reverse()
    ordered.push(...arr)
  })
  const zones: PackedZone[] = []
  let cur: ZoneAtom[] = []
  for (const a of ordered) {
    const l = zoneLoad([...cur, a])
    if (cur.length > 0 && (l.powerW > usableW || l.modules > moduleCap)) {
      zones.push({ atoms: cur })
      cur = []
    }
    cur.push(a)
  }
  if (cur.length) zones.push({ atoms: cur })
  return zones
}

/** 两个接线点之间的走线长度（面板欧氏距离） */
function runDistance(prev: ZoneAtom, a: ZoneAtom): number {
  return Math.hypot(a.cx - prev.cx, a.cy - prev.cy)
}

/** 区内灯珠链式顺序：按字走法按字序/块序；就近走法保持蛇形装箱顺序 */
function chainOrder(atoms: ZoneAtom[], strategy: ZoneStrategy): ZoneAtom[] {
  if (strategy !== 'byChar') return atoms
  return [...atoms].sort((p, q) => p.charIndex - q.charIndex || p.block - q.block || p.cx - q.cx)
}

interface Segment {
  lenM: number
  /** 该段下游（含段末端）的额定功率 W */
  downW: number
}

/**
 * 线损校核（链式馈电的保守模型）：
 *   段电流 I = 该段下游额定功率 / 模组电压
 *   段压降 = 2 × ρ × L(m) × I / 线径        （2 = 火线 + 零线往返）
 * 最远一颗灯珠压降 = 引线段 + 各链路段压降之和（每段只带其下游灯珠）。
 * 电流、压降先保留两位小数再与上限比较。
 */
export function evaluateWire(
  atomsIn: ZoneAtom[],
  strategy: ZoneStrategy,
  voltageV: number,
  preset: WiringPreset,
  cfg: ZoneCfg,
  panelHMm: number
): { wire: ZoneWireEval; wireMm: number; feedX: number; feedY: number; segments: Segment[]; feederMm: number } {
  const atoms = chainOrder(atomsIn, strategy)
  const first = atoms[0]
  // 电源固定在首灯正下方板边（与现场一致），引线长度可在参数里调
  const feedX = first ? first.cx : 0
  const feedY = panelHMm
  const feederMm = r2(Math.max(0, cfg.feederMm))
  let runMm = 0
  for (let i = 0; i < atoms.length - 1; i++) runMm += runDistance(atoms[i], atoms[i + 1])
  const wireMm = r2(feederMm + runMm)

  const rho = r2(cfg.resistivity)
  const maxDrop = r2(cfg.maxDropV)
  const totalPower = zoneLoad(atoms).powerW
  const v = Math.max(1, voltageV)
  const currentA = r2(totalPower / v)

  const segments: Segment[] = [{ lenM: feederMm / 1000, downW: totalPower }]
  let downW = totalPower
  for (let i = 0; i < atoms.length - 1; i++) {
    downW = r2(downW - atoms[i].powerW)
    segments.push({ lenM: runDistance(atoms[i], atoms[i + 1]) / 1000, downW: Math.max(0, downW) })
  }

  const gauges = [...preset.gauges].sort((p, q) => p.mm2 - q.mm2)
  const dropFor = (g: WireGauge): number => {
    let drop = 0
    for (const s of segments) {
      const I = r2(s.downW / v)
      drop += (2 * rho * s.lenM * I) / g.mm2
    }
    return r2(drop)
  }

  let chosen: WireGauge | null = null
  for (const g of gauges) {
    if (dropFor(g) <= maxDrop && currentA <= r2(g.ampacityA)) {
      chosen = g
      break
    }
  }
  const thickest = gauges.length ? gauges[gauges.length - 1] : null
  const thickDrop = thickest ? dropFor(thickest) : Infinity
  const impossibleDrop = thickest ? thickDrop > maxDrop : false
  const impossibleAmpacity = thickest ? currentA > r2(thickest.ampacityA) : true
  const useG = chosen ?? thickest
  const useDrop = useG ? dropFor(useG) : 0

  return {
    wire: {
      spec: useG ? useG.spec : '无线材规格',
      mm2: useG ? useG.mm2 : 0,
      currentA,
      dropV: useDrop,
      dropOk: useDrop <= maxDrop,
      ampacityOk: useG ? currentA <= r2(useG.ampacityA) : false,
      impossibleDrop,
      impossibleAmpacity
    },
    wireMm,
    feedX,
    feedY,
    segments,
    feederMm
  }
}

function buildSplitChars(zoneAtoms: ZoneAtom[][]): SplitChar[] {
  const charZones = new Map<number, { char: string; blocks: Map<number, number> }>()
  zoneAtoms.forEach((atoms, zi) => {
    for (const a of atoms) {
      let e = charZones.get(a.charIndex)
      if (!e) {
        e = { char: a.char, blocks: new Map() }
        charZones.set(a.charIndex, e)
      }
      e.blocks.set(a.block, zi + 1)
    }
  })
  const out: SplitChar[] = []
  for (const [charIndex, e] of [...charZones.entries()].sort((p, q) => p[0] - q[0])) {
    const zoneNos = [...new Set(e.blocks.values())].sort((p, q) => p - q)
    if (zoneNos.length < 2) continue
    const blocksByZone = zoneNos.map((zn) => ({
      zoneNo: zn,
      blocks: [...e.blocks.entries()].filter(([, z]) => z === zn).map(([b]) => b + 1).sort((p, q) => p - q)
    }))
    const desc = blocksByZone.map((x) => `${x.zoneNo} 区带第 ${x.blocks.join('、')} 块`).join('；')
    out.push({
      charIndex,
      char: e.char,
      zoneNos,
      blocksByZone,
      instruction: `「${e.char}」跨 ${zoneNos.join('、')} 区：${desc}；字壳内笔画块间连接线照常走，跨区接缝两侧电源线分别就近接入对应回路，接线点套号码管标记（车间增加一道核对手续）`
    })
  }
  return out
}

/** 主入口：按指定走法与电源档位分区并做线损校核 */
export function planZoning(
  chars: PlacedChar[],
  led: LedCfg,
  voltageV: number,
  tiersIn: number[],
  preset: WiringPreset,
  cfg: ZoneCfg,
  panelHMm: number
): ZoningResult {
  const atoms = buildAtoms(chars, led)
  const tiers = [...new Set(tiersIn)].filter((t) => Number.isFinite(t) && t > 0).sort((p, q) => p - q)
  if (atoms.length === 0) return emptyResult(cfg.strategy, 0, 0)

  // 选定档位（auto：从小到大试，取「全部不越界」的最小档位；都越界则用最大档并拦截）
  let tier: number
  if (typeof cfg.psuTierW === 'number') {
    tier = cfg.psuTierW
  } else {
    tier = tiers.length ? tiers[tiers.length - 1] : 400
    for (const t of tiers) {
      if (runPack(atoms, led, voltageV, t, preset, cfg, panelHMm).zones.every((z) => !z.overCapacity)) {
        tier = t
        break
      }
    }
  }
  return runPack(atoms, led, voltageV, tier, preset, cfg, panelHMm)
}

function emptyResult(strategy: ZoneStrategy, tier: number, usable: number): ZoningResult {
  return {
    strategy,
    psuTierW: tier,
    usableW: r2(usable),
    zones: [],
    zoneCount: 0,
    psuCount: 0,
    totalModules: 0,
    totalLoadW: 0,
    totalWireMm: 0,
    splitChars: [],
    ok: true,
    blockReasons: [],
    fixes: [],
    warnings: [],
    atomZone: new Map(),
    signature: ''
  }
}

function runPack(
  atoms: ZoneAtom[],
  led: LedCfg,
  voltageV: number,
  tier: number,
  preset: WiringPreset,
  cfg: ZoneCfg,
  panelHMm: number
): ZoningResult {
  const usableW = r2(tier * cfg.usableRatio)
  // 模组数上限同样按可用功率折算（单模组平均额定功率），模组数与功率双约束
  const perModuleW = Math.max(1e-6, led.modulePowerW * led.safetyFactor)
  const moduleCap = Math.floor(usableW / perModuleW + 1e-9)

  const packed = cfg.strategy === 'byChar' ? packByChar(atoms, usableW, moduleCap) : packByProximity(atoms, usableW, moduleCap)
  const zoneAtoms = packed.map((z) => z.atoms)
  const splitChars = buildSplitChars(zoneAtoms)
  const blockReasons: string[] = []
  const fixes = new Set<string>()
  const warnings: string[] = []

  const zones: ZoneInfo[] = zoneAtoms.map((za, i) => {
    const load = zoneLoad(za)
    const over = load.powerW > usableW || load.modules > moduleCap
    const ew = evaluateWire(za, cfg.strategy, voltageV, preset, cfg, panelHMm)
    const ampOfChosen = preset.gauges.find((g) => g.spec === ew.wire.spec)?.ampacityA ?? 0
    if (over) {
      const badChars = [...new Set(za.map((a) => a.char))].join('')
      blockReasons.push(
        `${i + 1} 区负载 ${load.powerW}W、${load.modules} 只模组，超过所选电源可用功率 ${usableW}W（${tier}W × ${cfg.usableRatio}）：区内字「${badChars}」`
      )
    }
    if (!ew.wire.ampacityOk) {
      blockReasons.push(`${i + 1} 区最远电流 ${ew.wire.currentA}A，超过建议线径 ${ew.wire.spec} 载流 ${r2(ampOfChosen)}A（线长 ${ew.wireMm}mm）`)
    }
    if (!ew.wire.dropOk) {
      blockReasons.push(`${i + 1} 区最远灯珠压降 ${ew.wire.dropV}V > 上限 ${r2(cfg.maxDropV)}V（${ew.wire.spec}，线长 ${ew.wireMm}mm）`)
    }
    const charMap = new Map<number, string>()
    za.forEach((a) => charMap.set(a.charIndex, a.char))
    return {
      zoneNo: i + 1,
      psuTierW: tier,
      usableW,
      atomKeys: za.map((a) => a.key),
      chars: [...charMap.entries()].sort((p, q) => p[0] - q[0]).map(([charIndex, char]) => ({ charIndex, char })),
      modules: load.modules,
      loadW: load.powerW,
      loadRatio: r2(load.powerW / Math.max(0.01, usableW)),
      wireMm: ew.wireMm,
      wire: ew.wire,
      feedX: ew.feedX,
      feedY: ew.feedY,
      overCapacity: over
    }
  })

  const anyImpossibleDrop = zones.some((z) => z.wire.impossibleDrop && !z.wire.dropOk)
  const anyImpossibleAmp = zones.some((z) => z.wire.impossibleAmpacity && !z.wire.ampacityOk)

  if (zones.some((z) => z.overCapacity)) {
    fixes.add('换大电源：选用更高功率档位（可用功率 = 档位 × 降额比例），或在温升允许时调高降额比例后复核')
    fixes.add('缩小分区：让分区在更小负载处断开（就近走法天然分得更细），保证每区功率与模组数不超可用功率')
  }
  if (zones.some((z) => !z.wire.ampacityOk)) {
    fixes.add('换更粗的线：按各区电流选载流足够的线径（见每区线径建议）')
    if (anyImpossibleAmp) fixes.add('现有最粗线仍载不动：必须缩小分区，降低单回路电流，或换大电压（24V）方案')
  }
  if (zones.some((z) => !z.wire.dropOk)) {
    fixes.add('换更粗的线：按线径建议升一档，压降近似随线径成反比下降')
    fixes.add('缩小分区 / 电源就近：把电源挂到分区中部、缩短最远灯珠距离' + (anyImpossibleDrop ? '（最粗线仍不达标时必须如此）' : ''))
  }

  if (cfg.strategy === 'byProximity' && splitChars.length > 0) {
    warnings.push(
      `就近分区有 ${splitChars.length} 个字落在两区交界：${splitChars.map((s) => `「${s.char}」(${s.zoneNos.join('/')}区)`).join('、')}；按跨区接法施工，接线点套号码管`
    )
  } else if (cfg.strategy === 'byChar') {
    warnings.push('按字分区：每个字整套接同一区，字形完整、接线好认；相比就近走法区数与电源线材偏多')
  }

  const atomZone = new Map<string, number>()
  zones.forEach((z) => z.atomKeys.forEach((k) => atomZone.set(k, z.zoneNo)))

  return {
    strategy: cfg.strategy,
    psuTierW: tier,
    usableW,
    zones,
    zoneCount: zones.length,
    psuCount: zones.length,
    totalModules: zones.reduce((s, z) => s + z.modules, 0),
    totalLoadW: r2(zones.reduce((s, z) => s + z.loadW, 0)),
    totalWireMm: r2(zones.reduce((s, z) => s + z.wireMm, 0)),
    splitChars,
    ok: blockReasons.length === 0,
    blockReasons,
    fixes: [...fixes],
    warnings,
    atomZone,
    signature: signatureOf(cfg.strategy, tier, zones)
  }
}

function signatureOf(strategy: ZoneStrategy, tier: number, zones: ZoneInfo[]): string {
  return [
    strategy,
    tier,
    zones.map((z) => `${z.zoneNo}:${z.atomKeys.join('|')}`).join(';')
  ].join('#')
}

/* ----------------------------- 两次划分差别 ----------------------------- */

export interface ZoneDiffItem {
  kind: 'added' | 'removed' | 'changed'
  zoneNo: number
  text: string
}

export interface ZoneSnapshot {
  strategy: ZoneStrategy
  psuTierW: number | 'auto'
  signature: string
  zones: Array<{
    zoneNo: number
    psuTierW: number
    charKeys: string[]
    modules: number
    loadW: number
    wireMm: number
    dropV: number
    wireSpec: string
  }>
}

export function toSnapshot(cfg: ZoneCfg, r: ZoningResult): ZoneSnapshot {
  return {
    strategy: cfg.strategy,
    psuTierW: cfg.psuTierW,
    signature: r.signature,
    zones: r.zones.map((z) => ({
      zoneNo: z.zoneNo,
      psuTierW: z.psuTierW,
      charKeys: z.chars.map((c) => `${c.charIndex}:${c.char}`),
      modules: z.modules,
      loadW: z.loadW,
      wireMm: z.wireMm,
      dropV: z.wire.dropV,
      wireSpec: z.wire.spec
    }))
  }
}

/** 以「字 → 区号」为口径列出两次划分的差别（换模组/电源规格重划后调用，走法沿用同一套） */
export function diffZoning(prev: ZoneSnapshot | null, next: ZoningResult): { items: ZoneDiffItem[]; changed: boolean } {
  if (!prev) return { items: [], changed: false }
  const items: ZoneDiffItem[] = []
  if (prev.strategy !== next.strategy) {
    items.push({
      kind: 'changed',
      zoneNo: 0,
      text: `分区走法由「${strategyLabel(prev.strategy)}」改为「${strategyLabel(next.strategy)}」；重划应沿用同一套走法，若非有意切换请切回`
    })
  }

  const nextCharZones = new Map<string, number[]>()
  for (const z of next.zones) {
    for (const c of z.chars) {
      const k = `${c.charIndex}:${c.char}`
      nextCharZones.set(k, (nextCharZones.get(k) ?? []).concat(z.zoneNo))
    }
  }
  const prevCharZones = new Map<string, number[]>()
  for (const z of prev.zones) for (const k of z.charKeys) prevCharZones.set(k, (prevCharZones.get(k) ?? []).concat(z.zoneNo))

  const allKeys = new Set([...prevCharZones.keys(), ...nextCharZones.keys()])
  const moved: string[] = []
  for (const k of [...allKeys].sort()) {
    const a = (prevCharZones.get(k) ?? []).sort((p, q) => p - q).join(',')
    const b = (nextCharZones.get(k) ?? []).sort((p, q) => p - q).join(',')
    if (a !== b) moved.push(`「${k.split(':')[1]}」${a || '—'}区→${b || '—'}区`)
  }

  if (prev.zones.length !== next.zoneCount) {
    items.push({ kind: 'changed', zoneNo: 0, text: `分区数 ${prev.zones.length} 区 → ${next.zoneCount} 区；电源台数同步 ${prev.zones.length} → ${next.psuCount} 台` })
  }
  if (moved.length) {
    items.push({ kind: 'changed', zoneNo: 0, text: `字归属变化 ${moved.length} 处：${moved.slice(0, 12).join('；')}${moved.length > 12 ? '；…' : ''}` })
  }

  const n = Math.max(prev.zones.length, next.zoneCount)
  for (let i = 0; i < n; i++) {
    const a = prev.zones[i]
    const b = next.zones[i]
    if (a && !b) items.push({ kind: 'removed', zoneNo: a.zoneNo, text: `${a.zoneNo} 区取消（原 ${a.modules} 只 / ${a.loadW}W）` })
    else if (!a && b) items.push({ kind: 'added', zoneNo: b.zoneNo, text: `${b.zoneNo} 区新增（${b.modules} 只 / ${b.loadW}W，线长 ${b.wireMm}mm）` })
    else if (a && b) {
      const parts: string[] = []
      if (a.modules !== b.modules) parts.push(`模组 ${a.modules}→${b.modules} 只`)
      if (a.loadW !== b.loadW) parts.push(`功率 ${a.loadW}→${b.loadW}W`)
      if (a.wireMm !== b.wireMm) parts.push(`线长 ${a.wireMm}→${b.wireMm}mm`)
      if (a.dropV !== b.wire.dropV) parts.push(`压降 ${a.dropV}→${b.wire.dropV}V`)
      if (a.wireSpec !== b.wire.spec) parts.push(`线径 ${a.wireSpec}→${b.wire.spec}`)
      if (parts.length) items.push({ kind: 'changed', zoneNo: b.zoneNo, text: `${b.zoneNo} 区：${parts.join('，')}` })
    }
  }
  return { items, changed: items.length > 0 }
}

export function strategyLabel(s: ZoneStrategy): string {
  return s === 'byChar' ? '按字逐个分区' : '按面板位置就近分区'
}
