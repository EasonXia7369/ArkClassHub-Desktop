const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const webSync = require('./web-sync')

const DEV_URL = process.env.ARK_DEV_URL || 'http://localhost:5173'

// 测试钩子：隔离 userData，避免与已安装实例争单实例锁（不影响正式运行）
if (process.env.ARK_TEST_USERDATA) app.setPath('userData', process.env.ARK_TEST_USERDATA)

// 前端热同步：跟随网页版（ach.macrostar.top）自动更新内置前端
webSync.init({
  liveDir: path.join(app.getPath('userData'), 'web-dist-live'),
  stagingDir: path.join(app.getPath('userData'), 'web-dist-staging'),
  bundledDir: path.join(__dirname, 'web-dist'),
  origin: 'https://ach.macrostar.top',
  disabledFile: path.join(app.getPath('userData'), 'web-sync-off'),
  logFile: path.join(app.getPath('userData'), 'web-sync.log'),
})

// 自定义协议须在 app ready 前注册为 standard + secure(支持 history 路由与安全上下文)
protocol.registerSchemesAsPrivileged([
  { scheme: 'ark', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: '方舟班级中心',
    backgroundColor: '#f2f5fa',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
  })
  if (app.isPackaged) {
    win.loadURL('ark://app/index.html')
  } else {
    // 开发:加载 Web 工程的 vite dev server(先另行启动 npm run dev)
    win.loadURL(DEV_URL)
  }
}

// 生产:自定义协议托管前端 dist(热同步的 live 目录优先,内置 web-dist 兜底),
// 未命中且无扩展名的路径回退 index.html(history 路由可用),带扩展名的缺失文件返回 404
function registerAppProtocol() {
  protocol.handle('ark', (request) => {
    const { pathname } = new URL(request.url)
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    const base = webSync.activeBase()
    let file = path.join(base, rel || 'index.html')
    if (!file.startsWith(base)) file = path.join(base, 'index.html')
    let exists = false
    try {
      exists = fs.existsSync(file) && fs.statSync(file).isFile()
    } catch {
      exists = false
    }
    if (!exists) {
      // SPA 回退:无扩展名的路径(路由)→ index.html;带扩展名的缺失资源 → 404
      if (path.extname(rel)) {
        return new Response('not found', { status: 404 })
      }
      file = path.join(base, 'index.html')
    }
    return net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true }).then(
      (resp) => {
        // 入口 HTML 永远不走缓存,保证热同步替换后 reload 立即生效
        if (file.endsWith('index.html')) {
          return new Response(resp.body, {
            status: resp.status,
            headers: { ...Object.fromEntries(resp.headers), 'Cache-Control': 'no-cache' },
          })
        }
        return resp
      },
    )
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 单实例:再次启动时聚焦已有窗口
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    if (app.isPackaged) registerAppProtocol()
    createWindow()
    scheduleWebSync()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

/* ---------- 前端热同步调度:启动 10 秒后首查,之后每 30 分钟 ---------- */
function scheduleWebSync() {
  if (!app.isPackaged) return
  const run = async () => {
    try {
      const r = await webSync.checkAndSync()
      if (r.updated && win) win.webContents.reload()
    } catch {
      /* 同步失败静默,旧版继续可用 */
    }
  }
  setTimeout(run, 10_000)
  setInterval(run, 30 * 60 * 1000)
}

/* IPC:桌面设置 + 文件保存 + 前端热同步状态(前端经 preload 的 window.ark 调用) */
ipcMain.handle('ark:state', () => ({
  fullscreen: win ? win.isFullscreen() : false,
  alwaysOnTop: win ? win.isAlwaysOnTop() : false,
  autostart: app.getLoginItemSettings().openAtLogin,
}))
ipcMain.handle('ark:version', () => app.getVersion())
ipcMain.handle('ark:fullscreen', (_e, on) => {
  if (win) win.setFullScreen(!!on)
})
ipcMain.handle('ark:always-on-top', (_e, on) => {
  if (win) win.setAlwaysOnTop(!!on)
})
ipcMain.handle('ark:autostart', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
  return app.getLoginItemSettings().openAtLogin
})
ipcMain.handle('ark:save-file', async (_e, filename, data) => {
  const res = await dialog.showSaveDialog(win, { defaultPath: filename })
  if (res.canceled || !res.filePath) return null
  await fs.promises.writeFile(res.filePath, Buffer.from(data))
  return res.filePath
})
ipcMain.handle('ark:web-sync-state', () => webSync.stateSnapshot())
ipcMain.handle('ark:web-sync-check', async () => {
  const r = await webSync.checkAndSync()
  if (r.updated && win) win.webContents.reload()
  return r
})

app.on('window-all-closed', () => app.quit())
