/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），再做分层拼版；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { nestPieces, type CutItem, type NestingResult, type Piece } from './nesting'
import { computeLed, type PsuPreset } from './led'
import { normalizeZoneCfg, planZoning, r2 as zr2, type WiringPreset, type ZoningResult } from './zoning'

export interface SheetSpec {
  id: string
  spec: string
  wMm: number
  hMm: number
  thicknessMm: number
  priceCents: number
  kerfMm: number
}

export interface LedModuleSpec {
  id: string
  spec: string
  spacingMm: number
  powerW: number
  lumen: number
  priceCents: number
  voltageV: number
}

export interface RuleSpec {
  type: 'perPieceAreaM2' | 'perChar' | 'perMeterPerimeter' | 'perPsu' | 'perModule' | 'perStrokeBlock' | 'perOutlinePerimeter'
  value: number
  minQty: number
}

export interface ConsumableSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface LaborSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface PanelMaterialSpec {
  id: string
  name: string
  desc: string
  useLed: boolean
  areaPriceCentsPerM2: number
  perimeterPriceCentsPerM: number
  charLaborCents: number
}

export interface Preset {
  version: string
  process: {
    strokeLimitMm: number
    defaultTrackRatio: number
    defaultMarginRatio: number
    defaultLineGapRatio: number
    panelFrameMm: number
    minTrackMm: number
    maxTrackMm: number
    warnTrackRatioLow: number
    warnTrackRatioHigh: number
  }
  acrylicSheets: SheetSpec[]
  ledModules: LedModuleSpec[]
  psu: PsuPreset
  /** 供电分区与线损校核参数（线径表、电阻率、压降上限等） */
  wiring: WiringPreset
  consumables: ConsumableSpec[]
  labor: LaborSpec[]
  panelMaterials: PanelMaterialSpec[]
}

export const defaultPreset = materialsData as unknown as Preset

export interface BomResult {
  materials: Material[]
  totalCents: number
  led: LedResult
  nesting: NestingResult
  sheet: SheetSpec
  module: LedModuleSpec
  cutList: CutItem[]
  pieceAreaM2: number
  outlinePerimeterM: number
  /** 供电分区与线损校核结果（非发光材质时为 null） */
  zoning: ZoningResult | null
  /** 分区电源线按线径汇总（规格 → 米数），供导出与接线清单使用 */
  zoneWireTotals: Array<{ spec: string; mm2: number; meters: number }>
  /** 工艺拦截：未确认风险时不出报价 */
  blocked: boolean
  blockReasons: string[]
  panelMaterial: PanelMaterialSpec
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
  /** 已确认「分区/线损校核不通过」仍要出报价（仅用于打印草稿，默认拦截） */
  acknowledgeZoning?: boolean
}

function ruleQty(rule: RuleSpec, ctx: { areaM2: number; chars: number; perimeterM: number; psu: number; modules: number; blocks: number; outlinePerimeterM: number }): number {
  let raw = 0
  switch (rule.type) {
    case 'perPieceAreaM2':
      raw = ctx.areaM2 * rule.value
      break
    case 'perChar':
      raw = ctx.chars * rule.value
      break
    case 'perMeterPerimeter':
      raw = ctx.perimeterM * rule.value
      break
    case 'perPsu':
      raw = ctx.psu * rule.value
      break
    case 'perModule':
      raw = ctx.modules * rule.value
      break
    case 'perStrokeBlock':
      raw = ctx.blocks * rule.value
      break
    case 'perOutlinePerimeter':
      raw = ctx.outlinePerimeterM * rule.value
      break
    default:
      raw = 0
  }
  return Math.max(rule.minQty, raw)
}

/** 拆料件：每个连通域（笔画块）一件，按外接矩形计 */
export function acrylicPieces(chars: PlacedChar[]): Piece[] {
  const out: Piece[] = []
  let seq = 0
  for (const c of chars) {
    if (c.missing || c.blank || c.geom.blockBBoxes.length === 0) continue
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    c.geom.blockBBoxes.forEach((b, bi) => {
      const wMm = Math.max(1, Math.ceil((b.x1 - b.x0) * k))
      const hMm = Math.max(1, Math.ceil((b.y1 - b.y0) * k))
      out.push({ id: `p${seq++}`, label: `${c.char}-${bi + 1}`, wMm, hMm })
    })
  }
  return out
}

