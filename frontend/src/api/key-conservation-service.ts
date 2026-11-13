/**
 * 键守恒工作台本地服务：页面只负责渲染，所有业务判断集中在本文件。
 *
 * 关键约束：
 * 1. 采样包/策略/结果都带内容摘要，同摘要重放直接复用，不增加席位；
 * 2. 中断恢复只补未计算分片，两套策略的剔除指纹分桶存放、互不串写；
 * 3. 字段定义换版后旧矩阵失效并给出漂移键；
 * 4. 只有「已确认」口径允许被汇总层引用进入 DWS。
 */
import { contentDigest } from '@/data/key-conservation/digest'
import {
  BOTH_STRATEGIES,
  buildMatrix,
  buildShards,
  computeShard,
  driftedKeys,
  isJobComplete,
  mergeShardResults,
  packDigest,
  pendingShards,
  rowFingerprint,
} from '@/data/key-conservation/engine'
import { saveWorkbench, workbenchState } from '@/data/key-conservation/store'
import type {
  Caliber,
  FieldSchema,
  JobState,
  MatrixRecord,
  SamplePack,
  SampleRow,
  SealArchive,
  StrategyKind,
  StrategyOutput,
  WorkbenchState,
} from '@/data/key-conservation/types'

export type ServiceResult<T = void> = { ok: boolean; message: string; data?: T }

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function persist(next: WorkbenchState): void {
  saveWorkbench(next)
}

function requirePack(state: WorkbenchState, packId: string): SamplePack {
  const pack = state.packs.find((item) => item.id === packId)
  if (!pack) throw new Error(`采样包 ${packId} 不存在`)
  return pack
}

function requireSchema(state: WorkbenchState, version: string): FieldSchema {
  const schema = state.schemas.find((item) => item.version === version)
  if (!schema) throw new Error(`字段定义版本 ${version} 不存在`)
  return schema
}

export function listPacks(): SamplePack[] {
  return workbenchState().packs
}

export function getPack(packId: string): SamplePack | undefined {
  return workbenchState().packs.find((item) => item.id === packId)
}

export function listJobs(packId: string): JobState[] {
  return workbenchState().jobs.filter((job) => job.packId === packId)
}

export function getJob(packId: string, strategyId: StrategyKind): JobState | undefined {
  return workbenchState().jobs.find((job) => job.packId === packId && job.strategyId === strategyId)
}

export function getMatrix(packId: string): MatrixRecord | undefined {
  return workbenchState().matrices.find((matrix) => matrix.packId === packId)
}

export function listCalibers(packId?: string): Caliber[] {
  const state = workbenchState()
  return packId ? state.calibers.filter((item) => item.packId === packId) : state.calibers
}

/** 只有已确认口径允许进入 DWS。 */
export function confirmedCalibersForDws(dwdTable?: string): Caliber[] {
  const state = workbenchState()
  return state.calibers.filter(
    (caliber) => caliber.status === '已确认' && (!dwdTable || caliber.dwdTable === dwdTable),
  )
}

export function listSeals(): SealArchive[] {
  return workbenchState().seals
}

/**
 * 登记采样包：按内容摘要去重，同一摘要重放不增加席位，直接复用既有包。
 */
export function registerPack(input: {
  id: string
  name: string
  dwdTable: string
  shardCount: number
  rows: Array<Omit<SampleRow, 'rowId'>>
  note?: string
}): ServiceResult<SamplePack> {
  const state = workbenchState()
  const rows: SampleRow[] = input.rows.map((row, index) => ({ ...row, rowId: index + 1 }))
  const digest = packDigest(rows, state.activeSchemaVersion)
  const existing = state.packs.find((item) => item.contentDigest === digest)
  if (existing) {
    return { ok: true, message: `内容摘要 ${digest} 已存在，重放不增加席位，直接复用 ${existing.id}`, data: existing }
  }
  if (state.packs.some((item) => item.id === input.id)) {
    return { ok: false, message: `采样包编号 ${input.id} 已被占用` }
  }
  const pack: SamplePack = {
    id: input.id,
    name: input.name,
    dwdTable: input.dwdTable,
    businessKeyField: 'order_no',
    shardCount: input.shardCount,
    rows,
    shards: buildShards(rows, input.shardCount),
    fieldSchemaVersion: state.activeSchemaVersion,
    contentDigest: digest,
    createdAt: now(),
    note: input.note ?? '',
  }
  persist({ ...state, packs: [...state.packs, pack] })
  return { ok: true, message: `采样包已登记，内容摘要 ${digest}`, data: pack }
}

