/**
 * 供电分区与线损校核（现场分区接线的数字化口径）：
 * 一整排字不能只按总长度配一台电源——分区走法二选一，且换模组/电源规格重划时沿用同一走法：
 *   - byChar（按字逐个分区）：每个字整套挂在同一区，字形完整、接线好认；区数偏多、线材多；
 *   - byPosition（按面板位置就近分区）：按灯珠在面板上的位置就近归区，走线短、省线；
 *     同一个字可能落在两区交界，允许把一个字的模组分给两区，并写清车间接法。
 *
 * 每区校核：
 *   每区模组数与额定功率都不许超过所选电源可用功率（最大档位 × 效率）；
 *   线长（到最远灯珠，含往返余量）、最远灯珠压降 ΔU = 2ρLI/S、线径载流量；
 *   压降或线径不达标即判该区域不可行并拦住出单，给出改法（换更粗的线 / 缩小分区 / 换大电源）。
 *
 * 精度口径：分区规模（线长 m）、线径系数 ρ、压降一律保留两位小数后再比较，
 * 界面上看到的数就能直接复算，不会因截断误差把结果算到界线另一侧。
 */

import { ledDotsTagged, type LedDotTagged } from './led'
import type { PsuPreset } from './led'
import type { LayoutResult } from './layout'
import type { LedCfg, Project, ZoneCfg, ZoneMode } from './types'
import type { Preset, WireSpec } from './materials'

/** 统一两位小数（分区规模 / 线径系数 / 压降都走这个口径） */
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export interface ZoneCharPart {
  charIndex: number
  char: string
  /** 该区内属于该字的模组数 */
  modules: number
  /** 相对字形中心的方位标签（左/右/上/下半） */
  side: string
  cx: number
  cy: number
}

export interface ZoneRow {
  /** 区号，从 1 起 */
  no: number
  modules: number
  /** 额定功率（含安全系数，W，两位小数） */
  ratedW: number
  /** 电源需求功率 = 额定 / 效率（W，两位小数） */
  needW: number
  /** 选用电源档位 W；超档为 null（不可行） */
  psuW: number | null
  psuCount: number
  /** 分区规模：覆盖范围 mm 与走线长度 m（两位小数） */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  spanMm: number
  /** 电源出线口（取靠分区形心最近的面板边缘投影点） */
  anchor: { x: number; y: number; edge: 'top' | 'bottom' }
  /** 最远灯珠单程距离 mm（原始） */
  maxPathMm: number
  /** 线材用量 m（单程 × 余量系数，往返已含在压降公式的 2ρLI 中；两位小数） */
  wireLenM: number
  currentA: number
  wire: WireSpec
  /** 最远灯珠压降 V（两位小数） */
  dropV: number
  /** 压降限值 V（两位小数） */
  dropLimitV: number
  dropRatioPct: number
  ampOk: boolean
  dropOk: boolean
  powerOk: boolean
  feasible: boolean
  /** 不可行原因（可多条） */
  reasons: string[]
  /** 改法建议 */
  remedies: string[]
  chars: ZoneCharPart[]
  /** 电源/分区形心等面板坐标，供预览标注 */
  centerX: number
  centerY: number
}

export interface SplitChar {
  charIndex: number
  char: string
  /** 车间接法说明 */
  instruction: string
  parts: Array<{ zoneNo: number; modules: number; side: string }>
}

export interface ZoningResult {
  mode: ZoneMode
  modeLabel: string
  voltageV: number
  /** 灯珠点（与 dotZoneIndex 一一对应） */
  dots: LedDotTagged[]
  /** 每个灯珠点所属区号（从 1 起），供预览着色 */
  dotZoneNo: number[]
  zones: ZoneRow[]
  zoneCount: number
  totalModules: number
  totalRatedW: number
  psuCount: number
  totalWireM: number
  splitChars: SplitChar[]
  feasible: boolean
  blocked: boolean
  blockReasons: string[]
  /** 校核口径说明（公式/系数，界面展示用） */
  formulaNote: string
}

