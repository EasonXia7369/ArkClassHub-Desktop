/**
 * 前端热同步：让桌面端自动跟随网页版（ach.macrostar.top）的前端更新。
 *
 * 机制：
 *  1. 对比线上 index.html 与本地（live 目录或内置 web-dist）的入口 JS 文件名（内容哈希）；
 *  2. 不同则拉取线上 sw.js，解析 workbox 预缓存清单（含全部 js/css/图标）；
 *  3. 额外解析 CSS 里的 url() 引用（MiSans 分片字体等运行时资源，预缓存清单不含）；
 *  4. 全量下载到暂存目录，校验入口完整性后原子替换 live 目录；
 *  5. 主进程窗口 reload 即用新前端。任何一步失败静默放弃，旧版继续可用。
 *
 * 运维逃生：在 userData 目录新建 `web-sync-off` 空文件即可禁用同步（回退内置版本）。
 * 本模块不依赖 electron，可在纯 Node 中测试。
 */
const path = require('path')
const fs = require('fs')

const FILE_TIMEOUT_MS = 20_000
const DOWNLOAD_CONCURRENCY = 10

let cfg = null
let syncing = false
const state = {
  lastCheck: null,
  lastError: null,
  lastSwap: null,
}

/** 初始化路径配置（main.js 在 app.getPath 可用后调用） */
function init({ liveDir, stagingDir, bundledDir, origin, disabledFile, logFile }) {
  cfg = { liveDir, stagingDir, bundledDir, origin, disabledFile, logFile }
}

/** 同步日志（userData/web-sync.log，保留最近 40 行，生产排障用） */
function appendLog(line) {
  if (!cfg || !cfg.logFile) return
  try {
    let prev = ''
    try {
      prev = fs.readFileSync(cfg.logFile, 'utf8')
      const lines = prev.split('\n')
      if (lines.length > 40) prev = lines.slice(-40).join('\n')
    } catch {
      /* 首次无日志 */
    }
    fs.writeFileSync(cfg.logFile, prev + line + '\n')
  } catch {
    /* 日志失败不影响同步 */
  }
}

/** 运维逃生开关文件是否存在 */
function syncDisabled() {
  return !!(cfg && cfg.disabledFile && fs.existsSync(cfg.disabledFile))
}

/** 当前生效的前端目录：live（同步过且未禁用）优先，否则内置 web-dist */
function activeBase() {
  if (cfg && !syncDisabled()) {
    try {
      if (fs.existsSync(path.join(cfg.liveDir, 'index.html'))) return cfg.liveDir
    } catch {
      /* 探测失败回退内置 */
    }
  }
  return cfg ? cfg.bundledDir : path.join(__dirname, 'web-dist')
}

/** 目录内 index.html 引用的入口 JS 文件名（内容哈希，即版本指纹） */
function indexHashOf(dir) {
  try {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    return (html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1] || null
  } catch {
    return null
  }
}

async function fetchWithTimeout(url) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), FILE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return res
  } finally {
    clearTimeout(t)
  }
}

/**
 * 解析 sw.js 里的 workbox 预缓存清单。
 * 生成产物是非严格 JSON（{url:"..",revision:..}），先归一化键名再 parse。
 */