export function buildBom(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): BomResult {
  const sheet = preset.acrylicSheets.find((s) => s.id === project.sheetId) ?? preset.acrylicSheets[0]
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const panelMaterial = preset.panelMaterials.find((m) => m.id === project.panelMaterialId) ?? preset.panelMaterials[0]
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  // 供电分区与线损校核（发光材质）：材料用量跟着分区结果走
  const zoneCfg = normalizeZoneCfg(project.zone, preset.wiring)
  const zoning: ZoningResult | null = panelMaterial.useLed
    ? planZoning(layout.chars, project.led, module.voltageV, preset.psu.tiers, preset.wiring, zoneCfg, project.layout.panel.hMm)
    : null
  const zoneWireTotals = aggregateZoneWire(zoning)

  const pieces = acrylicPieces(layout.chars)
  const nesting = nestPieces(pieces, sheet.wMm, sheet.hMm, sheet.kerfMm, true)
  const pieceAreaM2 = nesting.totalPieceAreaMm2 / 1e6
  const outerPerimeterMm = layout.chars.reduce((s, c) => {
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    return s + c.geom.outerPerimeter * k
  }, 0)
  const perimeterM = outerPerimeterMm / 1000
  const outlinePerimeterM =
    layout.chars.reduce((s, c) => {
      if (c.item.mode !== 'outline') return s
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length

  const ctx = {
    areaM2: pieceAreaM2,
    chars: charCount,
    perimeterM,
    psu: zoning ? zoning.psuCount : led.psuCount,
    modules: zoning ? zoning.totalModules : led.modules,
    blocks: layout.chars.reduce((s, c) => s + (c.missing || c.blank ? 0 : c.geom.strokeBlocks), 0),
    outlinePerimeterM
  }

  const materials: Material[] = []
  // 1) 亚克力面板（按板计）
  materials.push({
    kind: 'acrylic',
    spec: sheet.spec,
    qty: nesting.sheetCount,
    unit: '张',
    unitPriceCents: sheet.priceCents,
    amountCents: nesting.sheetCount * sheet.priceCents
  })
  // 2) LED 模组（数量以分区校核口径为准：逐笔画块取整之和）
  if (panelMaterial.useLed) {
    const moduleQty = zoning ? zoning.totalModules : led.modules
    materials.push({
      kind: 'led_module',
      spec: module.spec,
      qty: moduleQty,
      unit: '只',
      unitPriceCents: module.priceCents,
      amountCents: moduleQty * module.priceCents
    })
    // 3) 电源：台数与档位跟分区结果走（每区一台）
    const psuTierW = zoning && zoning.zoneCount > 0 ? zoning.psuTierW : led.psuUnitW
    const psuQty = zoning ? zoning.psuCount : led.psuCount
    const psuUnitPrice = Math.round(preset.psu.pricePerWattCents * psuTierW)
    materials.push({
      kind: 'psu',
      spec: `${preset.psu.spec} ${psuTierW}W`,
      qty: psuQty,
      unit: '台',
      unitPriceCents: psuUnitPrice,
      amountCents: psuQty * psuUnitPrice
    })
  }
  // 4) 胶与配件（描边条在下面按描边字数单独计；电源线在发光方案中按分区线长单列）
  for (const c of preset.consumables) {
    if (c.id === 'trim') continue
    if (c.id === 'wire' && panelMaterial.useLed) continue
    const raw = ruleQty(c.rule, ctx)
    const whole = ['支', '套', '个', '台'].includes(c.unit)
    const qty = whole ? Math.ceil(raw) : Math.round(raw * 100) / 100
    if (qty <= 0) continue
    materials.push({
      kind: 'glue',
      spec: c.spec,
      qty,
      unit: c.unit,
      unitPriceCents: c.unitPriceCents,
      amountCents: Math.round(qty * c.unitPriceCents)
    })
  }
  // 分区电源线：按线径汇总，米数与单价都跟着分区校核结果走
  if (panelMaterial.useLed) {
    for (const w of zoneWireTotals) {
      const qty = zr2(w.meters)
      materials.push({
        kind: 'glue',
        spec: `${preset.wiring.spec} ${w.spec}（分区线损校核汇总）`,
        qty,
        unit: '米',
        unitPriceCents: preset.wiring.wirePriceCentsPerM,
        amountCents: Math.round(qty * preset.wiring.wirePriceCentsPerM)
      })
    }
  }
  if (outlinePerimeterM > 0) {
    const trim = preset.consumables.find((c) => c.id === 'trim')
    if (trim) {
      const raw = ruleQty(trim.rule, ctx)
      const qty = Math.ceil(raw * 100) / 100
      materials.push({
        kind: 'glue',
        spec: trim.spec,
        qty,
        unit: trim.unit,
        unitPriceCents: trim.unitPriceCents,
        amountCents: Math.round(qty * trim.unitPriceCents)
      })
    }
  }
  // 5) 加工费
  for (const l of preset.labor) {
    if ((l.id === 'ledmount' || l.id === 'psuinstall') && !panelMaterial.useLed) continue
    const raw = ruleQty(l.rule, ctx)
    const whole = ['字', '台', '个', '套'].includes(l.unit)
    const qty = whole ? Math.ceil(raw) : Math.round(raw * 100) / 100
    if (qty <= 0) continue
    materials.push({
      kind: 'labor',
      spec: l.spec,
      qty,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents: Math.round(qty * l.unitPriceCents)
    })
  }

  const totalCents = materials.reduce((s, m) => s + m.amountCents, 0)
  const thin = layout.glyphs.filter((g) => !g.missing && g.minStrokeMm > 0 && g.minStrokeMm < project.layout.settings.strokeLimitMm)
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...nesting.oversize.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${sheet.wMm}×${sheet.hMm}mm`),
    ...(zoning && !zoning.ok ? zoning.blockReasons : [])
  ]
  const blocked =
    (thin.length > 0 && !opts.acknowledgeThinStroke) ||
    nesting.oversize.length > 0 ||
    (!!zoning && !zoning.ok && !opts.acknowledgeZoning)

  return {
    materials,
    totalCents,
    led,
    nesting,
    sheet,
    module,
    cutList: nesting.cutList,
    pieceAreaM2,
    outlinePerimeterM,
    zoning,
    zoneWireTotals,
    blocked,
    blockReasons,
    panelMaterial
  }
}

/** 分区电源线按线径规格汇总（米，两位小数） */
export function aggregateZoneWire(zoning: ZoningResult | null): Array<{ spec: string; mm2: number; meters: number }> {
  if (!zoning) return []
  const map = new Map<string, { mm2: number; meters: number }>()
  for (const z of zoning.zones) {
    const hit = map.get(z.wire.spec)
    if (hit) hit.meters = zr2(hit.meters + z.wireMm / 1000)
    else map.set(z.wire.spec, { mm2: z.wire.mm2, meters: zr2(z.wireMm / 1000) })
  }
  return [...map.entries()].map(([spec, v]) => ({ spec, mm2: v.mm2, meters: v.meters })).sort((a, b) => a.mm2 - b.mm2)
}

/** 断言：Σ 材料金额 = 合计，且金额均为整数分 */
export function assertBomSum(bom: BomResult): { ok: boolean; message: string } {
  const sum = bom.materials.reduce((s, m) => s + m.amountCents, 0)
  const allInt = bom.materials.every((m) => Number.isInteger(m.amountCents))
  return {
    ok: sum === bom.totalCents && allInt,
    message: `Σ 明细 = ${sum} 分，合计 = ${bom.totalCents} 分；整数分校验：${allInt ? '通过' : '失败'}`
  }
}

/** 多材质成本对照（规格书第 5 节） */
export interface CompareRow {
  id: string
  name: string
  desc: string
  panelCents: number
  ledCents: number
  psuCents: number
  accessoryCents: number
  laborCents: number
  totalCents: number
}

export function compareMaterials(project: Project, layout: LayoutResult, preset: Preset, bom: BomResult): CompareRow[] {
  const pieceAreaM2 = bom.pieceAreaM2
  const perimeterM =
    layout.chars.reduce((s, c) => {
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length
  const sumOf = (kind: Material['kind']): number => bom.materials.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
  const ledCents = sumOf('led_module')
  const psuCents = sumOf('psu')
  const accessoryCents = sumOf('glue')
  const laborTotal = sumOf('labor')

  return preset.panelMaterials.map((pm) => {
    // 当前选中方案：直接采用实际材料清单（与报价单完全一致，避免两套算法打架）
    if (pm.id === project.panelMaterialId) {
      return {
        id: pm.id,
        name: pm.name,
        desc: pm.desc,
        panelCents: sumOf('acrylic'),
        ledCents,
        psuCents,
        accessoryCents,
        laborCents: laborTotal,
        totalCents: bom.totalCents
      }
    }
    // 其它方案：按预设单价估算（不含 LED 的方案不计模组与电源）
    const panelCents = Math.round(
      pieceAreaM2 * pm.areaPriceCentsPerM2 + perimeterM * pm.perimeterPriceCentsPerM + charCount * pm.charLaborCents
    )
    const useLed = pm.useLed
    const led = useLed ? ledCents : 0
    const psu = useLed ? psuCents : 0
    const acc = useLed ? accessoryCents : Math.round(accessoryCents * 0.4)
    const labor = useLed ? laborTotal : Math.round(laborTotal * 0.55)
    return {
      id: pm.id,
      name: pm.name,
      desc: pm.desc,
      panelCents,
      ledCents: led,
      psuCents: psu,
      accessoryCents: acc,
      laborCents: labor,
      totalCents: panelCents + led + psu + acc + labor
    }
  })
}

/** 当前方案是否为「按实际材料清单」，用于界面标注 */
export function isActualRow(project: Project, row: CompareRow): boolean {
  return row.id === project.panelMaterialId
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}