export interface ZoneSnapshot {
  mode: ZoneMode
  voltageV: number
  zoneCount: number
  totalModules: number
  psuCount: number
  totalWireM: number
  zones: Array<{
    no: number
    modules: number
    ratedW: number
    wireLenM: number
    psuW: number | null
    wireSpec: string
    chars: Array<{ key: string; char: string; modules: number; side: string }>
  }>
  splits: Array<{ key: string; char: string; instruction: string }>
}

function zoneModeLabel(mode: ZoneMode): string {
  return mode === 'byChar' ? '按字逐个分区' : '按面板位置就近分区'
}
export { zoneModeLabel }

interface PendingZone {
  dotIdxs: number[]
}

interface PackContext {
  dots: LedDotTagged[]
  mode: ZoneMode
  capW: number
  capModules: number
  /** 电气校核收口开关：false 时只按功率/模组数分区（用于「不许靠划小区规避」的拦截场景） */
  splitOnElectrical: boolean
  perDotW: number
  voltageV: number
  dropLimitV: number
  reserve: number
  thickest: WireSpec
  resistivity: number
  inner: { x: number; y: number; w: number; h: number }
}

/**
 * 电源出线口：区起始点在最近上/下边缘的投影。
 * 现场走法是电源出线后沿招牌边缘走干线，再垂直到灯珠——起点固定，
 * 分区贪心时往里加灯珠只会让路径变长，可行性单调（不会因形心移动而「越划越好」）。
 */
function anchorOf(idxs: number[], dots: LedDotTagged[], inner: PackContext['inner']): { x: number; y: number; edge: 'top' | 'bottom' } {
  const first = dots[idxs[0]]
  const px = first ? first.x : inner.x + inner.w / 2
  const py = first ? first.y : inner.y + inner.h / 2
  const edge: 'top' | 'bottom' = py - inner.y <= inner.y + inner.h - py ? 'top' : 'bottom'
  return {
    x: Math.min(Math.max(px, inner.x), inner.x + inner.w),
    y: edge === 'top' ? inner.y : inner.y + inner.h,
    edge
  }
}

/**
 * 电气可行性预检（分区阶段用最粗线试算）：给定区的灯珠点，
 * 功率/模组数/载流量/最远压降是否都满足。分区按此收口，
 * 使「能划小就划小」；剩下不满足的（按字模式下不可拆的单字）才拦住。
 */
function feasibleSet(idxs: number[], ctx: PackContext): { ok: boolean; maxPathMm: number; wireLenM: number; currentA: number } {
  const n = idxs.length
  if (n === 0) return { ok: true, maxPathMm: 0, wireLenM: 0, currentA: 0 }
  const ratedW = round2(n * ctx.perDotW)
  if (ratedW > ctx.capW + 1e-9) return { ok: false, maxPathMm: 0, wireLenM: 0, currentA: 0 }
  if (ctx.capModules > 0 && n > ctx.capModules) return { ok: false, maxPathMm: 0, wireLenM: 0, currentA: 0 }
  const currentA = round2(ratedW / ctx.voltageV)
  if (currentA > ctx.thickest.ampacityA + 1e-9) return { ok: false, maxPathMm: 0, wireLenM: 0, currentA }
  const anchor = anchorOf(idxs, ctx.dots, ctx.inner)
  let maxPathMm = 0
  for (const i of idxs) {
    const d = Math.hypot(ctx.dots[i].x - anchor.x, ctx.dots[i].y - anchor.y)
    if (d > maxPathMm) maxPathMm = d
  }
  const wireLenM = round2((maxPathMm / 1000) * ctx.reserve)
  const dropV = round2((2 * ctx.resistivity * wireLenM * currentA) / ctx.thickest.areaMm2)
  return { ok: dropV <= ctx.dropLimitV + 1e-9, maxPathMm, wireLenM, currentA }
}