function ensureJob(state: WorkbenchState, pack: SamplePack, strategyId: StrategyKind): JobState {
  let job = state.jobs.find((item) => item.packId === pack.id && item.strategyId === strategyId)
  if (!job) {
    job = {
      packId: pack.id,
      strategyId,
      schemaVersion: state.activeSchemaVersion,
      doneShards: [],
      shardResults: [],
      status: '待计算',
      startedAt: now(),
      updatedAt: now(),
    }
    state.jobs.push(job)
  }
  return job
}

/**
 * 推进计算：可分批调用（模拟中断）。只处理尚未计算的分片，
 * 分片摘要已存在则跳过；limit 限制本次最多计算几个分片。
 * 两套策略各自维护独立 JobState，剔除指纹不会互相串写。
 */
export function advanceComputation(
  packId: string,
  strategyId: StrategyKind,
  limit: number,
): ServiceResult<{ job: JobState; computed: number; reused: number }> {
  const state = workbenchState()
  const pack = requirePack(state, packId)
  const schema = requireSchema(state, state.activeSchemaVersion)
  const job = ensureJob(state, pack, strategyId)

  // 字段定义换版后，旧分片结果整体作废。
  if (job.schemaVersion !== schema.version) {
    job.schemaVersion = schema.version
    job.doneShards = []
    job.shardResults = []
    job.status = '待计算'
  }

  const todo = pendingShards(job, pack)
  const reusable = pack.shards.length - todo.length
  const batch = todo.slice(0, limit)
  for (const shard of batch) {
    // 每个策略独立 computeShard，返回的剔除指纹只挂在本策略结果上。
    const result = computeShard(pack, schema, shard, strategyId, now())
    job.shardResults = [...job.shardResults.filter((item) => item.shardNo !== shard.shardNo), result]
    job.doneShards = [...new Set([...job.doneShards, shard.shardNo])].sort((a, b) => a - b)
  }
  job.updatedAt = now()
  const complete = isJobComplete(job, pack)
  job.status = complete ? '已完成' : batch.length === 0 ? '已中断' : '计算中'
  if (!complete && batch.length < todo.length) job.status = '已中断'
  persist({ ...state })
  return {
    ok: true,
    message: complete
      ? `${strategyId === 'FIRST_EVENT' ? '留首条' : '留末条'}策略全部分片计算完成`
      : `本次补齐 ${batch.length} 个分片，仍有 ${todo.length - batch.length} 个分片待计算（中断态可续算）`,
    data: { job, computed: batch.length, reused: reusable },
  }
}

/** 一键算完：循环补齐剩余分片。 */
export function computeAll(packId: string, strategyId: StrategyKind): ServiceResult<unknown> {
  const state = workbenchState()
  const pack = requirePack(state, packId)
  let guard = 0
  let last: ServiceResult<unknown> = { ok: true, message: '没有需要计算的分片' }
  // eslint-disable-next-line no-constant-condition
  while (guard < pack.shards.length + 2) {
    last = advanceComputation(packId, strategyId, Math.max(1, pack.shardCount))
    const job = getJob(packId, strategyId)
    if (!job || job.status === '已完成') return last
    guard += 1
  }
  return { ok: false, message: '计算未收敛，请检查分片配置' }
}

/** 两套策略都完成后构建键守恒矩阵；任一未完成则拒绝。 */
export function buildPackMatrix(packId: string): ServiceResult<MatrixRecord> {
  const state = workbenchState()
  const pack = requirePack(state, packId)
  const currentSchema = requireSchema(state, state.activeSchemaVersion)
  const outputs = {} as Record<StrategyKind, StrategyOutput>
  for (const strategyId of BOTH_STRATEGIES) {
    const job = state.jobs.find((item) => item.packId === packId && item.strategyId === strategyId)
    if (!job || !isJobComplete(job, pack)) {
      return { ok: false, message: `${strategyId === 'FIRST_EVENT' ? '留首条' : '留末条'}策略尚未算完，无法构建矩阵` }
    }
    const jobSchema = requireSchema(state, job.schemaVersion)
    outputs[strategyId] = mergeShardResults(pack, jobSchema, job.shardResults, strategyId)
  }
  // 矩阵按作业实际使用的字段定义构建，再与当前激活版本比对决定失效与漂移。
  const firstJob = state.jobs.find((item) => item.packId === packId && item.strategyId === 'FIRST_EVENT')!
  const builtWithSchema = requireSchema(state, firstJob.schemaVersion)
  const matrix = buildMatrix(pack, outputs, builtWithSchema, currentSchema, now())
  persist({ ...state, matrices: [...state.matrices.filter((item) => item.packId !== packId), matrix] })
  return {
    ok: true,
    message: matrix.invalid
      ? `矩阵已构建但已失效：${matrix.invalidReason}；漂移键 ${driftedKeys(matrix).length} 个`
      : '键守恒矩阵已构建，两套策略口径一致键可导出候选口径',
    data: matrix,
  }
}

