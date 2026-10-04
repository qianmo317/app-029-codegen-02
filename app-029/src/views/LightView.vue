<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import PanelPreview from '../components/PanelPreview.vue'
import { computeLed, ledRows } from '../logic/led'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import {
  diffZoning,
  planZoning,
  strategyLabel,
  toSnapshot,
  type ZoningResult
} from '../logic/zoning'
import { exportWiringCsv } from '../logic/quote'
import type { Project } from '../logic/types'

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
const totalLumen = computed(() => (led.value ? led.value.modules * project.value!.led.moduleLumen : 0))

const voltageV = computed(() => {
  const m = preset.value.ledModules.find((x) => x.id === project.value?.ledModuleId)
  return m?.voltageV ?? 12
})

const panelMaterial = computed(() => preset.value.panelMaterials.find((m) => m.id === project.value?.panelMaterialId))
const useLed = computed(() => !!panelMaterial.value?.useLed)

/** 分区与线损校核（参数两位小数口径在 zoning 内统一处理） */
const zoning = computed<ZoningResult | null>(() => {
  if (!project.value || !layout.value) return null
  return planZoning(
    layout.value.chars,
    project.value.led,
    voltageV.value,
    preset.value.psu.tiers,
    preset.value.wiring,
    project.value.zone,
    project.value.layout.panel.hMm
  )
})

const diff = computed(() => (zoning.value && project.value ? diffZoning(project.value.zone.baseline, zoning.value) : null))