/** 按走法把灯珠点打包成区（next-fit：顺序走线、不回穿；按字模式保证同字不拆） */
function packDots(ctx: PackContext): PendingZone[] {
  const { dots, mode, capModules, perDotW } = ctx
  const order = dots.map((_, i) => i)
  if (mode === 'byPosition') {
    order.sort((a, b) => {
      const da = dots[a]
      const db = dots[b]
      if (da.line !== db.line) return da.line - db.line
      if (da.x !== db.x) return da.x - db.x
      return da.y - db.y
    })
  }

  const powerFits = (zone: PendingZone, add: number[]): boolean => {
    const n = zone.dotIdxs.length + add.length
    if (capModules > 0 && n > capModules) return false
    return round2(n * perDotW) <= ctx.capW + 1e-9
  }

  const electricOk = (zone: PendingZone, add: number[]): boolean =>
    !ctx.splitOnElectrical || feasibleSet([...zone.dotIdxs, ...add], ctx).ok

  const zones: PendingZone[] = []
  if (mode === 'byChar') {
    let cur: PendingZone = { dotIdxs: [] }
    const pushCur = (): void => {
      if (cur.dotIdxs.length) zones.push(cur)
      cur = { dotIdxs: [] }
    }
    let i = 0
    while (i < order.length) {
      const ci = dots[order[i]].charIndex
      const group: number[] = []
      while (i < order.length && dots[order[i]].charIndex === ci) group.push(order[i++])
      // 当前区 + 这个字放不下（功率或最粗线压降）就收口；单字本身放不下时字形不拆、
      // 整字独占一区（单字是不可再分单位），交校核阶段拦住并给改法
      if (!powerFits(cur, group) || !electricOk(cur, group)) pushCur()
      cur.dotIdxs.push(...group)
    }
    pushCur()
  } else {
    let cur: PendingZone = { dotIdxs: [] }
    for (const idx of order) {
      if (cur.dotIdxs.length > 0 && (!powerFits(cur, [idx]) || !electricOk(cur, [idx]))) {
        zones.push(cur)
        cur = { dotIdxs: [] }
      }
      cur.dotIdxs.push(idx)
    }
    if (cur.dotIdxs.length) zones.push(cur)
  }
  return zones
}

/** 选线：按线径从细到粗，第一根同时满足载流量与压降的为建议线；全不满足则给最粗线并判失败 */
function pickWire(
  preset: Preset,
  currentA: number,
  wireLenM: number,
  dropLimitV: number
): { wire: WireSpec; dropV: number; ampOk: boolean; dropOk: boolean } {
  const rho = round2(preset.wiring.resistivity)
  let chosen = preset.wiring.wires[0]
  let chosenDrop = Infinity
  let chosenAmp = false
  let chosenDropOk = false
  for (const w of preset.wiring.wires) {
    const ampOk = currentA <= w.ampacityA + 1e-9
    // ΔU = 2 × ρ × L × I / S（往返两根线），全部按两位小数口径算
    const dropV = round2((2 * rho * wireLenM * currentA) / w.areaMm2)
    const dropOk = dropV <= dropLimitV + 1e-9
    chosen = w
    chosenDrop = dropV
    chosenAmp = ampOk
    chosenDropOk = dropOk
    if (ampOk && dropOk) break
  }
  return { wire: chosen, dropV: chosenDrop, ampOk: chosenAmp, dropOk: chosenDropOk }
}

