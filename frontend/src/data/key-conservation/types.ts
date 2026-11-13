/**
 * 键守恒工作台领域类型。
 *
 * 工作台围绕「采样包 → 候选策略 → 键守恒矩阵 → 确认口径 → 封存」这条主线工作，
 * 采样包、策略、结果都带内容摘要（contentDigest），同一摘要重放不增加席位。
 */

/** 两套候选去重策略：同一业务键各自独立留一条，指纹分桶存储，禁止互相串写。 */
export type StrategyKind = 'FIRST_EVENT' | 'LAST_VERSION'

export const STRATEGY_LABEL: Record<StrategyKind, string> = {
  FIRST_EVENT: '按事件时间留首条',
  LAST_VERSION: '按版本号留末条',
}

/** 采样行：业务键、事件时间、版本号、分区日期是两套策略共同依赖的固定列。 */
export type SampleRow = {
  /** 采样包内的行序号，作为稳定的行标识。 */
  rowId: number
  /** 业务键；为空时进入空域桶，不参与正常留一。 */
  businessKey: string
  /** 事件时间（ISO 日期时间字符串），留首条策略依赖；空值记为空域命中。 */
  eventTime: string
  /** 版本号（单调递增的整数语义，用字符串存储以便留末条比较）；空值记为空域命中。 */
  version: string
  /** 该行落盘的分区日期（yyyy-MM-dd），用于发现跨分区日期分流。 */
  partitionDate: string
  /** 业务属性负载，参与行指纹与漂移判定。 */
  payload: Record<string, string>
}

/** 字段定义版本：决定行指纹由哪些列构成，换版会让旧矩阵失效。 */
export type FieldSchema = {
  version: string
  /** 指纹纳入的负载字段名集合，有序（顺序影响摘要）。 */
  fingerprintFields: string[]
  note: string
  createdAt: string
}

/** 采样分片：按行指纹哈希稳定切分，中断重放时只补未计算分片。 */
export type SampleShard = {
  shardNo: number
  rowIds: number[]
  /** 分片自身内容摘要；同一摘要的分片结果直接复用，不占新席位。 */
  digest: string
}

export type SamplePack = {
  id: string
  name: string
  /** 关联的明细表（明细层建模为主对象）。 */
  dwdTable: string
  businessKeyField: string
  shardCount: number
  rows: SampleRow[]
  shards: SampleShard[]
  fieldSchemaVersion: string
  /** 整包内容摘要：行内容不变则摘要不变，重放不增加席位。 */
  contentDigest: string
  createdAt: string
  note: string
}

/** 被剔除行的指纹记录：挂在具体策略下，两套策略各自独立存储。 */
export type DroppedFingerprint = {
  rowId: number
  businessKey: string
  fingerprint: string
  partitionDate: string
  /** 被哪一行顶替（留一胜出的行）。 */
  winnerRowId: number
  reason: string
}

/** 单个分片在单套策略下的计算产物，键含 strategyId，天然隔离两套指纹。 */
export type ShardResult = {
  shardNo: number
  strategyId: StrategyKind
  /** 输入分片摘要，重放时比对：摘要一致就跳过，不重算不增席位。 */
  sourceDigest: string
  /** 每个业务键胜出的行 rowId。 */
  winnerRowIds: number[]
  dropped: DroppedFingerprint[]
  computedAt: string
}

export type JobState = {
  packId: string
  strategyId: StrategyKind
  /** 计算时采用的字段定义版本；与当前版本不一致即判定矩阵失效。 */
  schemaVersion: string
  /** 已完成分片号集合；中断恢复只补齐这里缺失的分片。 */
  doneShards: number[]
  shardResults: ShardResult[]
  status: '待计算' | '计算中' | '已中断' | '已完成'
  startedAt: string
  updatedAt: string
}

/** 单个业务键在一套策略下的守恒台账。 */
export type KeyMatrixRow = {
  businessKey: string
  inputCount: number
  firstEventKeptRowId: number | null
  lastVersionKeptRowId: number | null
  /** 两套策略胜出同一行才算键口径一致。 */
  sameWinner: boolean
  firstEventPartitions: string[]
  lastVersionPartitions: string[]
  /** 同一业务键的输入行横跨多个分区日期。 */
  splitAcrossPartitions: boolean
  /** 事件时间/版本号空域的行号（按策略分别记录）。 */
  firstEventNullHits: number[]
  lastVersionNullHits: number[]
  drift: boolean
  driftDetail: string
}

export type MatrixRecord = {
  packId: string
  strategyResults: Record<StrategyKind, StrategyOutput>
  keyRows: KeyMatrixRow[]
  /** 构建矩阵时采用的字段定义版本。 */
  schemaVersion: string
  /** 矩阵内容摘要：任一键的留一结果变化都会改变摘要。 */
  contentDigest: string
  builtAt: string
  /** 当前字段定义版本与构建时不一致时置为失效。 */
  invalid: boolean
  invalidReason: string
}

/** 一套策略合并所有分片后的完整输出。 */
export type StrategyOutput = {
  strategyId: StrategyKind
  keptRowIds: number[]
  dropped: DroppedFingerprint[]
  nullHits: { rowId: number; businessKey: string; kind: '业务键空域' | '事件时间空域' | '版本号空域' }[]
  splitKeys: { businessKey: string; partitions: string[] }[]
  /** 输出集合的内容摘要。 */
  contentDigest: string
}

/** 导出给汇总层的候选口径；只有 confirmed 的集合允许进入 DWS。 */
export type Caliber = {
  id: string
  packId: string
  packName: string
  dwdTable: string
  strategyId: StrategyKind
  /** 确认集合的行指纹列表（封存后不可变）。 */
  keptFingerprints: string[]
  keptRowIds: number[]
  matrixDigest: string
  schemaVersion: string
  contentDigest: string
  status: '候选' | '已确认'
  /** 被哪张汇总表引用。 */
  referencedByDws: string[]
  createdAt: string
  confirmedAt: string | null
}

/** 封存三件套：manifest、pack_bundle、bookmark 共用同一封存号。 */
export type SealArchive = {
  sealId: string
  packId: string
  packDigest: string
  caliberIds: string[]
  manifest: {
    sealId: string
    createdAt: string
    packId: string
    packDigest: string
    schemaVersion: string
    matrices: { strategyId: StrategyKind; outputDigest: string; keptCount: number; droppedCount: number }[]
    calibers: { caliberId: string; strategyId: StrategyKind; contentDigest: string; status: string }[]
    /** 封存清单自身摘要。 */
    manifestDigest: string
  }
  packBundle: {
    sealId: string
    packDigest: string
    /** 打包件内含采样包快照、分片摘要与两套策略输出，整体摘要。 */
    bundleDigest: string
    packSnapshot: SamplePack
    strategyOutputs: Record<StrategyKind, StrategyOutput>
  }
  bookmark: {
    sealId: string
    label: string
    dwdTable: string
    locator: { packId: string; caliberIds: string[]; schemaVersion: string }
    createdAt: string
  }
  createdAt: string
}

export type WorkbenchState = {
  packs: SamplePack[]
  schemas: FieldSchema[]
  activeSchemaVersion: string
  jobs: JobState[]
  matrices: MatrixRecord[]
  calibers: Caliber[]
  seals: SealArchive[]
}