/** 导出候选口径给汇总层（状态为候选，确认后才可进入 DWS）。 */
export function exportCaliber(packId: string, strategyId: StrategyKind): ServiceResult<Caliber> {
  const state = workbenchState()
  const pack = requirePack(state, packId)
  const matrix = state.matrices.find((item) => item.packId === packId)
  if (!matrix) return { ok: false, message: '请先构建键守恒矩阵' }
  if (matrix.invalid) return { ok: false, message: '矩阵已随字段定义换版失效，请按新版本重算后再导出' }
  const output = matrix.strategyResults[strategyId]
  const schema = requireSchema(state, matrix.schemaVersion)
  const keptFingerprints = output.keptRowIds.map((rowId) => {
    const row = pack.rows.find((item) => item.rowId === rowId)!
    return rowFingerprint(row, schema)
  })
  const digest = contentDigest({ packId, strategyId, keptFingerprints })
  const duplicate = state.calibers.find((item) => item.contentDigest === digest)
  if (duplicate) {
    return { ok: true, message: `同摘要口径已存在（${duplicate.id}），重放不增加席位`, data: duplicate }
  }
  const caliber: Caliber = {
    id: `CAL-${packId}-${strategyId}`,
    packId,
    packName: pack.name,
    dwdTable: pack.dwdTable,
    strategyId,
    keptFingerprints,
    keptRowIds: [...output.keptRowIds],
    matrixDigest: matrix.contentDigest,
    schemaVersion: matrix.schemaVersion,
    contentDigest: digest,
    status: '候选',
    referencedByDws: [],
    createdAt: now(),
    confirmedAt: null,
  }
  persist({ ...state, calibers: [...state.calibers, caliber] })
  return { ok: true, message: `候选口径 ${caliber.id} 已导出，确认后才允许进入 DWS`, data: caliber }
}

/** 确认集合：只有确认后的口径对汇总层开放。 */
export function confirmCaliber(caliberId: string): ServiceResult {
  const state = workbenchState()
  const caliber = state.calibers.find((item) => item.id === caliberId)
  if (!caliber) return { ok: false, message: `口径 ${caliberId} 不存在` }
  if (caliber.status === '已确认') return { ok: true, message: '口径已是确认态，无需重复确认' }
  const matrix = state.matrices.find((item) => item.packId === caliber.packId)
  if (matrix?.invalid) return { ok: false, message: '底层矩阵已失效，不能确认该口径' }
  caliber.status = '已确认'
  caliber.confirmedAt = now()
  persist({ ...state })
  return { ok: true, message: `口径 ${caliberId} 已确认，汇总层现在可以引用` }
}

/** 汇总层引用确认口径；未确认口径一律拒绝。 */
export function referenceCaliberByDws(caliberId: string, dwsTable: string): ServiceResult {
  const state = workbenchState()
  const caliber = state.calibers.find((item) => item.id === caliberId)
  if (!caliber) return { ok: false, message: `口径 ${caliberId} 不存在` }
  if (caliber.status !== '已确认') {
    return { ok: false, message: '只有经确认的集合才允许进入 DWS，请先在工作台确认口径' }
  }
  if (!caliber.referencedByDws.includes(dwsTable)) {
    caliber.referencedByDws.push(dwsTable)
    persist({ ...state })
  }
  return { ok: true, message: `汇总表 ${dwsTable} 已引用确认口径 ${caliberId}` }
}

/**
 * 切换字段定义版本：旧矩阵立即失效，漂移键在矩阵中逐项标出。
 */
export function switchSchemaVersion(version: string): ServiceResult {
  const state = workbenchState()
  const schema = state.schemas.find((item) => item.version === version)
  if (!schema) return { ok: false, message: `字段定义版本 ${version} 不存在` }
  if (state.activeSchemaVersion === version) {
    return { ok: true, message: `当前已是 ${version}` }
  }
  const next: WorkbenchState = { ...state, activeSchemaVersion: version }
  // 重新评估每张矩阵的失效标记与漂移键。
  next.matrices = state.matrices.map((matrix) => {
    const pack = state.packs.find((item) => item.id === matrix.packId)
    if (!pack) return matrix
    const builtWith = state.schemas.find((item) => item.version === matrix.schemaVersion)!
    const rebuilt = buildMatrix(pack, matrix.strategyResults, builtWith, schema, matrix.builtAt)
    return { ...rebuilt, builtAt: matrix.builtAt }
  })
  persist(next)
  const driftTotal = next.matrices.reduce((sum, matrix) => sum + driftedKeys(matrix).length, 0)
  return {
    ok: true,
    message: `已切换到 ${version}：${next.matrices.length} 张矩阵失效，累计标出漂移键 ${driftTotal} 个，需重算后才能导出新口径`,
  }
}

