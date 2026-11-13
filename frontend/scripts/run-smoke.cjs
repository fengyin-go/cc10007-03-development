/**
 * 键守恒工作台端到端冒烟脚本：
 * 用 esbuild 把 TS 测试打成 CJS 再用 node 运行（项目本身无测试框架）。
 */
const path = require('node:path')
const esbuild = require('esbuild')

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'kc-smoke.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(__dirname, '.kc-smoke.cjs'),
    alias: { '@': path.resolve(__dirname, '..', 'src') },
  })
  .then(() => {
    require(path.join(__dirname, '.kc-smoke.cjs'))
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