export function computeZoning(project: Project, layout: LayoutResult, preset: Preset): ZoningResult {
  const cfg: ZoneCfg = {
    mode: project.zone?.mode ?? 'byChar',
    maxDropRatio: project.zone?.maxDropRatio ?? 0.05,
    maxModulesPerZone: project.zone?.maxModulesPerZone ?? 0,
    autoShrinkForDrop: project.zone?.autoShrinkForDrop ?? true
  }
  const led: LedCfg = project.led
  const psu: PsuPreset = preset.psu
  const voltageV = preset.ledModules.find((m) => m.id === project.ledModuleId)?.voltageV ?? 12
  const tiers = [...psu.tiers].sort((a, b) => a - b)
  const maxTier = tiers.length ? tiers[tiers.length - 1] : 400
  const efficiency = Math.max(0.1, led.psuEfficiency)
  const safety = led.safetyFactor
  const perDotW = round2(led.modulePowerW * safety)
  // 每区可用功率（最大档位电源经效率折算后的持续输出上限）
  const capW = round2(maxTier * efficiency)
  const capModules = Math.max(0, Math.floor(cfg.maxModulesPerZone ?? 0))

  const dots = ledDotsTagged(layout.chars, led.moduleSpacingMm)
  const thickest = preset.wiring.wires[preset.wiring.wires.length - 1]
  const dropRatio = round2(cfg.maxDropRatio)
  const dropLimitV = round2(voltageV * dropRatio)
  const reserve = round2(preset.wiring.wireReserveFactor)
  const packCtx: PackContext = {
    dots,
    mode: cfg.mode,
    capW,
    capModules,
    splitOnElectrical: cfg.autoShrinkForDrop !== false,
    perDotW,
    voltageV,
    dropLimitV,
    reserve,
    thickest,
    resistivity: round2(preset.wiring.resistivity),
    inner: layout.inner
  }
  const packed = packDots(packCtx)

  const blockReasons: string[] = []
  const zones: ZoneRow[] = []
  const dotZoneNo = new Array<number>(dots.length).fill(0)

  packed.forEach((pz, zi) => {
    const no = zi + 1
    const idxs = pz.dotIdxs
    for (const i of idxs) dotZoneNo[i] = no
    const modules = idxs.length
    const ratedW = round2(modules * perDotW)
    const needW = round2(ratedW / efficiency)

    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let sx = 0
    let sy = 0
    for (const i of idxs) {
      const d = dots[i]
      if (d.x < x0) x0 = d.x
      if (d.y < y0) y0 = d.y
      if (d.x > x1) x1 = d.x
      if (d.y > y1) y1 = d.y
      sx += d.x
      sy += d.y
    }
    if (!idxs.length) {
      x0 = y0 = x1 = y1 = 0
    }
    const cx = idxs.length ? sx / idxs.length : 0
    const cy = idxs.length ? sy / idxs.length : 0
    const spanMm = round2(Math.max(0, x1 - x0))

    // 电源出线口与分区阶段一致：区首个灯珠靠上/下边缘的投影（每区电源位置固定）
    const anchor = anchorOf(idxs, dots, layout.inner)
    let maxPathMm = 0
    for (const i of idxs) {
      const dist = Math.hypot(dots[i].x - anchor.x, dots[i].y - anchor.y)
      if (dist > maxPathMm) maxPathMm = dist
    }
    const wireLenM = round2((maxPathMm / 1000) * reserve)
    const currentA = round2(ratedW / voltageV)

    const tier = tiers.find((t) => t >= needW - 1e-9) ?? null
    const powerOk = tier !== null

    const pw = pickWire(preset, currentA, wireLenM, dropLimitV)
    const dropRatioPct = round2((pw.dropV / voltageV) * 100)

    // 按字归属 + 跨区方位
    const partAgg = new Map<number, { char: string; n: number; sx: number; sy: number }>()
    for (const i of idxs) {
      const d = dots[i]
      const hit = partAgg.get(d.charIndex) ?? { char: d.char, n: 0, sx: 0, sy: 0 }
      hit.n++
      hit.sx += d.x
      hit.sy += d.y
      partAgg.set(d.charIndex, hit)
    }
    const charParts: ZoneCharPart[] = []
    for (const [charIndex, agg] of partAgg) {
      const pc = layout.chars[charIndex]
      const px = agg.sx / agg.n
      const py = agg.sy / agg.n
      const ccx = pc ? pc.x + pc.inkW / 2 : px
      const ccy = pc ? pc.y + pc.inkH / 2 : py
      const dx = px - ccx
      const dy = py - ccy
      let side = '整字'
      if (Math.abs(dx) >= Math.abs(dy)) side = dx < 0 ? '左半' : '右半'
      else side = dy < 0 ? '上半' : '下半'
      charParts.push({ charIndex, char: agg.char, modules: agg.n, side, cx: round2(px), cy: round2(py) })
    }
    charParts.sort((a, b) => a.charIndex - b.charIndex)

    const reasons: string[] = []
    const remedies: string[] = []
    if (!powerOk) {
      reasons.push(`额定 ${ratedW}W 超过最大档位 ${maxTier}W 电源可用功率 ${capW}W（${maxTier}×${efficiency}）`)
      remedies.push(`换大电源（增加大于 ${needW}W 的档位）或缩小本分区；并核对单模组功率/安全系数`)
    }
    if (!pw.ampOk) {
      reasons.push(`电流 ${currentA}A 超过最粗线 ${preset.wiring.wires[preset.wiring.wires.length - 1].spec} 载流量 ${preset.wiring.wires[preset.wiring.wires.length - 1].ampacityA}A`)
      remedies.push('缩小分区（减少每区模组）或改用 24V 模组降电流')
    }
    if (!pw.dropOk) {
      reasons.push(`最远灯珠压降 ${pw.dropV}V（${dropRatioPct}%）超过限值 ${dropLimitV}V（${round2(dropRatio * 100)}%），建议线 ${pw.wire.spec} 仍不达标`)
      remedies.push('换更粗的线；若已是最粗规格则缩小分区（缩短线长）或换 24V 模组')
    }
    if (capModules > 0 && modules > capModules) {
      reasons.push(`模组数 ${modules} 只超过每区上限 ${capModules} 只`)
      remedies.push('缩小分区或放宽每区模组上限')
    }
    const feasible = powerOk && pw.ampOk && pw.dropOk && !(capModules > 0 && modules > capModules)

    zones.push({
      no,
      modules,
      ratedW,
      needW,
      psuW: tier,
      psuCount: tier ? 1 : 0,
      bbox: { x0: round2(x0), y0: round2(y0), x1: round2(x1), y1: round2(y1) },
      spanMm,
      anchor: { x: round2(anchor.x), y: round2(anchor.y), edge: anchor.edge },
      maxPathMm: round2(maxPathMm),
      wireLenM,
      currentA,
      wire: pw.wire,
      dropV: pw.dropV,
      dropLimitV,
      dropRatioPct,
      ampOk: pw.ampOk,
      dropOk: pw.dropOk,
      powerOk,
      feasible,
      reasons,
      remedies,
      chars: charParts,
      centerX: round2(cx),
      centerY: round2(cy)
    })
  })

  // 跨区字（只可能出现在就近分区）与接法说明
  const charZones = new Map<number, number[]>()
  for (const z of zones) {
    for (const cp of z.chars) {
      const arr = charZones.get(cp.charIndex) ?? []
      arr.push(z.no)
      charZones.set(cp.charIndex, arr)
    }
  }
  const splitChars: SplitChar[] = []
  for (const [charIndex, zoneNos] of charZones) {
    if (zoneNos.length < 2) continue
    const parts = zoneNos.map((zn) => {
      const z = zones[zn - 1]
      const cp = z.chars.find((c) => c.charIndex === charIndex)
      return { zoneNo: zn, modules: cp?.modules ?? 0, side: cp?.side ?? '' }
    })
    const charName = zones.find((z) => z.chars.some((c) => c.charIndex === charIndex))?.chars.find((c) => c.charIndex === charIndex)?.char ?? String(charIndex)
    const desc = parts.map((p) => `第${p.zoneNo}区 ${p.modules} 只（${p.side}）`).join('，')
    splitChars.push({
      charIndex,
      char: charName,
      parts,
      instruction:
        `「${charName}」跨 ${parts.length} 区：${desc}；按字形${parts.every((p) => p.side.includes('半')) ? '中线' : '分界'}分两侧就近接入，` +
        '交界位置模组现场按中线判定归属；两区各自独立回路，严禁并接，车间在工艺卡上逐字勾确认。'
    })
  }
  splitChars.sort((a, b) => a.charIndex - b.charIndex)

  for (const z of zones) {
    if (!z.feasible) blockReasons.push(...z.reasons.map((r) => `第${z.no}区：${r}`))
  }
  // 空排版（还没输入文字）不算校核失败：无区可划、无需拦截
  const feasible = dots.length === 0 || zones.every((z) => z.feasible)
  const totalModules = zones.reduce((s, z) => s + z.modules, 0)
  const totalRatedW = round2(zones.reduce((s, z) => s + z.ratedW, 0))
  const totalWireM = round2(zones.reduce((s, z) => s + z.wireLenM, 0))

  const formulaNote =
    `每区可用功率 = 最大档位 ${maxTier}W × 效率 ${efficiency} = ${capW}W；` +
    `最远灯珠压降 ΔU = 2 × 线径系数 ρ ${round2(preset.wiring.resistivity)} × 线长L × 电流I ÷ 线径S，` +
    `限值 ${voltageV}V × ${round2(dropRatio * 100)}% = ${dropLimitV}V；线长含余量 ×${reserve}（往返按 2ρLI 计）。`

  return {
    mode: cfg.mode,
    modeLabel: zoneModeLabel(cfg.mode),
    voltageV,
    dots,
    dotZoneNo,
    zones,
    zoneCount: zones.length,
    totalModules,
    totalRatedW,
    psuCount: feasible ? zones.length : zones.reduce((s, z) => s + z.psuCount, 0),
    totalWireM,
    splitChars,
    feasible,
    blocked: !feasible,
    blockReasons,
    formulaNote
  }
}

