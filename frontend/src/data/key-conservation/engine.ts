/**
 * 键守恒引擎：纯函数，不碰 localStorage，页面与本地服务都只调这里。
 *
 * 两套策略（FIRST_EVENT / LAST_VERSION）从入参到产物完全独立：
 * 分片结果 ShardResult 自带 strategyId，剔除指纹分桶存放，杜绝互相串写。
 */
import { contentDigest } from './digest'
import type {
  DroppedFingerprint,
  FieldSchema,
  JobState,
  KeyMatrixRow,
  MatrixRecord,
  SamplePack,
  SampleRow,
  SampleShard,
  ShardResult,
  StrategyKind,
  StrategyOutput,
} from './types'

export const BOTH_STRATEGIES: StrategyKind[] = ['FIRST_EVENT', 'LAST_VERSION']

/** 行指纹：业务键 + 分区日期 + 指纹字段负载，字段定义换版会改变指纹。 */
export function rowFingerprint(row: SampleRow, schema: FieldSchema): string {
  const picked = schema.fingerprintFields.map((field) => [field, row.payload[field] ?? ''])
  return contentDigest({
    businessKey: row.businessKey,
    partitionDate: row.partitionDate,
    fields: picked,
  })
}

/** 稳定分片：按行号哈希取模，同一采样包每次切出的分片完全一致。 */
export function buildShards(rows: SampleRow[], shardCount: number): SampleShard[] {
  const shards: SampleShard[] = Array.from({ length: shardCount }, (_, index) => ({
    shardNo: index,
    rowIds: [],
    digest: '',
  }))
  for (const row of rows) {
    const target = Number(BigInt('0x' + contentDigest(`row:${row.rowId}`)) % BigInt(shardCount))
    shards[target].rowIds.push(row.rowId)
  }
  for (const shard of shards) {
    shard.rowIds.sort((a, b) => a - b)
    shard.digest = contentDigest({ shardNo: shard.shardNo, rowIds: shard.rowIds })
  }
  return shards
}

export function packDigest(rows: SampleRow[], schemaVersion: string): string {
  return contentDigest({ schemaVersion, rows })
}

