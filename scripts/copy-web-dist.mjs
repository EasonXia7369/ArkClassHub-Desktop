import { cpSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '../../ArkClassHub-Web-main/dist')
const dst = path.resolve(here, '../web-dist')

if (!existsSync(src)) {
  console.error('缺少前端构建产物,请先构建 Web 工程:', src)
  process.exit(1)
}
rmSync(dst, { recursive: true, force: true })
cpSync(src, dst, { recursive: true })
console.log('web-dist 已同步:', dst)