/* ---------------- 两次划分对比（沿用同一走法，换规格重划） ---------------- */

export interface ZoningDiff {
  sameMode: boolean
  zoneCountBefore: number
  zoneCountAfter: number
  moduleDelta: number
  wireDelta: number
  psuCountDelta: number
  splitBefore: number
  splitAfter: number
  /** 按区号对齐的逐区差别 */
  zoneChanges: Array<{
    no: number
    before: { modules: number; wireLenM: number; psuW: number | null; wireSpec: string } | null
    after: { modules: number; wireLenM: number; psuW: number | null; wireSpec: string } | null
    changes: string[]
  }>
  /** 字的归属发生变化（换到别的区 / 由整字变拆分） */
  movedChars: Array<{ key: string; char: string; before: string; after: string }>
  identical: boolean
}

export function snapshotZoning(r: ZoningResult): ZoneSnapshot {
  return {
    mode: r.mode,
    voltageV: r.voltageV,
    zoneCount: r.zoneCount,
    totalModules: r.totalModules,
    psuCount: r.psuCount,
    totalWireM: r.totalWireM,
    zones: r.zones.map((z) => ({
      no: z.no,
      modules: z.modules,
      ratedW: z.ratedW,
      wireLenM: z.wireLenM,
      psuW: z.psuW,
      wireSpec: z.wire.spec,
      chars: z.chars.map((c) => ({ key: `${c.charIndex}#${c.char}`, char: c.char, modules: c.modules, side: c.side }))
    })),
    splits: r.splitChars.map((s) => ({ key: `${s.charIndex}#${s.char}`, char: s.char, instruction: s.instruction }))
  }
}

