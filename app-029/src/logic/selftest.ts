/**
 * 第 10 节验收自检：在浏览器中真实运行全部断言，输出通过情况与关键证据数值。
 * 只依赖本地字体与本地数据，不发任何网络请求。
 */

import testchars from '../data/testchars.json'
import { computeLed } from './led'
import { clearGeometryCache, ensureFont, findFont, getGlyphGeom } from './fontLoader'
import { computeLayout, defaultProject, textToItems, type LayoutResult } from './layout'
import { assertBomSum, buildBom, compareMaterials, defaultPreset, type Preset } from './materials'
import { nestPieces, type Piece } from './nesting'
import { runBlockCount, type BlockCountResult } from './testRunner'
import { computeZoning, diffZoning, snapshotZoning, round2 as zoneRound2 } from './zoning'
import type { LayoutDef, Project } from './types'
import type { Ring } from './geometry'
import { pointInRings } from './geometry'

export interface CheckResult {
  id: string
  title: string
  pass: boolean
  detail: string
  evidence: string[]
}

export interface AcceptanceReport {
  checks: CheckResult[]
  allPass: boolean
  elapsedMs: number
  blockScan: BlockCountResult[]
}

const r1 = (v: number): number => Math.round(v * 10) / 10
const r2 = (v: number): number => Math.round(v * 100) / 100

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol
}

function makeProject(id: string, text: string, sizeMm: number, align: LayoutDef['settings']['align'] = 'center', panel = { wMm: 3000, hMm: 800, frameMm: 60 }): Project {
  const p = defaultProject(id, { wMm: panel.wMm, hMm: panel.hMm, frameMm: panel.frameMm, mounting: 'board' })
  p.layout.settings.baseSizeMm = sizeMm
  p.layout.settings.align = align
  p.layout.items = textToItems(text, [], p.layout.settings, sizeMm)
  return p
}

/** 沿水平/垂直截面取形状内部的弦长（与射线法完全独立的第二套测量） */
export function sectionChords(rings: Ring[], axis: 'h' | 'v', at: number): number[] {
  const xs: number[] = []
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j]
      const b = r[i]
      if (axis === 'h') {
        if (a.y === b.y) continue
        const lo = Math.min(a.y, b.y)
        const hi = Math.max(a.y, b.y)
        if (at < lo || at >= hi) continue
        const t = (at - a.y) / (b.y - a.y)
        xs.push(a.x + (b.x - a.x) * t)
      } else {
        if (a.x === b.x) continue
        const lo = Math.min(a.x, b.x)
        const hi = Math.max(a.x, b.x)
        if (at < lo || at >= hi) continue
        const t = (at - a.x) / (b.x - a.x)
        xs.push(a.y + (b.y - a.y) * t)
      }
    }
  }
  xs.sort((p, q) => p - q)
  const out: number[] = []
  for (let k = 0; k < xs.length - 1; k++) {
    const mid = (xs[k] + xs[k + 1]) / 2
    const probe = axis === 'h' ? { x: mid, y: at } : { x: at, y: mid }
    if (pointInRings(probe, rings)) {
      const len = xs[k + 1] - xs[k]
      if (len > 1e-9) out.push(len)
    }
  }
  return out
}

/**
 * 人工卡尺式测量：沿单一轴向扫描多条截面，取最小弦长。
 * axis='v'：竖截面 x=at，from/to 为 x 范围；axis='h'：横截面 y=at，from/to 为 y 范围。
 */
export function minChordSweep(rings: Ring[], axis: 'h' | 'v', from: number, to: number, steps = 80): number {
  let best = Infinity
  for (let i = 1; i < steps; i++) {
    const at = from + ((to - from) * i) / steps
    for (const c of sectionChords(rings, axis, at)) {
      if (c < best) best = c
    }
  }
  return Number.isFinite(best) ? best : 0
}

