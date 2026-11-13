<template>
  <section class="page" data-module="dws">
    <header class="page-head">
      <div>
        <h2>汇总层建模管理</h2>
        <p class="page-desc">维护汇总层建模配置的输入、执行约束与结果记录，为汇总层建模提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记汇总表</button>
        <button class="btn" type="button" @click="exportRows">导出汇总层建模清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <article class="caliber-panel">
      <h3>明细层可引用口径（仅经键守恒工作台确认的集合允许进入 DWS）</h3>
      <table class="data-table">
        <thead>
          <tr><th>口径编号</th><th>来源明细表</th><th>去重口径</th><th>保留行数</th><th>字段版本</th><th>已引用汇总表</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="caliber in confirmedCalibers" :key="caliber.id">
            <td>{{ caliber.id }}</td>
            <td>{{ caliber.dwdTable }}</td>
            <td>{{ caliber.strategyId === 'FIRST_EVENT' ? '按事件时间留首条' : '按版本号留末条' }}</td>
            <td>{{ caliber.keptRowIds.length }}</td>
            <td>{{ caliber.schemaVersion }}</td>
            <td>{{ caliber.referencedByDws.join('、') || '—' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="reference(caliber.id)">引用到当前汇总表</button>
            </td>
          </tr>
          <tr v-if="!confirmedCalibers.length">
            <td colspan="7" class="empty-state">暂无已确认口径，请先到键守恒工作台确认集合</td>
          </tr>
        </tbody>
      </table>
      <p class="caliber-tip">候选态口径不会出现在这里；去「明细层建模 → 键守恒工作台」完成矩阵核对与确认。</p>
    </article>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无汇总层建模数据，可先登记汇总表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条汇总层建模记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  confirmedCalibersForDws,
  referenceCaliberByDws,
} from '@/api/key-conservation-service'
import type { Caliber } from '@/data/key-conservation/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dws')
const columns = ["表编号", "汇总主题", "聚合维度", "度量列定义", "上游明细表", "汇总粒度", "更新策略", "历史天数"]
const actions = ["提交校验", "启用汇总", "停用汇总"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "汇总表总数", "value": 0}, {"label": "已启用表", "value": 0}, {"label": "待校验表", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const confirmedCalibers = ref<Caliber[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reference(caliberId: string) {
  // 引用到当前清单中的第一张汇总表（纯前端演示没有选中行上下文）。
  const target = rows.value[0]
  const dwsTable = target ? String(target['表编号'] ?? `DWS-${target.id}`) : 'dws_demo_summary'
  const result = referenceCaliberByDws(caliberId, dwsTable)
  errorMessage.value = result.ok ? '' : result.message
  reloadCalibers()
}

function reloadCalibers() {
  confirmedCalibers.value = confirmedCalibersForDws()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '汇总表登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汇总层建模列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadCalibers()
})
</script>

<style scoped>
.caliber-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.caliber-panel h3 { margin: 0 0 10px; font-size: 14px; }
.caliber-tip { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
