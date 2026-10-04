<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PanelPreview from '../components/PanelPreview.vue'
import { computeLed, ledRows } from '../logic/led'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import {
  clearZoneBaseline,
  computeZoning,
  diffZoning,
  loadZoneBaseline,
  saveZoneBaseline,
  snapshotZoning,
  zoneModeLabel,
  type ZoningDiff,
  type ZoneSnapshot
} from '../logic/zoning'
import { exportZoningCsv } from '../logic/quote'
import type { Project, ZoneMode } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset

const led = computed(() =>
  project.value && layout.value
    ? computeLed(layout.value.ledLengthMm, project.value.led, preset.value.psu)
    : null
)

const rows = computed(() => (layout.value ? ledRows(layout.value.chars, project.value!.led) : []))
const totalLumen = computed(() => (zoning.value ? zoning.value.totalModules * project.value!.led.moduleLumen : 0))

const zoning = computed(() =>
  project.value && layout.value ? computeZoning(project.value, layout.value, preset.value) : null
)

/** 与上一次划分的差别（同一走法下，换模组/电源规格重划时自动列出） */
const replanDiff = ref<{ before: ZoneSnapshot; after: ZoneSnapshot; diff: ZoningDiff } | null>(null)
watch(zoning, (z, oldZ) => {
  if (!z) return
  if (!oldZ || z.mode !== oldZ.mode) {
    replanDiff.value = null
    return
  }
  const changed =
    oldZ.zoneCount !== z.zoneCount ||
    oldZ.totalModules !== z.totalModules ||
    oldZ.totalWireM !== z.totalWireM ||
    oldZ.psuCount !== z.psuCount
  if (!changed) return
  const before = snapshotZoning(oldZ)
  const after = snapshotZoning(z)
  replanDiff.value = { before, after, diff: diffZoning(before, after) }
})

/** 持久化基线（跨会话对比，比如换电源档位前后） */
const baseline = ref<ZoneSnapshot | null>(project.value ? loadZoneBaseline(project.value.id) : null)
function setBaseline(): void {
  if (!project.value || !zoning.value) return
  const snap = snapshotZoning(zoning.value)
  saveZoneBaseline(project.value.id, snap)
  baseline.value = snap
}
function dropBaseline(): void {
  if (!project.value) return
  clearZoneBaseline(project.value.id)
  baseline.value = null
}
const baselineDiff = computed(() => {
  if (!zoning.value || !baseline.value || baseline.value.mode !== zoning.value.mode) return null
  return diffZoning(baseline.value, snapshotZoning(zoning.value))
})

function applyModule(id: string): void {
  const m = preset.value.ledModules.find((x) => x.id === id)
  if (!m || !project.value) return
  project.value.ledModuleId = m.id
  project.value.led.moduleSpacingMm = m.spacingMm
  project.value.led.modulePowerW = m.powerW
  project.value.led.moduleLumen = m.lumen
}

function setMode(mode: ZoneMode): void {
  if (project.value) project.value.zone.mode = mode
}

function exportCsv(): void {
  if (project.value && zoning.value) exportZoningCsv(project.value, zoning.value)
}

const grade = computed(() => {
  if (!led.value || !project.value) return ''
  const spacing = project.value.led.moduleSpacingMm
  const size = layout.value?.sizeMm ?? 0
  const ratio = spacing / Math.max(1, size)
  if (ratio > 0.55) return '模组间距偏大（> 0.55×字高）：大笔画中间容易发暗，建议加密'
  if (ratio < 0.18) return '模组间距偏小（< 0.18×字高）：模组数量与发热偏高，建议放宽'
  return `模组间距 ${spacing}mm ≈ ${(ratio * 100).toFixed(0)}% 字高，布点密度合适`
})

