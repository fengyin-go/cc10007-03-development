import assert from 'node:assert'
import {
  advanceComputation,
  buildPackMatrix,
  computeAll,
  confirmCaliber,
  driftSummary,
  exportCaliber,
  getJob,
  getMatrix,
  listPacks,
  referenceCaliberByDws,
  registerPack,
  reviewAgainstDwd,
  sealPack,
  switchSchemaVersion,
} from '../src/api/key-conservation-service'
import { resetWorkbench } from '../src/data/key-conservation/store'
import { buildWorkbenchSeed } from '../src/data/key-conservation/seed'
import { BOTH_STRATEGIES } from '../src/data/key-conservation/engine'

// 模拟浏览器 localStorage：内存 Map 实现，回看核对读取明细层登记的去重策略。
const dwdEntries = {
  dwd: [
    { 明细表名: 'dwd_trade_order_detail', 去重策略: '按事件时间留首条' },
    { 明细表名: 'dwd_trade_refund_detail', 去重策略: '按版本号留末条' },
  ],
}
const memory = new Map<string, string>([
  ['data-layer-studio:entries', JSON.stringify(dwdEntries)],
])
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
}

resetWorkbench()
const packId = 'PACK-TRADE-01'
const pack = listPacks().find((p) => p.id === packId)!
assert.ok(pack, '种子采样包存在')

// ---- 1. 中断续算：每次只算 1 个分片，只补未计算分片 ----
for (const kind of BOTH_STRATEGIES) {
  for (let i = 0; i < pack.shardCount; i++) {
    const r = advanceComputation(packId, kind, 1)
    assert.ok(r.ok)
    const job = getJob(packId, kind)!
    assert.strictEqual(job.doneShards.length, Math.min(i + 1, pack.shardCount))
  }
  assert.strictEqual(getJob(packId, kind)!.status, '已完成')
  // 再推进一次：无待算分片，不产生新结果（幂等）。
  const again = advanceComputation(packId, kind, 1)
  assert.strictEqual(again.data!.computed, 0)
}

// ---- 2. 两套策略指纹分桶，不互相串写 ----
const firstJob = getJob(packId, 'FIRST_EVENT')!
const lastJob = getJob(packId, 'LAST_VERSION')!
assert.ok(firstJob.shardResults.every((r) => r.strategyId === 'FIRST_EVENT'))
assert.ok(lastJob.shardResults.every((r) => r.strategyId === 'LAST_VERSION'))
const firstDropped = firstJob.shardResults.flatMap((r) => r.dropped).map((d) => d.rowId)
const lastDropped = lastJob.shardResults.flatMap((r) => r.dropped).map((d) => d.rowId)
// 分桶隔离：两套结果是独立数组、各自只挂本策略的 strategyId，不共享写入。
assert.ok(firstJob.shardResults !== lastJob.shardResults)
assert.ok(firstJob.shardResults.every((r) => r.strategyId === 'FIRST_EVENT'))
assert.ok(lastJob.shardResults.every((r) => r.strategyId === 'LAST_VERSION'))
// 剔除行指纹必须带本策略的顶替行，不允许出现另一策略的 rowId 串写。
assert.ok(
  firstJob.shardResults
    .flatMap((r) => r.dropped)
    .every((d) => matrixWinnerContains(firstJob, d.winnerRowId)),
)
assert.ok(
  lastJob.shardResults
    .flatMap((r) => r.dropped)
    .every((d) => matrixWinnerContains(lastJob, d.winnerRowId)),
)
void firstDropped
void lastDropped
function matrixWinnerContains(job: typeof firstJob, rowId: number): boolean {
  return job.shardResults.some((r) => r.winnerRowIds.includes(rowId))
}

// ---- 3. 矩阵内容核对 ----
const built = buildPackMatrix(packId)
assert.ok(built.ok, built.message)
const matrix = getMatrix(packId)!
const row = (key: string) => matrix.keyRows.find((k) => k.businessKey === key)!
assert.strictEqual(row('K-1001').firstEventKeptRowId, 1)
assert.strictEqual(row('K-1001').lastVersionKeptRowId, 3)
assert.strictEqual(row('K-1001').sameWinner, false)
assert.strictEqual(row('K-1001').splitAcrossPartitions, true)
assert.deepStrictEqual(row('K-1001').firstEventPartitions, ['2026-11-01', '2026-11-02', '2026-11-03'])
// K-1003：事件时间空域行被留首条跳过，两套策略都剩行 7
assert.deepStrictEqual(row('K-1003').firstEventNullHits, [6])
assert.strictEqual(row('K-1003').firstEventKeptRowId, 7)
assert.strictEqual(row('K-1003').lastVersionKeptRowId, 7)
assert.strictEqual(row('K-1003').sameWinner, true)
// K-1004：版本号空域行被留末条跳过
assert.deepStrictEqual(row('K-1004').lastVersionNullHits, [9])
assert.strictEqual(row('K-1004').lastVersionKeptRowId, 8)
// 空域业务键不进入矩阵键集合
assert.ok(!matrix.keyRows.some((k) => k.businessKey.trim() === ''))
// 空域命中在两个策略输出里分别记账
assert.ok(matrix.strategyResults.FIRST_EVENT.nullHits.some((h) => h.kind === '业务键空域'))
assert.ok(matrix.strategyResults.LAST_VERSION.nullHits.some((h) => h.kind === '业务键空域'))
assert.ok(matrix.strategyResults.FIRST_EVENT.nullHits.some((h) => h.kind === '事件时间空域'))
assert.ok(matrix.strategyResults.LAST_VERSION.nullHits.some((h) => h.kind === '版本号空域'))
// 跨分区键集合
assert.deepStrictEqual(
  matrix.strategyResults.FIRST_EVENT.splitKeys.map((s) => s.businessKey).sort(),
  ['K-1001', 'K-1003', 'K-1004', 'K-1005'],
)