function compareEventTime(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareVersion(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return na === nb ? 0 : na < nb ? -1 : 1
  }
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * 计算单个分片在单套策略下的留一结果。
 * 每个策略独立调用、独立返回，剔除指纹只写入本策略的 ShardResult。
 */
export function computeShard(
  pack: SamplePack,
  schema: FieldSchema,
  shard: SampleShard,
  strategyId: StrategyKind,
  now: string,
): ShardResult {
  const rows = shard.rowIds
    .map((rowId) => pack.rows.find((row) => row.rowId === rowId))
    .filter((row): row is SampleRow => Boolean(row))

  const groups = new Map<string, SampleRow[]>()
  const dropped: DroppedFingerprint[] = []
  const nullHits: StrategyOutput['nullHits'] = []

  for (const row of rows) {
    if (row.businessKey.trim() === '') {
      nullHits.push({ rowId: row.rowId, businessKey: '(空域)', kind: '业务键空域' })
      continue
    }
    if (strategyId === 'FIRST_EVENT' && row.eventTime.trim() === '') {
      nullHits.push({ rowId: row.rowId, businessKey: row.businessKey, kind: '事件时间空域' })
      continue
    }
    if (strategyId === 'LAST_VERSION' && row.version.trim() === '') {
      nullHits.push({ rowId: row.rowId, businessKey: row.businessKey, kind: '版本号空域' })
      continue
    }
    const list = groups.get(row.businessKey) ?? []
    list.push(row)
    groups.set(row.businessKey, list)
  }

  const winnerRowIds: number[] = []
  for (const [businessKey, list] of groups) {
    const sorted = [...list].sort((a, b) => {
      const primary =
        strategyId === 'FIRST_EVENT'
          ? compareEventTime(a.eventTime, b.eventTime)
          : compareVersion(a.version, b.version)
      if (primary !== 0) return primary
      // 平局时留首条取小行号、留末条取大行号，保证结果确定且可复算。
      return strategyId === 'FIRST_EVENT' ? a.rowId - b.rowId : b.rowId - a.rowId
    })
    const winner = strategyId === 'FIRST_EVENT' ? sorted[0] : sorted[sorted.length - 1]
    winnerRowIds.push(winner.rowId)
    for (const loser of list) {
      if (loser.rowId === winner.rowId) continue
      dropped.push({
        rowId: loser.rowId,
        businessKey,
        fingerprint: rowFingerprint(loser, schema),
        partitionDate: loser.partitionDate,
        winnerRowId: winner.rowId,
        reason:
          strategyId === 'FIRST_EVENT'
            ? `事件时间 ${loser.eventTime} 晚于首条 ${winner.eventTime}`
            : `版本号 ${loser.version} 早于末条 ${winner.version}`,
      })
    }
  }

  winnerRowIds.sort((a, b) => a - b)
  dropped.sort((a, b) => a.rowId - b.rowId)
  return { shardNo: shard.shardNo, strategyId, sourceDigest: shard.digest, winnerRowIds, dropped, computedAt: now }
}

/** 合并分片结果为策略级输出：跨分片同键还要再做一次全局留一。 */
export function mergeShardResults(
  pack: SamplePack,
  schema: FieldSchema,
  shardResults: ShardResult[],
  strategyId: StrategyKind,
): StrategyOutput {
  const rowById = new Map(pack.rows.map((row) => [row.rowId, row]))
  const candidateIds = shardResults.flatMap((result) => result.winnerRowIds)
  const groups = new Map<string, number[]>()
  for (const rowId of candidateIds) {
    const row = rowById.get(rowId)
    if (!row) continue
    const list = groups.get(row.businessKey) ?? []
    list.push(rowId)
    groups.set(row.businessKey, list)
  }

  const keptRowIds: number[] = []
  const dropped: DroppedFingerprint[] = []
  for (const [businessKey, ids] of groups) {
    const sorted = ids
      .map((rowId) => rowById.get(rowId))
      .filter((row): row is SampleRow => Boolean(row))
      .sort((a, b) => {
        const primary =
          strategyId === 'FIRST_EVENT'
            ? compareEventTime(a.eventTime, b.eventTime)
            : compareVersion(a.version, b.version)
        if (primary !== 0) return primary
        return strategyId === 'FIRST_EVENT' ? a.rowId - b.rowId : b.rowId - a.rowId
      })
    const winner = strategyId === 'FIRST_EVENT' ? sorted[0] : sorted[sorted.length - 1]
    keptRowIds.push(winner.rowId)
    for (const loser of sorted) {
      if (loser.rowId === winner.rowId) continue
      dropped.push({
        rowId: loser.rowId,
        businessKey,
        fingerprint: rowFingerprint(loser, schema),
        partitionDate: loser.partitionDate,
        winnerRowId: winner.rowId,
        reason: `跨分片合并：${strategyId === 'FIRST_EVENT' ? '事件时间非最早' : '版本号非最大'}`,
      })
    }
  }

  // 分片级剔除指纹原样并入（两套策略各自的桶，不交叉读取）。
  for (const result of shardResults) {
    for (const item of result.dropped) dropped.push(item)
  }
  dropped.sort((a, b) => a.rowId - b.rowId)
  keptRowIds.sort((a, b) => a - b)

  const nullHits = collectNullHits(pack, strategyId)
  const splitKeys = collectSplitKeys(pack)

  return {
    strategyId,
    keptRowIds,
    dropped,
    nullHits,
    splitKeys,
    contentDigest: contentDigest({ strategyId, keptRowIds, dropped, nullHits, splitKeys }),
  }
}

export function collectNullHits(pack: SamplePack, strategyId: StrategyKind): StrategyOutput['nullHits'] {
  const hits: StrategyOutput['nullHits'] = []
  for (const row of pack.rows) {
    if (row.businessKey.trim() === '') {
      hits.push({ rowId: row.rowId, businessKey: '(空域)', kind: '业务键空域' })
      continue
    }
    if (strategyId === 'FIRST_EVENT' && row.eventTime.trim() === '') {
      hits.push({ rowId: row.rowId, businessKey: row.businessKey, kind: '事件时间空域' })
    }
    if (strategyId === 'LAST_VERSION' && row.version.trim() === '') {
      hits.push({ rowId: row.rowId, businessKey: row.businessKey, kind: '版本号空域' })
    }
  }
  return hits.sort((a, b) => a.rowId - b.rowId)
}

export function collectSplitKeys(pack: SamplePack): { businessKey: string; partitions: string[] }[] {
  const map = new Map<string, Set<string>>()
  for (const row of pack.rows) {
    if (row.businessKey.trim() === '') continue
    const set = map.get(row.businessKey) ?? new Set<string>()
    set.add(row.partitionDate)
    map.set(row.businessKey, set)
  }
  return [...map.entries()]
    .filter(([, partitions]) => partitions.size > 1)
    .map(([businessKey, partitions]) => ({ businessKey, partitions: [...partitions].sort() }))
    .sort((a, b) => a.businessKey.localeCompare(b.businessKey))
}

/** 键守恒矩阵：逐键对照两套策略的留一结果，并按新字段定义检测漂移。 */
export function buildMatrix(
  pack: SamplePack,
  outputs: Record<StrategyKind, StrategyOutput>,
  builtWithSchema: FieldSchema,
  currentSchema: FieldSchema,
  now: string,
): MatrixRecord {
  const rowById = new Map(pack.rows.map((row) => [row.rowId, row]))
  const keys = [...new Set(pack.rows.map((row) => row.businessKey).filter((key) => key.trim() !== ''))].sort()

  const winnerOf = (strategyId: StrategyKind, businessKey: string): number | null => {
    const id = outputs[strategyId].keptRowIds.find((rowId) => rowById.get(rowId)?.businessKey === businessKey)
    return id ?? null
  }

  const keyRows: KeyMatrixRow[] = keys.map((businessKey) => {
    const inputRows = pack.rows.filter((row) => row.businessKey === businessKey)
    const firstWinner = winnerOf('FIRST_EVENT', businessKey)
    const lastWinner = winnerOf('LAST_VERSION', businessKey)
    const firstPartitions = [...new Set(inputRows.map((row) => row.partitionDate))].sort()
    const lastPartitions = [...new Set(inputRows.map((row) => row.partitionDate))].sort()
    const firstEventNullHits = outputs.FIRST_EVENT.nullHits
      .filter((hit) => hit.businessKey === businessKey)
      .map((hit) => hit.rowId)
    const lastVersionNullHits = outputs.LAST_VERSION.nullHits
      .filter((hit) => hit.businessKey === businessKey)
      .map((hit) => hit.rowId)

    // 漂移：字段定义换版后，胜出行的新指纹与旧指纹不一致。
    let drift = false
    const driftDetails: string[] = []
    if (builtWithSchema.version !== currentSchema.version) {
      for (const winner of [firstWinner, lastWinner]) {
        if (winner === null) continue
        const row = rowById.get(winner)
        if (!row) continue
        const before = rowFingerprint(row, builtWithSchema)
        const after = rowFingerprint(row, currentSchema)
        if (before !== after) {
          drift = true
          driftDetails.push(`行#${winner} 指纹 ${before.slice(0, 8)} → ${after.slice(0, 8)}`)
        }
      }
    }

    return {
      businessKey,
      inputCount: inputRows.length,
      firstEventKeptRowId: firstWinner,
      lastVersionKeptRowId: lastWinner,
      sameWinner: firstWinner !== null && firstWinner === lastWinner,
      firstEventPartitions: firstPartitions,
      lastVersionPartitions: lastPartitions,
      splitAcrossPartitions: firstPartitions.length > 1,
      firstEventNullHits,
      lastVersionNullHits,
      drift,
      driftDetail: driftDetails.join('；'),
    }
  })

  const invalid = builtWithSchema.version !== currentSchema.version
  return {
    packId: pack.id,
    strategyResults: outputs,
    keyRows,
    schemaVersion: builtWithSchema.version,
    contentDigest: contentDigest({ packId: pack.id, schemaVersion: builtWithSchema.version, keyRows }),
    builtAt: now,
    invalid,
    invalidReason: invalid
      ? `字段定义已从 ${builtWithSchema.version} 换版到 ${currentSchema.version}，旧矩阵失效，请按新版本重算`
      : '',
  }
}

/** 漂移键清单：矩阵失效后直接列出受影响的业务键。 */
export function driftedKeys(matrix: MatrixRecord): KeyMatrixRow[] {
  if (!matrix.invalid) return []
  return matrix.keyRows.filter((row) => row.drift)
}

/** 恢复任务时只补齐尚未计算的分片；已完成分片的 sourceDigest 变化则强制重算。 */
export function pendingShards(job: JobState, pack: SamplePack): SampleShard[] {
  const done = new Map(job.shardResults.map((result) => [result.shardNo, result.sourceDigest]))
  return pack.shards.filter((shard) => done.get(shard.shardNo) !== shard.digest)
}

export function isJobComplete(job: JobState, pack: SamplePack): boolean {
  return pack.shards.every((shard) =>
    job.shardResults.some((result) => result.shardNo === shard.shardNo && result.sourceDigest === shard.digest),
  )
}