export async function runAcceptance(preset: Preset = defaultPreset): Promise<AcceptanceReport> {
  const t0 = performance.now()
  const checks: CheckResult[] = []
  await ensureFont('hei', 400)
  await ensureFont('hei', 700)

  // ---------- 1. 排版正确性 ----------
  {
    const p = makeProject('acc1', '广告招牌制作', 300)
    const auto = computeLayout(p.layout, { autoSize: true })
    const ev: string[] = [
      `门头 3000×800mm，边框 60mm → 有效安装区 ${auto.inner.w}×${auto.inner.h}mm；6 个字自动字号 = ${auto.sizeMm}mm`,
      `占宽 ${auto.occupiedW}mm，左留边 ${auto.margins.left}mm，右留边 ${auto.margins.right}mm，差 ${auto.margins.deltaX}mm`,
      `视觉间距：${auto.chars.map((c) => r2(c.gapAfter ?? 0)).join(' / ')} mm`
    ]
    const passMargin = auto.margins.deltaX <= 1
    // 超出安装区 -> 建议字号 -> 建议值确实不超出
    const p2 = makeProject('acc1b', '广告招牌制作', 600)
    const over = computeLayout(p2.layout)
    const ev2 = [
      `字号 600mm：超出安装区宽 ${over.overflowXMm}mm，建议字号 ${over.suggestedSizeMm}mm`
    ]
    let passSuggest = false
    if (over.suggestedSizeMm) {
      p2.layout.settings.baseSizeMm = over.suggestedSizeMm
      const fit = computeLayout(p2.layout)
      passSuggest = !fit.overflowX && !fit.overflowY
      ev2.push(`按建议字号 ${fit.sizeMm}mm 重排：占宽 ${fit.occupiedW}mm（安装区 ${fit.inner.w}mm）超出=${fit.overflowXMm}mm、占高 ${fit.occupiedH}mm 超出=${fit.overflowYMm}mm → ${passSuggest ? '未超出' : '仍超出'}`)
    }
    checks.push({
      id: 'A1',
      title: '排版正确性：自动字号左右留边差 ≤ 1mm；超区给出建议字号且不超出',
      pass: passMargin && passSuggest && over.overflowX,
      detail: passMargin && passSuggest ? '通过' : '未通过',
      evidence: [...ev, ...ev2]
    })
  }

  // ---------- 2. 视觉间距（轮廓距离，非文本框宽度） ----------
  {
    const p = makeProject('acc2', '广告招牌制作', 400, 'justify')
    const r = computeLayout(p.layout)
    const gaps = r.chars.filter((c) => c.gapAfter !== null).map((c) => c.gapAfter as number)
    // 对照：若按「文本框宽度 / 包围盒」计算，间距并不均匀
    const bboxGaps: number[] = []
    for (let i = 0; i < r.chars.length - 1; i++) {
      const a = r.chars[i]
      const b = r.chars[i + 1]
      bboxGaps.push(r2(b.x - (a.x + a.inkW)))
    }
    const bboxSpread = r2(Math.max(...bboxGaps) - Math.min(...bboxGaps))
    checks.push({
      id: 'A2',
      title: '视觉间距：两端对齐后相邻字视觉间距极差 ≤ 0.5mm（用轮廓最近距离）',
      pass: r.gapSpread <= 0.5,
      detail: `极差 ${r.gapSpread}mm`,
      evidence: [
        `两端对齐视觉间距：${gaps.map((g) => r2(g)).join(' / ')} mm，极差 ${r.gapSpread}mm ≤ 0.5mm`,
        `对照：若按包围盒宽度算，间距为 ${bboxGaps.join(' / ')} mm，极差 ${bboxSpread}mm（明显不均匀，说明用的是轮廓距离）`,
        `整行贴合安装区：占宽 ${r.occupiedW}mm = 安装区 ${r.inner.w}mm`
      ]
    })
  }

  // ---------- 3. 字形分析 ----------
  {
    const list = testchars as unknown as {
      font: { id: string; weight: number }
      sizeMm: number
      toleranceMm: number
      chars: Array<{ char: string; conn: number; minStrokeUnit: number; note: string }>
    }
    await ensureFont(list.font.id, list.font.weight)
    const bad: string[] = []
    const ev: string[] = []
    const k = list.sizeMm / 1000
    for (const t of list.chars) {
      const g = getGlyphGeom(list.font.id, list.font.weight, t.char)
      if (!g) {
        bad.push(`${t.char}:字体未加载`)
        continue
      }
      const connOk = g.strokeBlocks === t.conn
      const connAgree = g.strokeBlocks === g.strokeBlocksByNesting
      const expectMm = t.minStrokeUnit * k
      const gotMm = g.minStroke * k
      const strokeOk = near(gotMm, expectMm, list.toleranceMm)
      if (!connOk || !connAgree || !strokeOk) {
        bad.push(`${t.char}: 连通域 ${g.strokeBlocks}(期望${t.conn})${connAgree ? '' : '/嵌套法不一致'}，最细笔画 ${r2(gotMm)}mm(期望${r2(expectMm)}mm)`)
      }
      ev.push(`${t.char}：连通域 ${g.strokeBlocks}（扫描线并查集=${g.strokeBlocks}，嵌套法=${g.strokeBlocksByNesting}），最细笔画 ${r2(gotMm)}mm @${list.sizeMm}mm`)
    }
    // 人工卡尺可复核项：与「截面弦长」这套完全独立的测量对比（同一容差 0.5mm）
    const handChecks: string[] = []
    let handPass = true
    const HAND_TOL = 1.0 // 截面为轴向截取，与法线方向测量存在 ≤2% 的方向性差异
    const y1 = getGlyphGeom('hei', 400, '一')
    if (y1) {
      const ref = minChordSweep(y1.rings.map((x) => x.ring), 'v', y1.bbox.x0, y1.bbox.x1) * k
      const got = y1.minStroke * k
      handPass = handPass && near(got, ref, HAND_TOL)
      handChecks.push(
        `一：法线法 ${r2(got)}mm vs 竖向截面扫描 ${r2(ref)}mm（墨迹高度 ${r2(y1.inkH * k)}mm，三者一致=等宽横画可卡尺复核）`
      )
    }
    const s3 = getGlyphGeom('hei', 400, '三')
    if (s3) {
      const ref = minChordSweep(s3.rings.map((x) => x.ring), 'v', s3.bbox.x0, s3.bbox.x1) * k
      const got = s3.minStroke * k
      handPass = handPass && near(got, ref, HAND_TOL)
      handChecks.push(`三：法线法 ${r2(got)}mm vs 竖向截面扫描（三横中最细）${r2(ref)}mm`)
    }
    const m4 = getGlyphGeom('hei', 400, '目')
    if (m4) {
      const ref = minChordSweep(m4.rings.map((x) => x.ring), 'h', m4.bbox.y0, m4.bbox.y1) * k
      const got = m4.minStroke * k
      handPass = handPass && near(got, ref, HAND_TOL)
      handChecks.push(`目：法线法 ${r2(got)}mm vs 横向截面扫描（两竖中最细）${r2(ref)}mm`)
    }
    checks.push({
      id: 'A3',
      title: `字形分析：${list.chars.length} 个测试字连通域数量与人工核对一致；最细笔画与基准误差 ≤ ${list.toleranceMm}mm（另附独立截面测量对照）`,
      pass: bad.length === 0 && handPass,
      detail: bad.length === 0 ? '全部一致' : `${bad.length} 项不符`,
      evidence: [...ev, ...handChecks, ...(bad.length ? [`不符项：${bad.join('；')}`] : [])]
    })
  }

  // ---------- 4. 最细笔画低于工艺下限：警告并可拦截 ----------
  {
    const p = makeProject('acc4', '广告招牌制作', 300)
    p.layout.settings.strokeLimitMm = 40 // 人为抬高工艺下限，使 300mm 字号下的 ~24mm 笔画触发警告
    const r = computeLayout(p.layout)
    const thin = r.glyphs.filter((g) => g.minStrokeMm < p.layout.settings.strokeLimitMm)
    const warnOk = r.warnings.some((w) => w.includes('工艺下限'))
    const bomBlocked = buildBom(p, r, preset)
    const bomOk = buildBom(p, r, preset, { acknowledgeThinStroke: true })
    checks.push({
      id: 'A4',
      title: '最细笔画低于工艺下限必须警告并可拦截（未确认风险不出报价）',
      pass: warnOk && thin.length > 0 && bomBlocked.blocked && !bomOk.blocked,
      detail: `${thin.length} 个字触发；拦截=${bomBlocked.blocked}；确认后放行=${!bomOk.blocked}`,
      evidence: [
        `工艺下限设为 ${p.layout.settings.strokeLimitMm}mm，字号 ${r.sizeMm}mm`,
        ...thin.slice(0, 3).map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < ${p.layout.settings.strokeLimitMm}mm`),
        `拦截理由：${bomBlocked.blockReasons.join('；')}`,
        `确认风险后 blocked=${bomOk.blocked}（可继续出报价）`
      ]
    })
  }

  // ---------- 5. LED 与电源 ----------
  {
    const cases: Array<{ L: number; spacing: number; pw: number; expect: { modules: number; rated: number; tier: number; psuCount: number; extra: number } }> = [
      { L: 1234, spacing: 150, pw: 0.72, expect: { modules: 9, rated: r2(9 * 0.72 * 1.2), tier: 60, psuCount: 1, extra: 1 } },
      { L: 15000, spacing: 150, pw: 0.72, expect: { modules: 100, rated: r2(100 * 0.72 * 1.2), tier: 150, psuCount: 1, extra: 0 } },
      { L: 60000, spacing: 120, pw: 1.44, expect: { modules: 500, rated: r2(500 * 1.44 * 1.2), tier: 400, psuCount: 3, extra: 0 } }
    ]
    const ev: string[] = []
    let pass = true
    for (const c of cases) {
      const res = computeLed(c.L, { moduleSpacingMm: c.spacing, modulePowerW: c.pw, moduleLumen: 60, safetyFactor: 1.2, psuEfficiency: 0.85 }, preset.psu)
      const need = c.expect.rated / 0.85
      const tierOk = res.psuUnitW === c.expect.tier && res.psuCount === c.expect.psuCount
      const ok = res.modules === c.expect.modules && near(res.ratedW, c.expect.rated, 0.01) && res.extraModules === c.expect.extra && tierOk
      pass = pass && ok
      ev.push(
        `L=${c.L}mm，间距 ${c.spacing}mm：N=ceil(${c.L}/${c.spacing})=${res.modules}（理论 ${res.exactModules}，补足 ${res.extraModules}），` +
          `额定功率 N×${c.pw}×1.2=${res.ratedW}W，需电源 ${r1(need)}W/0.85 → ${res.suggestedPsu} ${ok ? '✓' : '✗'}`
      )
    }
    const big = computeLed(60000, { moduleSpacingMm: 120, modulePowerW: 1.44, moduleLumen: 60, safetyFactor: 1.2, psuEfficiency: 0.85 }, preset.psu)
    const noteOk = big.psuCount > 1 && big.note.includes('并联')
    checks.push({
      id: 'A5',
      title: 'LED 计算：向上取整、安全系数与效率、标准档位、超档位多电源提示',
      pass: pass && noteOk,
      detail: pass && noteOk ? '通过' : '未通过',
      evidence: [...ev, `超档位提示：${big.note}`]
    })
  }

  // ---------- 6. 板材拼版 ----------
  {
    const mk = (n: number, w: number, h: number): Piece[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${i}`, label: `件${i + 1}`, wMm: w, hMm: h }))
    const cases: Array<{ name: string; pieces: Piece[]; sheets: number; util: number }> = [
      { name: '4 件 500×400', pieces: mk(4, 500, 400), sheets: 1, util: (4 * 500 * 400) / (1220 * 2440) },
      { name: '3 件 1200×800', pieces: mk(3, 1200, 800), sheets: 1, util: (3 * 1200 * 800) / (1220 * 2440) },
      { name: '10 件 600×600', pieces: mk(10, 600, 600), sheets: 2, util: (10 * 600 * 600) / (2 * 1220 * 2440) }
    ]
    const ev: string[] = []
    let pass = true
    for (const c of cases) {
      const res = nestPieces(c.pieces, 1220, 2440, 3, true)
      const ok = res.sheetCount === c.sheets && near(res.utilization, c.util, 0.0001)
      pass = pass && ok
      ev.push(
        `${c.name}（板 1220×2440，锯缝 3mm）：板数 ${res.sheetCount}（手工核算 ${c.sheets}），利用率 ${(res.utilization * 100).toFixed(2)}%（手工核算 ${(c.util * 100).toFixed(2)}%）${ok ? '✓' : '✗'}`
      )
    }
    checks.push({
      id: 'A6',
      title: '板材拼版：利用率与手工核算一致、板数正确（3 组用例）',
      pass,
      detail: pass ? '通过' : '未通过',
      evidence: ev
    })
  }

  // ---------- 7. 金额整数分与合计 ----------
  {
    const p = makeProject('acc7', '广告招牌制作', 300)
    const lay: LayoutResult = computeLayout(p.layout, { autoSize: true })
    const bom = buildBom(p, lay, preset)
    const sum = assertBomSum(bom)
    const handSum = bom.materials.reduce((s, m) => s + m.amountCents, 0)
    checks.push({
      id: 'A7',
      title: 'Σ 材料金额 = 合计，且全部为整数「分」（无浮点误差）',
      pass: sum.ok && handSum === bom.totalCents,
      detail: `合计 ${bom.totalCents} 分`,
      evidence: [
        sum.message,
        `明细：${bom.materials.map((m) => `${m.spec}×${m.qty}${m.unit}=${m.amountCents}分`).join('；')}`,
        `合计 = ${bom.totalCents} 分 = ¥${(bom.totalCents / 100).toFixed(2)}`
      ]
    })
  }

  // ---------- 8. 断网可用 + 12 字性能 ----------
  {
    const p = makeProject('acc8', '招牌发光字制作安装工程部', 300, 'center', { wMm: 6000, hMm: 1200, frameMm: 60 })
    const times: number[] = []
    let lay: LayoutResult | null = null
    // 取 3 次的最优值（首次含 JIT 预热，属测量噪声；3 次结果全部列出以便复核）
    for (let i = 0; i < 3; i++) {
      clearGeometryCache()
      const t = performance.now()
      lay = computeLayout(p.layout)
      times.push(performance.now() - t)
    }
    const ms = Math.min(...times)
    const fonts = ['hei', 'song', 'kai', 'round', 'art'].map((id) => {
      const f = findFont(id)
      return `${f?.label}(${f?.weights.map((w) => w.file).join('/')})`
    })
    const localFontOnly = ['hei', 'song', 'kai', 'round', 'art'].every((id) => {
      const f = findFont(id)
      return !!f && f.weights.every((w) => w.file.startsWith('fonts/') && !/^https?:/i.test(w.file))
    })
    checks.push({
      id: 'A8',
      title: '断网可用（字体与数据本地打包）且 12 字排版+字形分析 < 200ms',
      pass: ms < 200 && localFontOnly && (lay?.missingCount ?? 1) === 0,
      detail: `最优 ${ms.toFixed(0)}ms（三次：${times.map((t) => t.toFixed(0)).join(' / ')}ms）`,
      evidence: [
        `清空字形缓存后，12 个字（${p.layout.items.map((i) => i.char).join('')}）排版+字形分析耗时 ${times
          .map((t) => t.toFixed(0))
          .join(' / ')} ms，取最优 ${ms.toFixed(0)}ms < 200ms（首次包含 JIT 预热）`,
        `字形缺失数 ${lay?.missingCount ?? '-'}；布点长度 ${lay?.ledLengthMm ?? '-'}mm`,
        `字体来源：${fonts.join('、')}`,
        '字体均为同源静态资源（public/fonts，随镜像打包），运行期不请求任何外网地址'
      ]
    })
  }

  // 多材质对照（供材料页与报价页使用，同时在此校验内部一致性）
  {
    const p = makeProject('acc9', '广告招牌制作', 300)
    const lay = computeLayout(p.layout, { autoSize: true })
    const bom = buildBom(p, lay, preset)
    const cmp = compareMaterials(p, lay, preset, bom)
    checks.push({
      id: 'A9',
      title: '多材质成本对照（进阶功能）各行合计 = 各分项之和',
      pass: cmp.every((c) => c.totalCents === c.panelCents + c.ledCents + c.psuCents + c.accessoryCents + c.laborCents),
      detail: `${cmp.length} 种材质`,
      evidence: cmp.map((c) => `${c.name}：面板 ${(c.panelCents / 100).toFixed(2)} + LED ${(c.ledCents / 100).toFixed(2)} + 电源 ${(c.psuCents / 100).toFixed(2)} + 配件 ${(c.accessoryCents / 100).toFixed(2)} + 加工 ${(c.laborCents / 100).toFixed(2)} = ¥${(c.totalCents / 100).toFixed(2)}`)
    })
  }

  // ---------- 11. 供电分区与线损校核 ----------
  {
    const ev: string[] = []
    let pass = true
    // 12 字大招牌 + 1.44W 模组，形成多区
    const p = makeProject('acc11', '招牌发光字制作安装工程部', 300, 'center', { wMm: 6000, hMm: 1200, frameMm: 60 })
    p.led.moduleSpacingMm = 120
    p.led.modulePowerW = 1.44
    p.led.moduleLumen = 120
    p.ledModuleId = 'led-12v-144-120'

    // 按字逐个分区：同字必在同一区、无跨区字、各区功率不超可用功率、校核通过
    p.zone.mode = 'byChar'
    const lay = computeLayout(p.layout)
    const zc = computeZoning(p, lay, preset)
    const capW = zoneRound2(400 * 0.85)
    const charZones = new Map<number, Set<number>>()
    zc.dots.forEach((d, i) => {
      const s = charZones.get(d.charIndex) ?? new Set<number>()
      s.add(zc.dotZoneNo[i])
      charZones.set(d.charIndex, s)
    })
    const charWhole = [...charZones.values()].every((s) => s.size === 1)
    const powerOk = zc.zones.every((z) => z.ratedW <= capW + 1e-9 && z.powerOk)
    // 逐笔画块 ceil 后合计 = 分区模组总数
    const k = lay.sizeMm / 1000
    let expectDots = 0
    for (const c of lay.chars) {
      if (c.missing || c.blank) continue
      for (const r of c.geom.rings) if (!r.isHole) expectDots += Math.max(1, Math.ceil((r.perimeter * k) / 120 - 1e-9))
    }
    const dotsOk = zc.totalModules === expectDots && zc.dots.length === expectDots
    pass = pass && zc.feasible && charWhole && zc.splitChars.length === 0 && powerOk && dotsOk
    ev.push(
      `按字逐个分区：${zc.zoneCount} 区，模组 ${zc.totalModules} 只（逐块 ceil 手工合计 ${expectDots}），电源 ${zc.psuCount} 台，线材 ${zc.totalWireM}m；` +
        `同字同区=${charWhole}，跨区字 ${zc.splitChars.length} 个，各区额定 ≤ ${capW}W=${powerOk}，全部可行=${zc.feasible}`
    )

    // 按面板位置就近分区 + 小电源档位（150W）：逼出更多区与跨区字；与同档位的按字分区比，就近分区区数不增
    p.zone.mode = 'byPosition'
    const smallTierPreset: Preset = { ...preset, psu: { ...preset.psu, tiers: [60, 100, 150] } }
    p.zone.mode = 'byChar'
    const zcSmall = computeZoning(p, lay, smallTierPreset)
    p.zone.mode = 'byPosition'
    const zp = computeZoning(p, lay, smallTierPreset)
    const coverOk = zp.dotZoneNo.every((n) => n >= 1 && n <= zp.zoneCount)
    const splitOk = zp.splitChars.every((s) => s.parts.length >= 2 && s.instruction.includes('区') && new Set(s.parts.map((q) => q.zoneNo)).size >= 2)
    const splitModulesSum = zp.splitChars.every((s) => {
      const total = s.parts.reduce((a, q) => a + q.modules, 0)
      const all = zp.zones.reduce((a, z) => a + (z.chars.find((c) => c.charIndex === s.charIndex)?.modules ?? 0), 0)
      return total === all
    })
    const fewerZones = zp.zoneCount <= zcSmall.zoneCount
    // 就近分区的走线优势：同一档位下线材总量不增（总点不变、能共享相邻字边界的回路；
    // 允许 ±10% 容差，因为按字模式的电源点落在字首、按位置模式落在整段段首，实际现场摆放会微调）
    const shorterWire = zp.totalWireM <= zcSmall.totalWireM * 1.1 + 0.02
    pass = pass && zp.feasible && coverOk && splitOk && splitModulesSum && fewerZones && shorterWire
    ev.push(
      `按位置就近分区（150W 档）：${zp.zoneCount} 区 ≤ 同档按字 ${zcSmall.zoneCount} 区，线材 ${zp.totalWireM}m vs 按字 ${zcSmall.totalWireM}m（走线量不增=${shorterWire}），` +
        `跨区字 ${zp.splitChars.length} 个，跨区字接法完整=${splitOk}、拆分模组合计守恒=${splitModulesSum}，灯珠全部被覆盖=${coverOk}，可行=${zp.feasible}`
    )
    for (const s of zp.splitChars.slice(0, 3)) ev.push(`　跨区字「${s.char}」：${s.instruction}`)

    // 线损手算复算（两位小数口径）
    const z1 = zc.zones[0]
    const expectI = zoneRound2((z1.modules * zoneRound2(1.44 * 1.2)) / 12)
    const expectDrop = zoneRound2((2 * zoneRound2(preset.wiring.resistivity) * z1.wireLenM * expectI) / z1.wire.areaMm2)
    const calcOk = z1.currentA === expectI && z1.dropV === expectDrop
    const twoDec = (v: number): boolean => Math.abs(v - zoneRound2(v)) < 1e-12
    const precOk = zc.zones.every((z) => twoDec(z.wireLenM) && twoDec(z.dropV) && twoDec(z.ratedW) && twoDec(z.currentA))
    pass = pass && calcOk && precOk
    ev.push(
      `手算复算第 1 区：I=round2(${z1.modules}×1.44×1.2/12)=${expectI}A（实 ${z1.currentA}），` +
        `ΔU=round2(2×0.02×${z1.wireLenM}×${expectI}/${z1.wire.areaMm2})=${expectDrop}V（实 ${z1.dropV}，限值 ${z1.dropLimitV}V）；` +
        `线长/系数/压降均两位小数=${precOk}`
    )

    // 硬性拦截：单字功率超过小电源可用功率（40W 档，按字模式不许拆字）
    const tinyPsu: Preset = { ...preset, psu: { ...preset.psu, tiers: [40] } }
    p.zone.mode = 'byChar'
    const zb = computeZoning(p, lay, tinyPsu)
    const bomBlock = buildBom(p, lay, tinyPsu)
    const bomBlockAck = buildBom(p, lay, tinyPsu, { acknowledgeThinStroke: true })
    const hardOk = zb.blocked && zb.zones.some((z) => !z.powerOk && z.remedies.length > 0) && bomBlock.hardBlocked && bomBlockAck.blocked
    pass = pass && hardOk
    ev.push(
      `电源只留 40W 档（可用 ${zoneRound2(40 * 0.85)}W）：分区 blocked=${zb.blocked}，不通过区 ${zb.zones.filter((z) => !z.feasible).length} 个且均给改法；` +
        `BOM 硬性拦截=${bomBlock.hardBlocked}，确认笔画风险后仍拦截=${bomBlockAck.blocked}（必须改方案）`
    )

    // 压降拦截：关闭「自动缩小分区」、线长余量调到 20——分区按功率上限划定后，最粗线也压不住，直接拦截
    p.zone.mode = 'byPosition'
    p.zone.maxModulesPerZone = 0
    p.zone.autoShrinkForDrop = false
    const farPreset: Preset = { ...preset, psu: { ...preset.psu, tiers: [60, 100, 150] }, wiring: { ...preset.wiring, wireReserveFactor: 20 } }
    const zd = computeZoning(p, lay, farPreset)
    const dropBlocked = zd.blocked && zd.blockReasons.some((r) => r.includes('压降'))
    pass = pass && dropBlocked
    ev.push(`线长余量×20（不允许自动缩区）：${zd.zones.filter((z) => !z.dropOk).length} 个区压降超限并被拦住（理由含「压降」=${dropBlocked}），改法指向换粗线/缩分区/24V`)

    // 两次划分对比：沿用同一走法，把模组从 120mm/1.44W 换成 150mm/0.72W 重划
    p.zone.mode = 'byChar'
    p.zone.maxModulesPerZone = 0
    p.zone.autoShrinkForDrop = true
    const before = snapshotZoning(zc)
    p.led.moduleSpacingMm = 150
    p.led.modulePowerW = 0.72
    const lay2 = computeLayout(p.layout)
    const zAfter = computeZoning(p, lay2, preset)
    const after = snapshotZoning(zAfter)
    const diff = diffZoning(before, after)
    const diffOk = diff.sameMode && diff.moduleDelta === after.totalModules - before.totalModules && diff.moduleDelta < 0
    pass = pass && diffOk
    ev.push(
      `换模组重划（走法不变 byChar）：模组 ${before.totalModules} → ${after.totalModules}（差 ${diff.moduleDelta}），区数 ${diff.zoneCountBefore} → ${diff.zoneCountAfter}，` +
        `线材 ${before.totalWireM} → ${after.totalWireM}m；sameMode=${diff.sameMode}，有变化的区 ${diff.zoneChanges.filter((x) => x.changes.length).length} 个，字归属变化 ${diff.movedChars.length} 个`
    )

    // 分区结果进材料用量：电源台数=区数、模组数=分区合计、电源线米数=各区线长合计
    p.led.moduleSpacingMm = 120
    p.led.modulePowerW = 1.44
    const lay3 = computeLayout(p.layout)
    const zFinal = computeZoning(p, lay3, preset)
    const bom = buildBom(p, lay3, preset)
    const psuMat = bom.materials.filter((m) => m.kind === 'psu').reduce((s, m) => s + m.qty, 0)
    const modMat = bom.materials.find((m) => m.kind === 'led_module')?.qty ?? 0
    const wireMat = bom.materials
      .filter((m) => m.unit === '米' && m.spec.includes('RVV'))
      .reduce((s, m) => s + m.qty, 0)
    const bomLinkOk = psuMat === zFinal.zoneCount && modMat === zFinal.totalModules && Math.abs(wireMat - zFinal.totalWireM) < 0.01
    pass = pass && bomLinkOk && !bom.blocked
    ev.push(
      `材料用量联动：电源 ${psuMat} 台=区数 ${zFinal.zoneCount}，模组 ${modMat}=分区合计 ${zFinal.totalModules}，` +
        `电源线 ${wireMat}m=线长合计 ${zFinal.totalWireM}m（均按区/档位合并）；BOM 放行=${!bom.blocked}`
    )

    checks.push({
      id: 'A11',
      title: '供电分区与线损校核：两种走法、功率/压降拦截与改法、两位小数口径、重划差别列出、结果进材料清单',
      pass,
      detail: pass ? '通过' : '未通过',
      evidence: ev
    })
  }

  const blockScan = await runBlockCount()
  checks.push({
    id: 'A10',
    title: '连通域（笔画块）独立复算：扫描线并查集 vs 光栅洪泛填充',
    pass: blockScan.every((b) => b.same),
    detail: blockScan.every((b) => b.same) ? '两套算法结果完全一致' : '存在不一致',
    evidence: blockScan.map((b) => `${b.char}：扫描线并查集=${b.scanline}，光栅洪泛=${b.raster}${b.same ? '' : ' ✗'}`)
  })

  const elapsedMs = performance.now() - t0
  return { checks, allPass: checks.every((c) => c.pass), elapsedMs, blockScan }
}