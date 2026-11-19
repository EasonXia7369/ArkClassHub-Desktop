const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ark', {
  desktop: true,
  /** 大板自适应缩放开关：由壳主进程在窗口 resize 时驱动渲染层缩放（前端只报 on/off） */
  setBoardScale: (on) => ipcRenderer.invoke('ark:board-scale', !!on),
  /** 弹原生「另存为」对话框并写入文件;取消返回 null */
  saveFile: (filename, data) => ipcRenderer.invoke('ark:save-file', filename, data),
  /** 当前桌面设置状态 { fullscreen, alwaysOnTop, autostart } */
  windowState: () => ipcRenderer.invoke('ark:state'),
  setFullscreen: (on) => ipcRenderer.invoke('ark:fullscreen', on),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('ark:always-on-top', on),
  setAutostart: (on) => ipcRenderer.invoke('ark:autostart', on),
  /** 前端热同步状态 { source, hash, lastCheck, lastSwap, lastError, disabled, checking }（1.0.2+ 壳提供） */
  webSyncState: () => ipcRenderer.invoke('ark:web-sync-state'),
  /** 手动触发一次前端同步检查;有新版会自动刷新窗口（1.0.2+ 壳提供） */
  checkWebSync: () => ipcRenderer.invoke('ark:web-sync-check'),
  /** 桌面壳版本号（1.0.3+ 壳提供） */
  version: () => ipcRenderer.invoke('ark:version'),
})
