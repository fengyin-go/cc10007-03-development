/**
 * 键守恒工作台示例数据：
 * - 两个采样包，覆盖业务键空域、事件时间/版本号空域、跨分区日期分流；
 * - 两套字段定义版本，v2 调整指纹字段，用于演示换版后旧矩阵失效与漂移键识别。
 */
import { buildShards, packDigest } from './engine'
import type { FieldSchema, SamplePack, SampleRow, WorkbenchState } from './types'

const NOW = '2026-11-13 09:00:00'

export const SEED_SCHEMAS: FieldSchema[] = [
  {
    version: 'field-v1',
    fingerprintFields: ['amount', 'channel'],
    note: '首版：行指纹由金额与渠道构成',
    createdAt: '2026-10-20 10:00:00',
  },
  {
    version: 'field-v2',
    fingerprintFields: ['amount', 'channel', 'status'],
    note: '换版：指纹补入单据状态字段，旧矩阵需失效重算',
    createdAt: '2026-11-10 10:00:00',
  },
]

function pack(
  id: string,
  name: string,
  dwdTable: string,
  rows: Array<Omit<SampleRow, 'rowId'> & { rowId?: number }>,
  shardCount: number,
  note: string,
): SamplePack {
  const fullRows: SampleRow[] = rows.map((row, index) => ({ ...row, rowId: row.rowId ?? index + 1 }))
  const shards = buildShards(fullRows, shardCount)
  return {
    id,
    name,
    dwdTable,
    businessKeyField: 'order_no',
    shardCount,
    rows: fullRows,
    shards,
    fieldSchemaVersion: 'field-v1',
    contentDigest: packDigest(fullRows, 'field-v1'),
    createdAt: NOW,
    note,
  }
}

const PACK_ONE = pack(
  'PACK-TRADE-01',
  '交易明细采样包 2026-11-上旬',
  'dwd_trade_order_detail',
  [
    // 键 K-1001：三版本横跨两个分区日期，留首条/留末条胜出不同行
    { businessKey: 'K-1001', eventTime: '2026-11-01 08:10:00', version: '1', partitionDate: '2026-11-01', payload: { amount: '100.00', channel: 'APP', status: '已创建' } },
    { businessKey: 'K-1001', eventTime: '2026-11-02 09:30:00', version: '2', partitionDate: '2026-11-02', payload: { amount: '100.00', channel: 'APP', status: '已支付' } },
    { businessKey: 'K-1001', eventTime: '2026-11-03 14:05:00', version: '3', partitionDate: '2026-11-03', payload: { amount: '99.50', channel: 'APP', status: '已完成' } },
    // 键 K-1002：两条同分区，两套策略胜出同一行
    { businessKey: 'K-1002', eventTime: '2026-11-04 10:00:00', version: '1', partitionDate: '2026-11-04', payload: { amount: '58.00', channel: 'WEB', status: '已创建' } },
    { businessKey: 'K-1002', eventTime: '2026-11-04 11:20:00', version: '2', partitionDate: '2026-11-04', payload: { amount: '58.00', channel: 'WEB', status: '已支付' } },
    // 键 K-1003：事件时间空域（留首条命中），版本号正常（留末条不受影响）
    { businessKey: 'K-1003', eventTime: '', version: '1', partitionDate: '2026-11-05', payload: { amount: '210.00', channel: 'POS', status: '已创建' } },
    { businessKey: 'K-1003', eventTime: '2026-11-06 16:00:00', version: '2', partitionDate: '2026-11-06', payload: { amount: '210.00', channel: 'POS', status: '已支付' } },
    // 键 K-1004：版本号空域（留末条命中），事件时间正常
    { businessKey: 'K-1004', eventTime: '2026-11-07 09:00:00', version: '1', partitionDate: '2026-11-07', payload: { amount: '76.40', channel: 'APP', status: '已创建' } },
    { businessKey: 'K-1004', eventTime: '2026-11-08 09:00:00', version: '', partitionDate: '2026-11-08', payload: { amount: '76.40', channel: 'APP', status: '处理中' } },
    // 业务键空域：两套策略都不参与留一
    { businessKey: ' ', eventTime: '2026-11-08 15:30:00', version: '1', partitionDate: '2026-11-08', payload: { amount: '12.00', channel: 'UNKNOWN', status: '未知' } },
    // 键 K-1005：跨分区但内容稳定，两套策略胜出同一行
    { businessKey: 'K-1005', eventTime: '2026-11-09 08:00:00', version: '1', partitionDate: '2026-11-09', payload: { amount: '330.00', channel: 'WEB', status: '已创建' } },
    { businessKey: 'K-1005', eventTime: '2026-11-10 20:00:00', version: '2', partitionDate: '2026-11-10', payload: { amount: '330.00', channel: 'WEB', status: '已完成' } },
  ],
  4,
  '常规交易采样，含空域与跨分区场景',
)

const PACK_TWO = pack(
  'PACK-REFUND-02',
  '退款明细采样包 2026-11-中旬',
  'dwd_trade_refund_detail',
  [
    { businessKey: 'R-2001', eventTime: '2026-11-11 10:00:00', version: '1', partitionDate: '2026-11-11', payload: { amount: '45.00', channel: 'APP', status: '退款申请' } },
    { businessKey: 'R-2001', eventTime: '2026-11-12 10:00:00', version: '2', partitionDate: '2026-11-12', payload: { amount: '45.00', channel: 'APP', status: '退款成功' } },
    { businessKey: 'R-2002', eventTime: '2026-11-12 13:00:00', version: '1', partitionDate: '2026-11-12', payload: { amount: '88.80', channel: 'WEB', status: '退款申请' } },
    { businessKey: 'R-2002', eventTime: '', version: '2', partitionDate: '2026-11-13', payload: { amount: '88.80', channel: 'WEB', status: '退款成功' } },
    { businessKey: 'R-2003', eventTime: '2026-11-13 09:00:00', version: '', partitionDate: '2026-11-13', payload: { amount: '9.90', channel: 'POS', status: '退款申请' } },
    { businessKey: 'R-2003', eventTime: '2026-11-13 11:00:00', version: '2', partitionDate: '2026-11-13', payload: { amount: '9.90', channel: 'POS', status: '退款成功' } },
    { businessKey: '', eventTime: '2026-11-13 12:00:00', version: '1', partitionDate: '2026-11-13', payload: { amount: '1.00', channel: 'UNKNOWN', status: '未知' } },
    { businessKey: 'R-2004', eventTime: '2026-11-14 08:30:00', version: '1', partitionDate: '2026-11-14', payload: { amount: '199.00', channel: 'APP', status: '退款申请' } },
  ],
  3,
  '退款域采样，用于复核第二张明细表的去重口径',
)

export function buildWorkbenchSeed(): WorkbenchState {
  return {
    packs: [PACK_ONE, PACK_TWO],
    schemas: SEED_SCHEMAS,
    activeSchemaVersion: 'field-v1',
    jobs: [],
    matrices: [],
    calibers: [],
    seals: [],
  }
}