/**
 * 封存：manifest、pack_bundle、bookmark 共用封存号，一次生成三件套。
 */
export function sealPack(packId: string, bookmarkLabel: string): ServiceResult<SealArchive> {
  const state = workbenchState()
  const pack = requirePack(state, packId)
  const matrix = state.matrices.find((item) => item.packId === packId)
  if (!matrix) return { ok: false, message: '矩阵尚未构建，无法封存' }
  const calibers = state.calibers.filter((item) => item.packId === packId && item.status === '已确认')
  if (calibers.length === 0) {
    return { ok: false, message: '没有已确认口径，封存前至少确认一套策略集合' }
  }
  const sealId = `SEAL-${packId}-${now().replace(/[-: ]/g, '').slice(0, 14)}`
  const manifest = {
    sealId,
    createdAt: now(),
    packId,
    packDigest: pack.contentDigest,
    schemaVersion: matrix.schemaVersion,
    matrices: BOTH_STRATEGIES.map((strategyId) => ({
      strategyId,
      outputDigest: matrix.strategyResults[strategyId].contentDigest,
      keptCount: matrix.strategyResults[strategyId].keptRowIds.length,
      droppedCount: matrix.strategyResults[strategyId].dropped.length,
    })),
    calibers: calibers.map((caliber) => ({
      caliberId: caliber.id,
      strategyId: caliber.strategyId,
      contentDigest: caliber.contentDigest,
      status: caliber.status,
    })),
    manifestDigest: '',
  }
  manifest.manifestDigest = contentDigest(manifest)
  const packBundle = {
    sealId,
    packDigest: pack.contentDigest,
    bundleDigest: '',
    packSnapshot: pack,
    strategyOutputs: matrix.strategyResults,
  }
  packBundle.bundleDigest = contentDigest(packBundle)
  const archive: SealArchive = {
    sealId,
    packId,
    packDigest: pack.contentDigest,
    caliberIds: calibers.map((item) => item.id),
    manifest,
    packBundle,
    bookmark: {
      sealId,
      label: bookmarkLabel || `${pack.name} 封存书签`,
      dwdTable: pack.dwdTable,
      locator: { packId, caliberIds: calibers.map((item) => item.id), schemaVersion: matrix.schemaVersion },
      createdAt: now(),
    },
    createdAt: now(),
  }
  persist({ ...state, seals: [...state.seals, archive] })
  return { ok: true, message: `封存完成：manifest / pack_bundle / bookmark 已共同封存为 ${sealId}`, data: archive }
}

/** 回看：核对明细表去重结果，以明细层建模为主对象。 */
export function reviewAgainstDwd(): {
  dwdTable: string
  packId: string
  caliber?: Caliber
  matrix?: MatrixRecord
  registeredStrategy: string
  matched: boolean
  detail: string
}[] {
  const state = workbenchState()
  return state.calibers.map((caliber) => {
    const pack = state.packs.find((item) => item.id === caliber.packId)
    const matrix = state.matrices.find((item) => item.packId === caliber.packId)
    // 明细层主对象：dwd 模块里该表登记的去重策略。
    const registered = readDwdStrategy(caliber.dwdTable)
    const strategyCode = caliber.strategyId === 'FIRST_EVENT' ? '按事件时间留首条' : '按版本号留末条'
    const matched = registered.includes(strategyCode)
    return {
      dwdTable: caliber.dwdTable,
      packId: caliber.packId,
      caliber,
      matrix,
      registeredStrategy: registered,
      matched,
      detail: matched
        ? `明细表登记口径「${registered}」与工作台确认集合（${strategyCode}，${caliber.keptRowIds.length} 行）一致`
        : `明细表登记口径「${registered}」与工作台集合（${strategyCode}）不一致，以明细层建模为主对象，请回明细表修正`,
    }
  })
}

/** 从明细层模块的登记行读取该表的去重策略（跨模块只读引用）。 */
function readDwdStrategy(dwdTable: string): string {
  if (typeof window === 'undefined' || !window.localStorage) return '未登记'
  try {
    const raw = window.localStorage.getItem('data-layer-studio:entries')
    if (!raw) return '未登记'
    const entries = JSON.parse(raw) as Record<string, { 明细表名?: string; 去重策略?: string }[]>
    const hit = (entries.dwd ?? []).find((row) => row.明细表名 === dwdTable)
    return hit?.去重策略 || '未登记'
  } catch {
    return '未登记'
  }
}

export function driftSummary(packId: string): { matrix?: MatrixRecord; drifted: ReturnType<typeof driftedKeys> } {
  const matrix = getMatrix(packId)
  return { matrix, drifted: matrix ? driftedKeys(matrix) : [] }
}
