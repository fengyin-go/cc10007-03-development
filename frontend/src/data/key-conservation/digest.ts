/**
 * 内容摘要工具：纯前端没有后端哈希服务，这里用 FNV-1a 32 位得到稳定短摘要。
 * 同输入永远同摘要——采样包/策略/结果据此做幂等重放判定。
 */

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 对任意可序列化内容求摘要，键排序保证对象字段顺序不影响结果。 */
export function contentDigest(value: unknown): string {
  return fnv1a(stableStringify(value))
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