/** 列两次划分的差别（换模组/电源规格重划前后；走法应保持一致） */
export function diffZoning(before: ZoneSnapshot, after: ZoneSnapshot): ZoningDiff {
  const zoneChanges: ZoningDiff['zoneChanges'] = []
  const n = Math.max(before.zoneCount, after.zoneCount)
  for (let i = 0; i < n; i++) {
    const b = before.zones[i] ?? null
    const a = after.zones[i] ?? null
    const changes: string[] = []
    if (b && a) {
      if (b.modules !== a.modules) changes.push(`模组 ${b.modules} → ${a.modules} 只`)
      if (b.wireLenM !== a.wireLenM) changes.push(`线长 ${b.wireLenM} → ${a.wireLenM} m`)
      if (b.psuW !== a.psuW) changes.push(`电源 ${b.psuW ?? '超档'} → ${a.psuW ?? '超档'} W`)
      if (b.wireSpec !== a.wireSpec) changes.push(`线径 ${b.wireSpec} → ${a.wireSpec}`)
    } else if (!a) {
      changes.push(`本区划除（原 ${b?.modules} 只 / ${b?.wireLenM}m）`)
    } else {
      changes.push(`新增区（${a.modules} 只 / ${a.wireLenM}m / ${a.psuW ?? '超档'}W）`)
    }
    zoneChanges.push({
      no: i + 1,
      before: b ? { modules: b.modules, wireLenM: b.wireLenM, psuW: b.psuW, wireSpec: b.wireSpec } : null,
      after: a ? { modules: a.modules, wireLenM: a.wireLenM, psuW: a.psuW, wireSpec: a.wireSpec } : null,
      changes
    })
  }

  // 字归属：「第n区/侧」摘要
  const charMap = (s: ZoneSnapshot): Map<string, { char: string; text: string }> => {
    const m = new Map<string, { char: string; text: string }>()
    for (const z of s.zones) {
      for (const c of z.chars) {
        const hit = m.get(c.key)
        const seg = `${z.no}区${c.side === '整字' ? '' : c.side}×${c.modules}`
        m.set(c.key, { char: c.char, text: hit ? `${hit.text}+${seg}` : seg })
      }
    }
    return m
  }
  const beforeMap = charMap(before)
  const afterMap = charMap(after)
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()])
  const movedChars: ZoningDiff['movedChars'] = []
  for (const key of keys) {
    const b = beforeMap.get(key)?.text ?? ''
    const a = afterMap.get(key)?.text ?? ''
    if (b !== a) movedChars.push({ key, char: (afterMap.get(key) ?? beforeMap.get(key))!.char, before: b || '（无）', after: a || '（无）' })
  }

  const identical =
    before.mode === after.mode &&
    before.zoneCount === after.zoneCount &&
    before.totalModules === after.totalModules &&
    before.totalWireM === after.totalWireM &&
    before.psuCount === after.psuCount &&
    before.splits.length === after.splits.length &&
    zoneChanges.every((z) => z.changes.length === 0) &&
    movedChars.length === 0

  return {
    sameMode: before.mode === after.mode,
    zoneCountBefore: before.zoneCount,
    zoneCountAfter: after.zoneCount,
    moduleDelta: after.totalModules - before.totalModules,
    wireDelta: round2(after.totalWireM - before.totalWireM),
    psuCountDelta: after.psuCount - before.psuCount,
    splitBefore: before.splits.length,
    splitAfter: after.splits.length,
    zoneChanges,
    movedChars,
    identical
  }
}

/* ---------------- 分区基线快照（localStorage，按项目存） ---------------- */

const KEY_BASE = 'app029.zoneBaseline.v1'

export function loadZoneBaseline(projectId: string): ZoneSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY_BASE)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, ZoneSnapshot>
    return map[projectId] ?? null
  } catch {
    return null
  }
}

export function saveZoneBaseline(projectId: string, snapshot: ZoneSnapshot): void {
  try {
    const raw = localStorage.getItem(KEY_BASE)
    const map = raw ? (JSON.parse(raw) as Record<string, ZoneSnapshot>) : {}
    map[projectId] = snapshot
    localStorage.setItem(KEY_BASE, JSON.stringify(map))
  } catch {
    // 本地存储不可用：忽略，不影响分区功能
  }
}

export function clearZoneBaseline(projectId: string): void {
  try {
    const raw = localStorage.getItem(KEY_BASE)
    if (!raw) return
    const map = JSON.parse(raw) as Record<string, ZoneSnapshot>
    delete map[projectId]
    localStorage.setItem(KEY_BASE, JSON.stringify(map))
  } catch {
    // 忽略
  }
}