const wireRows = computed(() => preset.value.wiring.wires)
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div class="split">
        <section class="card">
          <header>
            <h1>LED 与电源计算</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>模组规格预设</label>
            <div class="ctl">
              <select :value="project.ledModuleId" @change="applyModule(($event.target as HTMLSelectElement).value)">
                <option v-for="m in preset.ledModules" :key="m.id" :value="m.id">{{ m.spec }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>模组间距（mm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleSpacingMm" min="20" step="10" /></div>
          </div>
          <div class="field">
            <label>单模组功率（W）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.modulePowerW" min="0.05" step="0.01" /></div>
          </div>
          <div class="field">
            <label>单模组亮度（lm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleLumen" min="5" step="5" /></div>
          </div>
          <div class="field">
            <label>安全系数</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.safetyFactor" min="1" max="2" step="0.05" />
              <span class="muted">默认 1.2</span>
            </div>
          </div>
          <div class="field">
            <label>电源效率</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.psuEfficiency" min="0.5" max="1" step="0.01" />
              <span class="muted">默认 0.85</span>
            </div>
          </div>

          <h3 style="margin-top: 14px">分区与线损校核</h3>
          <div class="field">
            <label>分区走法（选定后沿用，重划不变）</label>
            <div class="ctl" style="flex-direction: column; align-items: stretch; gap: 6px">
              <label class="radio">
                <input type="radio" :checked="project.zone.mode === 'byChar'" @change="setMode('byChar')" />
                <span><b>按字逐个分区</b>：每个字整套挂同一区，字形完整、接线好认；区数偏多、电源线材多</span>
              </label>
              <label class="radio">
                <input type="radio" :checked="project.zone.mode === 'byPosition'" @change="setMode('byPosition')" />
                <span><b>按面板位置就近分区</b>：走线短、省线；交界字会分给两区，附车间接法、多一道确认手续</span>
              </label>
            </div>
          </div>
          <div class="field">
            <label>最远灯珠允许压降（%）</label>
            <div class="ctl">
              <input type="number" v-model.number="project.zone.maxDropRatio" min="0.01" max="0.2" step="0.01" />
              <span class="muted">默认 5%（{{ (project.zone.maxDropRatio * 100).toFixed(2) }}%）</span>
            </div>
          </div>
          <div class="field">
            <label>每区模组数上限（只，0=不限）</label>
            <div class="ctl"><input type="number" v-model.number="project.zone.maxModulesPerZone" min="0" step="1" /></div>
          </div>
          <div class="field">
            <label>线损不达标时自动缩小分区</label>
            <div class="ctl">
              <input type="checkbox" :checked="project.zone.autoShrinkForDrop !== false" @change="project.zone.autoShrinkForDrop = ($event.target as HTMLInputElement).checked" />
              <span class="muted">勾选=能划小就划小直到最粗线达标；不勾=按功率上限定区，压降不达标直接拦截</span>
            </div>
          </div>

          <h3 style="margin-top: 14px">计算公式（可复算）</h3>
          <div class="formula">总布点长度 L = Σ 每个连通域的外轮廓周长（不含内孔）= {{ layout?.ledLengthMm ?? 0 }} mm
模组数（分区口径）= 逐笔画块 ceil(周长 / 间距) 后合计 = {{ zoning?.totalModules ?? led?.modules ?? 0 }} 只
额定功率 P = N × 单模组功率 × 安全系数
每区可用功率 = 最大档位 {{ preset.psu.tiers[preset.psu.tiers.length - 1] }}W × 效率 {{ project.led.psuEfficiency }}
最远灯珠压降 ΔU = 2 × ρ({{ preset.wiring.resistivity.toFixed(2) }}) × 线长L × 电流I ÷ 线径S
标准档位：{{ preset.psu.tiers.join(' / ') }} W 向上取</div>

          <ul class="notes" style="margin-top: 10px">
            <li>每区模组数与功率都不许超过所选电源可用功率，超限即判不通过。</li>
            <li>分区规模、线径系数与压降一律保留两位小数后比较，界面数值可直接复算。</li>
            <li>压降或线径不达标会拦住出单，并给出改法：换更粗的线、缩小分区或换大电源。</li>
          </ul>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>计算结果（整排口径）</h2>
              <span class="hint">当前项目材料预设置</span>
            </header>
            <div v-if="led" class="metrics">
              <span class="k">总布点长度 L</span><span class="v">{{ led.perimeterTotalMm }} mm</span>
              <span class="k">整排一次取整 N</span><span class="v">{{ led.modules }} 只</span>
              <span class="k">分区实际布点（采购口径）</span><span class="v">{{ zoning?.totalModules ?? 0 }} 只</span>
              <span class="k">额定功率（含安全系数）</span><span class="v">{{ zoning?.totalRatedW ?? led.ratedW }} W</span>
              <span class="k">整排建议电源（旧口径）</span><span class="v">{{ led.suggestedPsu }}</span>
              <span class="k">总光通量（估算）</span><span class="v">{{ totalLumen }} lm</span>
            </div>
            <div class="banner info" v-if="led">{{ led.note }}</div>
            <div class="banner warn" v-if="grade">{{ grade }}</div>
            <p class="muted">
              旧口径把一整排按总长度算一台电源；现场一台带不动时按下表分区，每区单独回路、单独配电源，分区结果直接进材料清单与接线清单。
            </p>
          </div>

          <!-- 分区校核结果 -->
          <div class="card" style="margin-top: 14px" v-if="zoning">
            <header>
              <h2>供电分区（{{ zoning.modeLabel }}）</h2>
              <span class="hint">
                {{ zoning.zoneCount }} 区 · 电源 {{ zoning.psuCount }} 台 · 线材 {{ zoning.totalWireM }}m ·
                {{ zoning.voltageV }}V 模组
              </span>
            </header>

            <div v-if="zoning.blocked" class="banner bad">
              <b>线损/功率校核不通过，已拦住出单：</b>
              <ul class="notes" style="color: inherit">
                <li v-for="(r, i) in zoning.blockReasons" :key="i">{{ r }}</li>
              </ul>
              <span>改法：按下表各区「改法建议」换更粗的线 / 缩小分区 / 换大电源（或改用 24V 模组），重划通过后才能出材料清单与报价。</span>
            </div>
            <div v-else class="banner ok">
              全部 {{ zoning.zoneCount }} 个区功率、线径载流量与最远灯珠压降校核通过（限值 {{ zoning.zones[0]?.dropLimitV }}V/区）。
            </div>

            <p class="mono muted" style="margin-top: 8px">{{ zoning.formulaNote }}</p>

            <table>
              <thead>
                <tr>
                  <th>区号</th>
                  <th>挂接字（模组数）</th>
                  <th class="num">模组</th>
                  <th class="num">额定 W</th>
                  <th class="num">需求 W</th>
                  <th class="num">电源</th>
                  <th class="num">线长 m</th>
                  <th class="num">电流 A</th>
                  <th>建议线径</th>
                  <th class="num">最远压降</th>
                  <th>结论 / 改法</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="z in zoning.zones" :key="z.no" :class="{ 'row-bad': !z.feasible }">
                  <td><b :style="{ color: 'var(--brand)' }">第{{ z.no }}区</b></td>
                  <td class="muted" style="font-size: 12px">
                    <span v-for="c in z.chars" :key="c.charIndex">
                      「{{ c.char }}」×{{ c.modules }}<span v-if="c.side !== '整字'" class="tag" style="margin: 0 2px">{{ c.side }}</span>
                    </span>
                  </td>
                  <td class="num">{{ z.modules }}</td>
                  <td class="num">{{ z.ratedW.toFixed(2) }}</td>
                  <td class="num">{{ z.needW.toFixed(2) }}</td>
                  <td class="num">{{ z.psuW === null ? '超档' : z.psuW + 'W×1' }}</td>
                  <td class="num">{{ z.wireLenM.toFixed(2) }}</td>
                  <td class="num">{{ z.currentA.toFixed(2) }}</td>
                  <td style="font-size: 12px">{{ z.wire.spec.replace('RVV 2×', 'RVV2×') }}<br /><span class="muted">载流量 {{ z.wire.ampacityA }}A</span></td>
                  <td class="num" :class="{ 'cell-bad': !z.dropOk }">
                    {{ z.dropV.toFixed(2) }}V<br /><span class="muted">{{ z.dropRatioPct.toFixed(2) }}%</span>
                  </td>
                  <td style="font-size: 12px">
                    <b v-if="z.feasible" style="color: var(--ok)">通过</b>
                    <template v-else>
                      <div v-for="(r, i) in z.reasons" :key="`r${i}`" class="cell-bad">{{ r }}</div>
                      <div v-for="(m2, i) in z.remedies" :key="`m${i}`" class="muted">改法：{{ m2 }}</div>
                    </template>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td></td>
                  <td class="num">{{ zoning.totalModules }}</td>
                  <td class="num">{{ zoning.totalRatedW.toFixed(2) }}</td>
                  <td></td>
                  <td class="num">{{ zoning.psuCount }} 台</td>
                  <td class="num">{{ zoning.totalWireM.toFixed(2) }}</td>
                  <td colspan="4"></td>
                </tr>
              </tfoot>
            </table>

            <div class="row" style="margin-top: 10px">
              <button class="primary" :disabled="zoning.blocked" @click="exportCsv">导出分区接线清单（CSV）</button>
              <button @click="setBaseline">把当前划分存为对比基线</button>
              <button v-if="baseline" @click="dropBaseline">清除基线</button>
              <span class="muted" v-if="baseline">
                已存基线：{{ zoneModeLabel(baseline.mode) }} · {{ baseline.zoneCount }} 区 / {{ baseline.totalModules }} 只 / {{ baseline.totalWireM.toFixed(2) }}m
              </span>
            </div>
          </div>

          <!-- 跨区字接法 -->
          <div class="card" style="margin-top: 14px" v-if="zoning && zoning.splitChars.length">
            <header>
              <h2>跨区字接法（{{ zoning.splitChars.length }} 个字落在区界上）</h2>
              <span class="hint">车间逐字勾确认，多一道手续但走线最短</span>
            </header>
            <table>
              <thead>
                <tr><th>字</th><th>分区归属</th><th>接法说明</th><th class="num">确认</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in zoning.splitChars" :key="s.charIndex">
                  <td style="font-size: 20px">「{{ s.char }}」</td>
                  <td class="muted" style="font-size: 12px">
                    <span v-for="p in s.parts" :key="p.zoneNo" class="tag" style="margin-right: 4px">
                      第{{ p.zoneNo }}区 {{ p.modules }} 只（{{ p.side }}）
                    </span>
                  </td>
                  <td class="muted" style="font-size: 12px">{{ s.instruction }}</td>
                  <td class="num">□</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 两次划分差别 -->
          <div class="card" style="margin-top: 14px" v-if="replanDiff">
            <header>
              <h2>重划差别（换模组/电源规格，沿用「{{ zoneModeLabel(replanDiff.before.mode) }}」）</h2>
              <span class="hint">上一次划分 → 当前划分</span>
            </header>
            <div class="kv-list">
              <span class="muted">区数</span>
              <span class="mono">{{ replanDiff.diff.zoneCountBefore }} → {{ replanDiff.diff.zoneCountAfter }}</span>
              <span class="muted">模组数</span>
              <span class="mono">{{ replanDiff.before.totalModules }} → {{ replanDiff.after.totalModules }}（{{ replanDiff.diff.moduleDelta >= 0 ? '+' : '' }}{{ replanDiff.diff.moduleDelta }}）</span>
              <span class="muted">电源台数</span>
              <span class="mono">{{ replanDiff.before.psuCount }} → {{ replanDiff.after.psuCount }}（{{ replanDiff.diff.psuCountDelta >= 0 ? '+' : '' }}{{ replanDiff.diff.psuCountDelta }}）</span>
              <span class="muted">线材合计</span>
              <span class="mono">{{ replanDiff.before.totalWireM.toFixed(2) }} → {{ replanDiff.after.totalWireM.toFixed(2) }} m（{{ replanDiff.diff.wireDelta >= 0 ? '+' : '' }}{{ replanDiff.diff.wireDelta.toFixed(2) }}m）</span>
              <span class="muted">跨区字</span>
              <span class="mono">{{ replanDiff.diff.splitBefore }} → {{ replanDiff.diff.splitAfter }} 个</span>
            </div>
            <table style="margin-top: 8px">
              <thead>
                <tr><th>区号</th><th>本次重划差别</th></tr>
              </thead>
              <tbody>
                <tr v-for="zc in replanDiff.diff.zoneChanges.filter((x) => x.changes.length)" :key="zc.no">
                  <td>第{{ zc.no }}区</td>
                  <td class="muted">{{ zc.changes.join('；') }}</td>
                </tr>
                <tr v-if="!replanDiff.diff.zoneChanges.some((x) => x.changes.length)">
                  <td colspan="2" class="muted">各区构成不变（仅总数可能随布点密度变化）</td>
                </tr>
              </tbody>
            </table>
            <details v-if="replanDiff.diff.movedChars.length">
              <summary class="muted">字归属变化（{{ replanDiff.diff.movedChars.length }} 个字）</summary>
              <table>
                <tbody>
                  <tr v-for="mc in replanDiff.diff.movedChars" :key="mc.key">
                    <td>「{{ mc.char }}」</td>
                    <td class="muted">{{ mc.before }} → {{ mc.after }}</td>
                  </tr>
                </tbody>
              </table>
            </details>
          </div>

          <div class="card" style="margin-top: 14px" v-if="baselineDiff && !baselineDiff.identical">
            <header>
              <h2>与已存基线的差别</h2>
              <span class="hint">基线 {{ baseline?.zoneCount }}区/{{ baseline?.totalModules }}只 → 当前</span>
            </header>
            <div class="kv-list">
              <span class="muted">区数</span><span class="mono">{{ baselineDiff.zoneCountBefore }} → {{ baselineDiff.zoneCountAfter }}</span>
              <span class="muted">模组数</span><span class="mono">{{ baseline?.totalModules }} → {{ zoning?.totalModules }}（{{ baselineDiff.moduleDelta >= 0 ? '+' : '' }}{{ baselineDiff.moduleDelta }}）</span>
              <span class="muted">线材</span><span class="mono">{{ baseline?.totalWireM.toFixed(2) }} → {{ zoning?.totalWireM.toFixed(2) }} m（{{ baselineDiff.wireDelta >= 0 ? '+' : '' }}{{ baselineDiff.wireDelta.toFixed(2) }}m）</span>
            </div>
            <table style="margin-top: 8px">
              <tbody>
                <tr v-for="zc in baselineDiff.zoneChanges.filter((x) => x.changes.length)" :key="zc.no">
                  <td>第{{ zc.no }}区</td>
                  <td class="muted">{{ zc.changes.join('；') }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>分区预览与布点（灯珠按区着色）</h2>
              <span class="hint">虚线框=分区覆盖范围，方块=电源出线口，虚线=到最远灯珠的校核线</span>
            </header>
            <PanelPreview
              v-if="layout"
              :project="project"
              :layout="layout"
              :show-led="true"
              :show-dims="true"
              :show-margins="false"
              :zoning="zoning"
            />
            <div class="row" style="margin-top: 8px; flex-wrap: wrap">
              <span v-for="z in zoning?.zones ?? []" :key="`lg${z.no}`" class="tag" :style="{ borderColor: 'var(--brand)' }">
                ■ 第{{ z.no }}区：{{ z.modules }}只 / {{ z.wireLenM.toFixed(2) }}m / {{ z.feasible ? '通过' : '不通过' }}
              </span>
            </div>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>可选线径与线损系数</h2>
              <span class="hint">在「材质与工艺预设」页可改 ρ、余量系数与单价</span>
            </header>
            <table>
              <thead>
                <tr><th>规格</th><th class="num">线径 mm²</th><th class="num">载流量 A</th><th class="num">系数 ρ（Ω·mm²/m）</th><th class="num">余量系数</th></tr>
              </thead>
              <tbody>
                <tr v-for="w in wireRows" :key="w.id">
                  <td>{{ w.spec }}</td>
                  <td class="num">{{ w.areaMm2 }}</td>
                  <td class="num">{{ w.ampacityA }}</td>
                  <td class="num">{{ preset.wiring.resistivity.toFixed(2) }}</td>
                  <td class="num">{{ preset.wiring.wireReserveFactor.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>逐字用量明细</h2>
              <span class="hint">模块数按每个连通域外轮廓分别向上取整（分区采购口径与此一致）</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>字符</th>
                  <th class="num">笔画块数</th>
                  <th class="num">外轮廓周长 mm</th>
                  <th class="num">模组数</th>
                  <th class="num">功率 W</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in rows" :key="i">
                  <td>{{ r.char }}</td>
                  <td class="num">{{ r.blocks }}</td>
                  <td class="num">{{ r.outerPerimeterMm }}</td>
                  <td class="num">{{ r.modules }}</td>
                  <td class="num">{{ r.ratedW }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.blocks, 0) }}</td>
                  <td class="num">{{ led?.perimeterTotalMm ?? 0 }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.modules, 0) }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.ratedW, 0).toFixed(2) }}</td>
                </tr>
              </tfoot>
            </table>
            <p class="muted">
              逐字模组数之和即分区布点总数（每块 ceil），与整排一次取整的旧口径可能相差几只；采购与分区以分区校核结果为准。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.radio {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.5;
}
.radio input {
  margin-top: 3px;
}
.row-bad {
  background: rgba(198, 40, 40, 0.08);
}
.cell-bad {
  color: var(--danger);
  font-weight: 600;
}
</style>