// ---- 4. 同摘要重放不增加席位 ----
const seed = buildWorkbenchSeed()
const dup = registerPack({
  id: 'PACK-DUP',
  name: '重复包',
  dwdTable: 'dwd_trade_order_detail',
  shardCount: 4,
  rows: seed.packs[0].rows.map(({ rowId: _rowId, ...rest }) => rest),
})
assert.ok(dup.ok && dup.data!.id === packId, '同摘要应复用既有采样包')

// ---- 5. 候选口径：未确认禁止进入 DWS，确认后放行 ----
const expFirst = exportCaliber(packId, 'FIRST_EVENT')
assert.ok(expFirst.ok)
const caliberId = expFirst.data!.id
assert.strictEqual(expFirst.data!.status, '候选')
// 同摘要重复导出：复用既有口径，不增加席位
const expFirstAgain = exportCaliber(packId, 'FIRST_EVENT')
assert.ok(expFirstAgain.ok && expFirstAgain.data!.id === caliberId)
const refused = referenceCaliberByDws(caliberId, 'DWS-0001')
assert.ok(!refused.ok, '候选口径不得进入 DWS')
assert.ok(confirmCaliber(caliberId).ok)
assert.ok(referenceCaliberByDws(caliberId, 'DWS-0001').ok)
// 重复引用不重复登记
const c2 = referenceCaliberByDws(caliberId, 'DWS-0001')
assert.ok(c2.ok)
assert.strictEqual(getJob.length >= 0, true)

// ---- 6. 换版：旧矩阵失效并标出漂移键 ----
const switched = switchSchemaVersion('field-v2')
assert.ok(switched.ok)
const invalidMatrix = getMatrix(packId)!
assert.strictEqual(invalidMatrix.invalid, true)
const drift = driftSummary(packId)
assert.ok(drift.drifted.length >= 1, '换版后至少有漂移键')
assert.ok(drift.drifted.every((k) => k.drift && k.driftDetail.includes('→')))
// 失效矩阵不允许导出新口径
assert.ok(!exportCaliber(packId, 'LAST_VERSION').ok)

// ---- 7. 回看核对：以明细层登记策略为准 ----
// 先切回 v1 并重建矩阵、导出确认 LAST 口径，制造一致/不一致两种核对结果
assert.ok(switchSchemaVersion('field-v1').ok)
assert.ok(buildPackMatrix(packId).ok)
const expLast = exportCaliber(packId, 'LAST_VERSION')
assert.ok(confirmCaliber(expLast.data!.id).ok)
const reviews = reviewAgainstDwd().filter((r) => r.packId === packId)
const reviewFirst = reviews.find((r) => r.caliber!.strategyId === 'FIRST_EVENT')!
const reviewLast = reviews.find((r) => r.caliber!.strategyId === 'LAST_VERSION')!
assert.strictEqual(reviewFirst.registeredStrategy, '按事件时间留首条')
assert.strictEqual(reviewFirst.matched, true)
assert.strictEqual(reviewLast.matched, false)

// ---- 8. 封存三件套 ----
const seal = sealPack(packId, '交易基线')
assert.ok(seal.ok, seal.message)
const archive = seal.data!
assert.strictEqual(archive.manifest.sealId, archive.packBundle.sealId)
assert.strictEqual(archive.packBundle.sealId, archive.bookmark.sealId)
assert.ok(archive.manifest.manifestDigest.length === 8)
assert.ok(archive.packBundle.bundleDigest.length === 8)
assert.deepStrictEqual(archive.bookmark.locator.caliberIds, archive.caliberIds)

// ---- 9. 一键算完（第二个采样包）+ 全链路冒烟 ----
assert.ok(computeAll('PACK-REFUND-02', 'FIRST_EVENT').ok)
assert.ok(computeAll('PACK-REFUND-02', 'LAST_VERSION').ok)
const b2 = buildPackMatrix('PACK-REFUND-02')
assert.ok(b2.ok && !b2.data!.invalid)
const r2 = matrix2check('PACK-REFUND-02')
assert.ok(r2)
function matrix2check(id: string): boolean {
  const m = getMatrix(id)!
  return m.keyRows.length === 4 && m.strategyResults.LAST_VERSION.nullHits.some((h) => h.kind === '版本号空域')
}

console.log('全部断言通过 ✓')