function parseManifest(swText) {
  const token = 'precacheAndRoute(['
  const start = swText.indexOf(token)
  if (start < 0) throw new Error('sw.js 中未找到预缓存清单')
  const bodyStart = start + token.length - 1 // 指向 "["
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < swText.length; i++) {
    const ch = swText[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error('预缓存清单不完整')
  const normalized = swText
    .slice(bodyStart, end)
    .replace(/\{url:/g, '{"url":')
    .replace(/,revision:/g, ',"revision":')
  const arr = JSON.parse(normalized)
  if (!Array.isArray(arr) || !arr.length) throw new Error('预缓存清单为空')
  return arr
}

/** 提取 CSS 中 url() 引用的运行时资源（字体分片等），返回相对站点根的路径列表 */
function extraAssetsFromCss(cssText, cssUrl) {
  const out = new Set()
  for (const m of cssText.matchAll(/url\((['"]?)([^)'\"]+)\1\)/g)) {
    let u = m[2]
    if (!u || u.startsWith('data:') || u.startsWith('http') || u.startsWith('//')) continue
    u = u.split('?')[0].split('#')[0]
    if (!/\.(woff2?|png|jpe?g|svg|webp|gif|ico)$/i.test(u)) continue
    const rel = u.startsWith('/') ? u.slice(1) : path.posix.join(path.posix.dirname(cssUrl), u)
    out.add(rel)
  }
  return [...out]
}

/** 检查并同步：返回 { updated, hash?, error?, skipped?, reason? } */
async function checkAndSync() {
  if (!cfg) throw new Error('web-sync 未初始化')
  if (syncing) return { updated: false, skipped: true, reason: 'busy' }
  if (syncDisabled()) return { updated: false, skipped: true, reason: 'disabled' }
  syncing = true
  try {
    state.lastCheck = new Date().toISOString()
    state.lastError = null

    const localHash = indexHashOf(activeBase())
    const remoteHtml = await (await fetchWithTimeout(`${cfg.origin}/?t=${Date.now()}`)).text()
    const remoteHash = (remoteHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1]
    if (!remoteHash) throw new Error('线上页面未解析到入口资源')
    if (remoteHash === localHash) {
      appendLog(`${state.lastCheck} LATEST ${remoteHash}`)
      return { updated: false, hash: remoteHash, reason: 'latest' }
    }

    // 拉清单：预缓存（js/css/图标/manifest）+ CSS 内引用的运行时资源（字体分片）
    const swText = await (await fetchWithTimeout(`${cfg.origin}/sw.js?t=${Date.now()}`)).text()
    const entries = parseManifest(swText)

    fs.rmSync(cfg.stagingDir, { recursive: true, force: true })
    fs.mkdirSync(cfg.stagingDir, { recursive: true })
    const downloaded = new Set()
    const cssTexts = []
    const grab = async (relUrl, bust) => {
      if (downloaded.has(relUrl)) return
      downloaded.add(relUrl)
      const dest = path.join(cfg.stagingDir, relUrl)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const res = await fetchWithTimeout(`${cfg.origin}/${encodeURI(relUrl)}${bust}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error(`空文件 ${relUrl}`)
      fs.writeFileSync(dest, buf)
      if (relUrl.endsWith('.css')) cssTexts.push({ url: relUrl, text: buf.toString('utf8') })
    }
    const pool = async (items, worker) => {
      let i = 0
      const runners = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, async () => {
        while (i < items.length) await worker(items[i++])
      })
      await Promise.all(runners)
    }

    await pool(entries, ({ url, revision }) => grab(url, revision ? `?v=${revision}` : ''))
    const extras = [...new Set(cssTexts.flatMap(({ url, text }) => extraAssetsFromCss(text, url)))]
    await pool(extras, (rel) => grab(rel, ''))

    // 校验：入口 HTML 引用远程新入口 + 入口 JS 已下载
    const stagedIndex = fs.readFileSync(path.join(cfg.stagingDir, 'index.html'), 'utf8')
    if (!stagedIndex.includes(`assets/${remoteHash}`)) throw new Error('暂存 index.html 校验失败')
    if (!fs.existsSync(path.join(cfg.stagingDir, 'assets', remoteHash))) {
      throw new Error('暂存目录缺少入口 JS')
    }

    // 原子替换 live（rm 与 rename 之间的瞬间由回退逻辑兜底到内置目录）
    fs.rmSync(cfg.liveDir, { recursive: true, force: true })
    fs.renameSync(cfg.stagingDir, cfg.liveDir)
    state.lastSwap = state.lastCheck
    appendLog(`${state.lastCheck} SWAP → ${remoteHash} (${downloaded.size} 文件)`)
    return { updated: true, hash: remoteHash }
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`
    appendLog(`${new Date().toISOString()} ERROR ${e.message}`)
    return { updated: false, error: e.message }
  } finally {
    syncing = false
  }
}

/** 当前同步状态（设置面板展示用） */
function stateSnapshot() {
  const base = activeBase()
  return {
    source: cfg && base === cfg.liveDir ? 'live' : 'bundled',
    hash: indexHashOf(base),
    lastCheck: state.lastCheck,
    lastSwap: state.lastSwap,
    lastError: state.lastError,
    disabled: syncDisabled(),
    checking: syncing,
  }
}

module.exports = { init, activeBase, checkAndSync, stateSnapshot, parseManifest, extraAssetsFromCss }