function applyModule(id: string): void {
  const m = preset.value.ledModules.find((x) => x.id === id)
  if (!m || !project.value) return
  project.value.ledModuleId = m.id
  project.value.led.moduleSpacingMm = m.spacingMm
  project.value.led.modulePowerW = m.powerW
  project.value.led.moduleLumen = m.lumen
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

function setStrategy(s: 'byChar' | 'byProximity'): void {
  if (project.value) project.value.zone.strategy = s
}
function setTier(t: number | 'auto'): void {
  if (project.value) project.value.zone.psuTierW = t
}

/** 把当前划分记为基线（车间照此接线）；之后换模组/电源重划沿用同一走法并列出差别 */
function adoptBaseline(): void {
  if (!project.value || !zoning.value) return
  project.value.zone.baseline = toSnapshot(project.value.zone, zoning.value)
}
function clearBaseline(): void {
  if (project.value) project.value.zone.baseline = null
}

function exportCsv(): void {
  if (project.value && layout.value && zoning.value) {
    exportWiringCsv(project.value, layout.value, zoning.value)
  }
}
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

          <h3 style="margin-top: 14px">计算公式（可复算）</h3>
          <div class="formula">总布点长度 L = Σ 每个连通域的外轮廓周长（不含内孔）= {{ layout?.ledLengthMm ?? 0 }} mm
模组数 N = ceil(L / 模组间距) = ceil({{ led?.perimeterTotalMm ?? 0 }} / {{ project.led.moduleSpacingMm }}) = {{ led?.modules ?? 0 }}
额定功率 P = N × 单模组功率 × 安全系数 = {{ led?.modules ?? 0 }} × {{ project.led.modulePowerW }} × {{ project.led.safetyFactor }} = {{ led?.ratedW ?? 0 }} W
电源功率 = P / 电源效率 = {{ led?.ratedW ?? 0 }} / {{ project.led.psuEfficiency }} = {{ led?.recommendedW ?? 0 }} W
标准档位：{{ preset.psu.tiers.join(' / ') }} W 向上取</div>

          <ul class="notes" style="margin-top: 10px">
            <li>模组数向上取整会显式提示补足数量，不静默取整。</li>
            <li>整排只按总长度算一台电源是旧口径；现场一台带不动时按下方「分区与线损校核」分区，每区单独配电源。</li>
            <li>布点长度取外轮廓（内孔不计），与车间实际走线一致。</li>
          </ul>

          <!-- ==================== 分区与线损校核 ==================== -->
          <template v-if="useLed">
          <h2 style="margin-top: 18px">分区与线损校核</h2>
          <p class="muted">拿排好版的每个字（面板位置、笔画块、外轮廓长度）划供电区；每区模组数与功率都不许超过所选电源的可用功率。</p>

          <h3 style="margin-top: 10px">分区走法（二选一，选定后重划沿用）</h3>
          <div class="row">
            <button :class="project.zone.strategy === 'byChar' ? 'primary' : ''" @click="setStrategy('byChar')">
              按字逐个分区
            </button>
            <button :class="project.zone.strategy === 'byProximity' ? 'primary' : ''" @click="setStrategy('byProximity')">
              按面板位置就近分区
            </button>
          </div>
          <ul class="notes">
            <li v-if="project.zone.strategy === 'byChar'">每个字整套连在同一个区：字形完整、接线好认；代价是区数偏多、电源线材跟着多。</li>
            <li v-else>走线短、省线；代价是同一个字可能被挤到两区交界——系统会把字按笔画块分给两区并写清接法，车间多一道核对手续。</li>
          </ul>

          <div class="field">
            <label>电源规格（档位 W）</label>
            <div class="ctl">
              <select
                :value="String(project.zone.psuTierW)"
                @change="setTier(($event.target as HTMLSelectElement).value === 'auto' ? 'auto' : Number(($event.target as HTMLSelectElement).value))"
              >
                <option value="auto">自动（按分区结果选最省档位）</option>
                <option v-for="t in preset.psu.tiers" :key="t" :value="String(t)">{{ t }}W（可用 {{ (t * project.zone.usableRatio).toFixed(2) }}W）</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>可用功率比例（降额）</label>
            <div class="ctl">
              <input type="number" v-model.number="project.zone.usableRatio" min="0.1" max="1" step="0.05" />
              <span class="muted">可用功率 = 档位 × 该比例</span>
            </div>
          </div>
          <div class="field">
            <label>最远灯珠压降上限（V）</label>
            <div class="ctl">
              <input type="number" v-model.number="project.zone.maxDropV" min="0.05" max="10" step="0.05" />
              <span class="muted">{{ voltageV }}V 系统常用 ≤ 0.60V</span>
            </div>
          </div>
          <div class="field">
            <label>线径系数 ρ（Ω·mm²/m）</label>
            <div class="ctl">
              <input type="number" v-model.number="project.zone.resistivity" min="0.01" step="0.01" />
              <span class="muted">铜芯线取 0.02</span>
            </div>
          </div>
          <div class="field">
            <label>每区引线长度（mm）</label>
            <div class="ctl"><input type="number" v-model.number="project.zone.feederMm" min="0" step="10" /></div>
          </div>

          <div class="row" style="margin-top: 8px">
            <button class="primary" :disabled="!zoning || !zoning.ok" @click="adoptBaseline">采用当前划分（记为接线基线）</button>
            <button :disabled="!project.zone.baseline" @click="clearBaseline">清除基线</button>
            <button :disabled="!zoning || !zoning.ok" @click="exportCsv">导出接线清单（CSV）</button>
          </div>
          <p class="muted">所有分区规模、线径系数与压降均保留两位小数后再判界线，避免算到界线外。</p>
          </template>
          <div v-else class="banner warn" style="margin-top: 14px">
            当前面板材料为「{{ panelMaterial?.name }}」（不发光）：不做 LED 模组、电源分区与线损校核。
          </div>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>整排汇总（旧口径，供对照）</h2>
              <span class="hint">当前项目材料预设置</span>
            </header>
            <div v-if="led" class="metrics">
              <span class="k">总布点长度 L</span><span class="v">{{ led.perimeterTotalMm }} mm</span>
              <span class="k">理论布点数（小数）</span><span class="v">{{ led.exactModules }}</span>
              <span class="k">模组数量 N</span><span class="v">{{ led.modules }} 只</span>
              <span class="k">向上取整补足</span><span class="v">{{ led.extraModules }} 只</span>
              <span class="k">末段余长</span><span class="v">{{ led.spareMm }} mm</span>
              <span class="k">额定功率（含安全系数）</span><span class="v">{{ led.ratedW }} W</span>
              <span class="k">电源需求功率</span><span class="v">{{ led.recommendedW }} W</span>
              <span class="k">整排单台口径建议</span><span class="v">{{ led.suggestedPsu }}</span>
              <span class="k">总光通量（估算）</span><span class="v">{{ totalLumen }} lm</span>
            </div>
            <div class="banner info" v-if="led">{{ led.note }}</div>
            <div class="banner warn" v-if="useLed && zoning && zoning.zoneCount > 1">
              整排按总长度算一台电源是旧口径；实际按下方分区校核执行：{{ zoning.zoneCount }} 区、{{ zoning.psuCount }} 台 {{ zoning.psuTierW }}W。
            </div>
            <div class="banner warn" v-if="grade">{{ grade }}</div>
          </div>

          <!-- 分区校核结果 -->
          <div class="card" style="margin-top: 14px" v-if="useLed && zoning">
            <header>
              <h2>分区结果 · {{ strategyLabel(zoning.strategy) }}</h2>
              <span class="hint">每区一台电源；{{ zoning.psuTierW }}W 档可用 {{ zoning.usableW }}W</span>
            </header>

            <div class="banner bad" v-if="!zoning.ok">
              <b>线损/容量校核未通过，已拦住（不能照此接线、材料清单按拦截处理）：</b>
              <ul class="notes" style="color: inherit; margin-top: 4px">
                <li v-for="(r, i) in zoning.blockReasons" :key="i">{{ r }}</li>
              </ul>
            </div>
            <div class="banner ok" v-else>
              共 {{ zoning.zoneCount }} 区 / {{ zoning.psuCount }} 台电源，模组 {{ zoning.totalModules }} 只，负载 {{ zoning.totalLoadW }}W，
              分区线合计 {{ (zoning.totalWireMm / 1000).toFixed(2) }}m；各区功率、载流与压降全部达标。
            </div>

            <div v-if="zoning.fixes.length" style="margin-top: 8px">
              <b>改法：</b>
              <ul class="notes">
                <li v-for="(f, i) in zoning.fixes" :key="i">{{ f }}</li>
              </ul>
            </div>

            <table style="margin-top: 8px">
              <thead>
                <tr>
                  <th>区号</th>
                  <th>字（块归属）</th>
                  <th class="num">模组</th>
                  <th class="num">负载 W</th>
                  <th class="num">负载率</th>
                  <th class="num">线长 m</th>
                  <th class="num">电流 A</th>
                  <th class="num">最远压降 V</th>
                  <th>建议线径</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="z in zoning.zones" :key="z.zoneNo" :class="{ 'row-bad': z.overCapacity || !z.wire.dropOk || !z.wire.ampacityOk }">
                  <td><b>{{ z.zoneNo }}</b></td>
                  <td>{{ z.chars.map((c) => c.char).join('') }}</td>
                  <td class="num">{{ z.modules }}</td>
                  <td class="num">{{ z.loadW.toFixed(2) }}</td>
                  <td class="num">{{ (z.loadRatio * 100).toFixed(2) }}%</td>
                  <td class="num">{{ (z.wireMm / 1000).toFixed(2) }}</td>
                  <td class="num">{{ z.wire.currentA.toFixed(2) }}</td>
                  <td class="num" :class="{ 'cell-bad': !z.wire.dropOk }">
                    {{ z.wire.dropV.toFixed(2) }} / {{ project.zone.maxDropV.toFixed(2) }}
                  </td>
                  <td :class="{ 'cell-bad': !z.wire.ampacityOk }">{{ z.wire.spec }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td>{{ zoning.zoneCount }} 区 · {{ zoning.psuCount }} 台</td>
                  <td class="num">{{ zoning.totalModules }}</td>
                  <td class="num">{{ zoning.totalLoadW.toFixed(2) }}</td>
                  <td></td>
                  <td class="num">{{ (zoning.totalWireMm / 1000).toFixed(2) }}</td>
                  <td colspan="3"></td>
                </tr>
              </tfoot>
            </table>

            <div v-for="w in zoning.warnings" :key="w" class="banner warn" style="margin-top: 8px">{{ w }}</div>

            <!-- 跨区字接法 -->
            <template v-if="zoning.splitChars.length">
              <h3 style="margin-top: 12px">跨区字接法（就近分区专用，车间多一道手续）</h3>
              <table>
                <thead>
                  <tr><th>字</th><th>接入区</th><th>接法说明</th></tr>
                </thead>
                <tbody>
                  <tr v-for="s in zoning.splitChars" :key="s.charIndex">
                    <td style="font-size: 20px; font-weight: 700">{{ s.char }}</td>
                    <td>{{ s.zoneNos.join('、') }} 区</td>
                    <td class="muted">{{ s.instruction }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>

          <!-- 两次划分差别 -->
          <div class="card" style="margin-top: 14px" v-if="useLed && project.zone.baseline">
            <header>
              <h2>与接线基线的差别</h2>
              <span class="hint">换模组/电源规格后沿用「{{ strategyLabel(project.zone.baseline.strategy) }}」重划</span>
            </header>
            <div v-if="diff && diff.changed">
              <ul class="notes">
                <li v-for="(d, i) in diff.items" :key="i" :class="{ 'cell-bad': d.kind !== 'added' }">
                  <span class="tag" :class="d.kind === 'added' ? 'ok' : d.kind === 'removed' ? 'bad' : 'warn'">{{
                    d.kind === 'added' ? '新增' : d.kind === 'removed' ? '取消' : '变化'
                  }}</span>
                  {{ d.text }}
                </li>
              </ul>
            </div>
            <div v-else class="banner ok">与已采用的接线基线一致，分区无变化。</div>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>分区着色与电源落点</h2>
              <span class="hint">颜色 = 区号；方块 = 每区电源引线落点</span>
            </header>
            <PanelPreview
              v-if="layout"
              :project="project"
              :layout="layout"
              :show-led="useLed"
              :show-zones="useLed"
              :zone-map="useLed ? zoning?.atomZone ?? null : null"
              :zone-count="zoning?.zoneCount ?? 0"
              :feed-points="useLed && zoning ? zoning.zones.map((z) => ({ zoneNo: z.zoneNo, x: z.feedX, y: z.feedY })) : []"
              :show-dims="true"
              :show-margins="false"
            />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>逐字用量明细</h2>
              <span class="hint">模块数按每个连通域外轮廓分别向上取整（分区口径与之相同）</span>
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
            <p class="muted">逐字模组数之和与分区校核口径一致（都按笔画块分别取整）；报价材料以此为准。</p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.row-bad {
  background: rgba(198, 40, 40, 0.08);
}
.cell-bad {
  color: var(--danger);
  font-weight: 700;
}
</style>
