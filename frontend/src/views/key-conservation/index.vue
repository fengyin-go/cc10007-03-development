<template>
  <section class="page kc-page" data-module="key-conservation">
    <header class="page-head">
      <div>
        <h2>键守恒工作台 · 明细层去重口径</h2>
        <p class="page-desc">
          同一采样包的同一业务键分别套用「按事件时间留首条」与「按版本号留末条」，
          对照键守恒矩阵、剔除指纹、空域命中与跨分区分流；确认后的集合才允许进入 DWS。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetAll">重置工作台示例</button>
      </div>
    </header>

    <p v-if="flash" class="kc-flash" :class="flashOk ? 'ok' : 'err'">{{ flash }}</p>

    <!-- 1. 字段定义版本 -->
    <article class="kc-card">
      <h3>① 字段定义版本（换版即令旧矩阵失效）</h3>
      <div class="kc-schema">
        <label v-for="schema in state.schemas" :key="schema.version" class="kc-schema-item">
          <input
            type="radio"
            name="schema"
            :value="schema.version"
            :checked="state.activeSchemaVersion === schema.version"
            @change="switchSchema(schema.version)"
          />
          <div>
            <strong>{{ schema.version }}</strong>
            <span class="kc-muted">（指纹字段：{{ schema.fingerprintFields.join('、') }}）</span>
            <p class="kc-muted kc-note">{{ schema.note }} · 登记于 {{ schema.createdAt }}</p>
          </div>
        </label>
      </div>
    </article>

    <!-- 2. 采样包席位 -->
    <article class="kc-card">
      <h3>② 采样包席位（同内容摘要重放不增加席位）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>选择</th><th>采样包</th><th>明细表（主对象）</th><th>行数</th><th>分片</th>
            <th>字段版本</th><th>内容摘要</th><th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pack in state.packs" :key="pack.id" :class="{ active: pack.id === selectedPackId }">
            <td><input type="radio" :value="pack.id" v-model="selectedPackId" /></td>
            <td>{{ pack.id }} {{ pack.name }}</td>
            <td>{{ pack.dwdTable }}</td>
            <td>{{ pack.rows.length }}</td>
            <td>{{ pack.shardCount }}</td>
            <td>{{ pack.fieldSchemaVersion }}</td>
            <td><code>{{ pack.contentDigest }}</code></td>
            <td class="kc-muted">{{ pack.note }}</td>
          </tr>
        </tbody>
      </table>

      <details class="kc-register">
        <summary class="link">登记新采样包（粘贴 JSON 行集）</summary>
        <p class="kc-muted kc-note">
          行格式：businessKey / eventTime / version / partitionDate / payload；空业务键、空事件时间、空版本号可直接演示空域命中。
        </p>
        <div class="kc-form-row">
          <label>编号 <input v-model="newPack.id" placeholder="PACK-XXX-03" /></label>
          <label>名称 <input v-model="newPack.name" placeholder="采样包名称" /></label>
          <label>明细表 <input v-model="newPack.dwdTable" placeholder="dwd_xxx_detail" /></label>
          <label>分片数 <input v-model.number="newPack.shardCount" type="number" min="1" max="8" /></label>
        </div>
        <textarea v-model="newPack.rowsText" rows="5" class="kc-textarea" placeholder='[{"businessKey":"K-1","eventTime":"2026-11-01 08:00:00","version":"1","partitionDate":"2026-11-01","payload":{"amount":"1.00","channel":"APP","status":"已创建"}}]'></textarea>
        <button class="btn primary" type="button" @click="registerPack">登记（按摘要去重）</button>
      </details>
    </article>

    <template v-if="selectedPack">
      <!-- 3. 采样分片与中断续算 -->
      <article class="kc-card">
        <h3>③ 采样分片（中断只补齐未计算分片）</h3>
        <div class="kc-shards">
          <span v-for="shard in selectedPack.shards" :key="shard.shardNo" class="kc-shard">
            分片#{{ shard.shardNo }} · {{ shard.rowIds.length }} 行
            <code class="kc-muted">{{ shard.digest.slice(0, 8) }}</code>
          </span>
        </div>
      </article>

      <!-- 4. 两套策略作业 -->
      <article class="kc-card">
        <h3>④ 两套候选策略（指纹分桶，禁止互相串写）</h3>
        <div class="kc-strategy-grid">
          <div v-for="kind in strategyKinds" :key="kind" class="kc-strategy">
            <h4>{{ strategyLabel(kind) }} <code>{{ kind }}</code></h4>
            <template v-if="jobOf(kind)">
              <p>状态：<strong>{{ jobOf(kind)!.status }}</strong> · 字段版本 {{ jobOf(kind)!.schemaVersion }}</p>
              <p class="kc-muted">
                已完成分片 {{ jobOf(kind)!.doneShards.length }}/{{ selectedPack.shardCount }}：
                {{ jobOf(kind)!.doneShards.join(', ') || '—' }}
              </p>
            </template>
            <p v-else class="kc-muted">尚未开始计算</p>
            <div class="kc-btn-row">
              <button class="btn primary" type="button" @click="advance(kind, 1)">算 1 个分片（模拟中断）</button>
              <button class="btn" type="button" @click="advance(kind, 2)">算 2 个分片</button>
              <button class="btn" type="button" @click="computeAll(kind)">一键算完（续算）</button>
            </div>
          </div>
        </div>
        <button class="btn primary" type="button" @click="buildMatrix">构建键守恒矩阵</button>
      </article>

      <!-- 5. 键守恒矩阵 -->
      <article class="kc-card">
        <h3>⑤ 键守恒矩阵</h3>
        <div v-if="matrix" class="kc-matrix-head">
          <p>
            矩阵摘要 <code>{{ matrix.contentDigest }}</code> · 构建版本 {{ matrix.schemaVersion }} ·
            构建时间 {{ matrix.builtAt }}
          </p>
          <p v-if="matrix.invalid" class="kc-banner err">⚠ 矩阵已失效：{{ matrix.invalidReason }}</p>
          <p v-else class="kc-banner ok">✓ 矩阵与当前字段定义版本一致，可导出候选口径</p>
        </div>
        <p v-else class="kc-muted">两套策略都算完后构建矩阵。</p>
        <table v-if="matrix" class="data-table kc-matrix">
          <thead>
            <tr>
              <th>业务键</th><th>输入行数</th>
              <th>留首条胜出行</th><th>留末条胜出行</th><th>两策略一致</th>
              <th>跨分区日期分流</th><th>留首条空域命中</th><th>留末条空域命中</th><th>漂移</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in matrix.keyRows" :key="row.businessKey" :class="{ drift: row.drift }">
              <td>{{ row.businessKey }}</td>
              <td>{{ row.inputCount }}</td>
              <td>#{{ row.firstEventKeptRowId ?? '—' }}</td>
              <td>#{{ row.lastVersionKeptRowId ?? '—' }}</td>
              <td>
                <span :class="row.sameWinner ? 'kc-ok' : 'kc-warn'">{{ row.sameWinner ? '一致' : '不一致' }}</span>
              </td>
              <td>
                <span v-if="row.splitAcrossPartitions" class="kc-warn">
                  {{ row.firstEventPartitions.join(' / ') }}
                </span>
                <span v-else class="kc-muted">单分区</span>
              </td>
              <td>
                <span v-if="row.firstEventNullHits.length" class="kc-warn">行#{{ row.firstEventNullHits.join('、#') }}</span>
                <span v-else>—</span>
              </td>
              <td>
                <span v-if="row.lastVersionNullHits.length" class="kc-warn">行#{{ row.lastVersionNullHits.join('、#') }}</span>
                <span v-else>—</span>
              </td>
              <td>
                <span v-if="row.drift" class="kc-err" :title="row.driftDetail">漂移 ⓘ</span>
                <span v-else class="kc-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <!-- 6. 剔除指纹 / 空域 / 跨分区 -->
      <article class="kc-card">
        <h3>⑥ 被剔除行指纹 · 空域命中 · 跨分区分流（按策略独立分桶）</h3>
        <div class="kc-strategy-grid">
          <div v-for="kind in strategyKinds" :key="kind" class="kc-strategy">
            <h4>{{ strategyLabel(kind) }}</h4>
            <template v-if="outputOf(kind)">
              <p class="kc-muted">
                保留 {{ outputOf(kind)!.keptRowIds.length }} 行 · 剔除 {{ outputOf(kind)!.dropped.length }} 行 ·
                输出摘要 <code>{{ outputOf(kind)!.contentDigest.slice(0, 12) }}</code>
              </p>
              <table class="data-table kc-small">
                <thead><tr><th>剔除行</th><th>业务键</th><th>行指纹</th><th>顶替行</th><th>原因</th></tr></thead>
                <tbody>
                  <tr v-for="drop in outputOf(kind)!.dropped" :key="`${kind}-${drop.rowId}`">
                    <td>#{{ drop.rowId }}</td>
                    <td>{{ drop.businessKey }}</td>
                    <td><code>{{ drop.fingerprint.slice(0, 12) }}</code></td>
                    <td>#{{ drop.winnerRowId }}</td>
                    <td class="kc-muted">{{ drop.reason }}</td>
                  </tr>
                  <tr v-if="!outputOf(kind)!.dropped.length">
                    <td colspan="5" class="empty-state">无剔除行</td>
                  </tr>
                </tbody>
              </table>
              <p class="kc-sub">空域命中（{{ outputOf(kind)!.nullHits.length }}）</p>
              <ul class="kc-list">
                <li v-for="hit in outputOf(kind)!.nullHits" :key="`${kind}-null-${hit.rowId}`">
                  行#{{ hit.rowId }} · {{ hit.businessKey }} · <span class="kc-warn">{{ hit.kind }}</span>
                </li>
                <li v-if="!outputOf(kind)!.nullHits.length" class="kc-muted">无空域命中</li>
              </ul>
              <p class="kc-sub">跨分区日期分流（{{ outputOf(kind)!.splitKeys.length }}）</p>
              <ul class="kc-list">
                <li v-for="split in outputOf(kind)!.splitKeys" :key="`${kind}-${split.businessKey}`">
                  {{ split.businessKey }} → <span class="kc-warn">{{ split.partitions.join(' / ') }}</span>
                </li>
                <li v-if="!outputOf(kind)!.splitKeys.length" class="kc-muted">无跨分区分流</li>
              </ul>
            </template>
            <p v-else class="kc-muted">该策略尚未产出结果</p>
          </div>
        </div>
      </article>

      <!-- 7. 候选口径导出与确认 -->
      <article class="kc-card">
        <h3>⑦ 导出候选口径给汇总层（经确认的集合才允许进入 DWS）</h3>
        <div class="kc-btn-row">
          <button v-for="kind in strategyKinds" :key="kind" class="btn" type="button" @click="exportCaliber(kind)">
            导出「{{ strategyLabel(kind) }}」候选口径
          </button>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>口径编号</th><th>策略</th><th>保留行</th><th>摘要</th><th>状态</th><th>DWS 引用</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="caliber in packCalibers" :key="caliber.id">
              <td>{{ caliber.id }}</td>
              <td>{{ strategyLabel(caliber.strategyId) }}</td>
              <td>{{ caliber.keptRowIds.length }} 行</td>
              <td><code>{{ caliber.contentDigest.slice(0, 12) }}</code></td>
              <td>
                <span :class="caliber.status === '已确认' ? 'kc-ok' : 'kc-warn'">{{ caliber.status }}</span>
              </td>
              <td>{{ caliber.referencedByDws.join('、') || '—' }}</td>
              <td>
                <button v-if="caliber.status === '候选'" class="link" type="button" @click="confirmCaliber(caliber.id)">
                  确认集合
                </button>
                <span v-else class="kc-muted">已对 DWS 开放</span>
              </td>
            </tr>
            <tr v-if="!packCalibers.length">
              <td colspan="7" class="empty-state">暂无候选口径</td>
            </tr>
          </tbody>
        </table>
      </article>

      <!-- 8. 封存三件套 -->
      <article class="kc-card">
        <h3>⑧ 封存：manifest + pack_bundle + bookmark 共同封存</h3>
        <div class="kc-form-row">
          <label class="kc-bookmark-label">书签名称 <input v-model="bookmarkLabel" placeholder="例如：交易明细 11 月上旬基线" /></label>
          <button class="btn primary" type="button" @click="seal">共同封存</button>
        </div>
        <table class="data-table">
          <thead><tr><th>封存号</th><th>采样包摘要</th><th>manifest 摘要</th><th>bundle 摘要</th><th>书签定位</th><th>时间</th><th>下载</th></tr></thead>
          <tbody>
            <tr v-for="seal in packSeals" :key="seal.sealId">
              <td>{{ seal.sealId }}</td>
              <td><code>{{ seal.packDigest.slice(0, 10) }}</code></td>
              <td><code>{{ seal.manifest.manifestDigest.slice(0, 10) }}</code></td>
              <td><code>{{ seal.packBundle.bundleDigest.slice(0, 10) }}</code></td>
              <td class="kc-muted">{{ seal.bookmark.label }}（{{ seal.bookmark.locator.caliberIds.join('、') }}）</td>
              <td>{{ seal.createdAt }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="downloadSeal(seal, 'manifest')">manifest</button>
                <button class="link" type="button" @click="downloadSeal(seal, 'bundle')">pack_bundle</button>
                <button class="link" type="button" @click="downloadSeal(seal, 'bookmark')">bookmark</button>
              </td>
            </tr>
            <tr v-if="!packSeals.length">
              <td colspan="7" class="empty-state">暂无封存记录</td>
            </tr>
          </tbody>
        </table>
      </article>
    </template>

    <!-- 9. 回看核对（以明细层建模为主对象） -->
    <article class="kc-card">
      <h3>⑨ 回看：核对明细表去重结果（以明细层建模为主对象）</h3>
      <table class="data-table">
        <thead><tr><th>明细表</th><th>采样包</th><th>口径</th><th>明细表登记去重策略</th><th>核对</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.caliber?.id" :class="{ mismatch: !item.matched }">
            <td>{{ item.dwdTable }}</td>
            <td>{{ item.packId }}</td>
            <td>{{ item.caliber ? strategyLabel(item.caliber.strategyId) : '—' }}</td>
            <td>{{ item.registeredStrategy }}</td>
            <td><span :class="item.matched ? 'kc-ok' : 'kc-err'">{{ item.matched ? '一致' : '不一致' }}</span></td>
            <td class="kc-muted">{{ item.detail }}</td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="6" class="empty-state">确认口径后在此回看核对</td>
          </tr>
        </tbody>
      </table>
      <p class="kc-muted kc-note">
        核对依据来自「明细层建模」模块中该明细表登记的「去重策略」字段；不一致时回明细表修正，工作台不反向改写明细层登记。
      </p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import {
  advanceComputation,
  buildPackMatrix,
  computeAll as computeAllService,
  confirmCaliber as confirmCaliberService,
  driftSummary,
  exportCaliber as exportCaliberService,
  listCalibers,
  listJobs,
  listSeals,
  registerPack as registerPackService,
  reviewAgainstDwd,
  sealPack,
  switchSchemaVersion,
} from '@/api/key-conservation-service'
import { resetWorkbench, workbenchState } from '@/data/key-conservation/store'
import { STRATEGY_LABEL } from '@/data/key-conservation/types'
import type { JobState, SampleRow, SealArchive, StrategyKind } from '@/data/key-conservation/types'

const state = reactive(workbenchState())
const selectedPackId = ref(state.packs[0]?.id ?? '')
const flash = ref('')
const flashOk = ref(true)
const bookmarkLabel = ref('')

const strategyKinds: StrategyKind[] = ['FIRST_EVENT', 'LAST_VERSION']
const newPack = reactive({ id: '', name: '', dwdTable: '', shardCount: 3, rowsText: '' })

const selectedPack = computed(() => state.packs.find((pack) => pack.id === selectedPackId.value))
const matrix = computed(() =>
  selectedPackId.value ? state.matrices.find((item) => item.packId === selectedPackId.value) : undefined,
)
const packCalibers = computed(() => listCalibers(selectedPackId.value))
const packSeals = computed(() => listSeals().filter((seal) => seal.packId === selectedPackId.value))
const reviews = computed(() => reviewAgainstDwd())

function strategyLabel(kind: StrategyKind): string {
  return STRATEGY_LABEL[kind]
}

function notify(message: string, ok = true): void {
  flash.value = message
  flashOk.value = ok
}

function refresh(): void {
  const fresh = workbenchState()
  state.packs = fresh.packs
  state.schemas = fresh.schemas
  state.activeSchemaVersion = fresh.activeSchemaVersion
  state.jobs = fresh.jobs
  state.matrices = fresh.matrices
  state.calibers = fresh.calibers
  state.seals = fresh.seals
}

function jobOf(kind: StrategyKind): JobState | undefined {
  return listJobs(selectedPackId.value).find((job) => job.strategyId === kind)
}

function outputOf(kind: StrategyKind) {
  return matrix.value?.strategyResults[kind]
}

function advance(kind: StrategyKind, limit: number): void {
  const result = advanceComputation(selectedPackId.value, kind, limit)
  refresh()
  notify(result.message, result.ok)
}

function computeAll(kind: StrategyKind): void {
  const result = computeAllService(selectedPackId.value, kind)
  refresh()
  notify(result.message, result.ok)
}

function buildMatrix(): void {
  const result = buildPackMatrix(selectedPackId.value)
  refresh()
  if (result.data) {
    const drift = driftSummary(selectedPackId.value)
    notify(
      result.data.invalid
        ? `${result.message}；漂移键：${drift.drifted.map((row) => row.businessKey).join('、') || '无指纹变化'}`
        : result.message,
      result.ok,
    )
  } else {
    notify(result.message, false)
  }
}

function exportCaliber(kind: StrategyKind): void {
  const result = exportCaliberService(selectedPackId.value, kind)
  refresh()
  notify(result.message, result.ok)
}

function confirmCaliber(id: string): void {
  const result = confirmCaliberService(id)
  refresh()
  notify(result.message, result.ok)
}

function switchSchema(version: string): void {
  const result = switchSchemaVersion(version)
  refresh()
  notify(result.message, result.ok)
}

function registerPack(): void {
  let rows: Array<Omit<SampleRow, 'rowId'>>
  try {
    rows = JSON.parse(newPack.rowsText)
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('需要非空数组')
  } catch (error) {
    notify(`行集 JSON 解析失败：${error instanceof Error ? error.message : '格式错误'}`, false)
    return
  }
  const result = registerPackService({
    id: newPack.id || `PACK-${Date.now()}`,
    name: newPack.name || '自定义采样包',
    dwdTable: newPack.dwdTable || 'dwd_unknown_detail',
    shardCount: newPack.shardCount || 3,
    rows,
  })
  refresh()
  if (result.data) selectedPackId.value = result.data.id
  notify(result.message, result.ok)
}

function seal(): void {
  const result = sealPack(selectedPackId.value, bookmarkLabel.value)
  refresh()
  notify(result.message, result.ok)
  if (result.ok) bookmarkLabel.value = ''
}

function downloadSeal(seal: SealArchive, part: 'manifest' | 'bundle' | 'bookmark'): void {
  const content =
    part === 'manifest' ? seal.manifest : part === 'bundle' ? seal.packBundle : seal.bookmark
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${seal.sealId}.${part}.json`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function resetAll(): void {
  resetWorkbench()
  refresh()
  selectedPackId.value = state.packs[0]?.id ?? ''
  notify('工作台已重置为示例数据')
}
</script>

<style scoped>
.kc-page { display: flex; flex-direction: column; gap: 14px; }
.kc-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.kc-card h3 { margin: 0 0 10px; font-size: 15px; }
.kc-card h4 { margin: 0 0 8px; font-size: 13px; }
.kc-muted { color: var(--muted); }
.kc-note { font-size: 12px; margin: 4px 0 0; }
.kc-flash { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 0; }
.kc-flash.ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.kc-flash.err { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.kc-schema { display: flex; gap: 16px; flex-wrap: wrap; }
.kc-schema-item { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; flex: 1; min-width: 320px; }
.kc-shards { display: flex; gap: 8px; flex-wrap: wrap; }
.kc-shard { background: #eef2f7; border-radius: 6px; padding: 4px 10px; font-size: 12px; display: flex; gap: 6px; align-items: center; }
.kc-strategy-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
.kc-strategy { border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
.kc-btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
.kc-matrix-head p { margin: 4px 0; font-size: 13px; }
.kc-banner { border-radius: 6px; padding: 6px 10px; font-size: 12px; }
.kc-banner.ok { background: #ecfdf3; color: #027a48; }
.kc-banner.err { background: #fef3f2; color: #b42318; }
.kc-matrix tr.drift { background: #fffaeb; }
.kc-small { font-size: 12px; }
.kc-sub { margin: 10px 0 4px; font-size: 12px; font-weight: 600; }
.kc-list { margin: 0; padding-left: 18px; font-size: 12px; }
.kc-list li { margin-bottom: 2px; }
.kc-ok { color: #027a48; font-weight: 600; }
.kc-warn { color: #b54708; font-weight: 600; }
.kc-err { color: #b42318; font-weight: 600; }
.kc-register { margin-top: 10px; }
.kc-register summary { cursor: pointer; font-size: 13px; margin-bottom: 8px; }
.kc-form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 8px; }
.kc-form-row label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); gap: 4px; }
.kc-form-row input { min-width: 160px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.kc-textarea { width: 100%; font-family: monospace; font-size: 12px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; }
tr.active { background: #eff8ff; }
tr.mismatch { background: #fef3f2; }
code { font-size: 11px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
@media (max-width: 1100px) { .kc-strategy-grid { grid-template-columns: 1fr; } }
</style>
