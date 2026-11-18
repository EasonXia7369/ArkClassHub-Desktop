<div align="center">

# Ark Class Hub · Windows

**方舟班级中心 · Windows 桌面端** —— Electron 壳,前端复用 [ArkClassHub-Web](https://github.com/EasonXia7369/ArkClassHub-Web)

</div>

## 定位

桌面端只是**壳**:完整复用 Web 前端(Vue 3),数据不落地本机,直连
`arkapi.macrostar.top`(打包时注入 `VITE_API_BASE`)。不做本地后端。

```
本目录(package.json + main.js + preload.js)
  ├─ main.js      主进程:窗口/单实例/自定义协议(ark://app 托管 dist + SPA 回退)/IPC
  ├─ preload.js   contextBridge 暴露 window.ark(另存为/窗口控制/开机自启)
  └─ web-dist/    构建时从 ../ArkClassHub-Web-main/dist 同步而来
```

## 环境要求

- Node LTS + npm(本机已装)
- 无需任何原生编译工具链(纯 JS 壳 + 预编译二进制)

## 常用命令

```bash
npm run start        # 开发:electron 加载 Web 工程的 vite dev(:5173,先启动它)
npm run dist         # 发布:构建 Web dist → 同步 web-dist → NSIS 安装包
```

产物在 `release/ArkClassHub-Setup-1.0.0.exe`,NSIS 简中安装界面。

## 桌面专属功能(应用内侧栏底部「桌面」按钮)

- **全屏模式**(F11 同效):大板/一体机投屏用
- **窗口置顶**:始终浮在其他窗口上方
- **开机自启**:写入当前用户注册表 Run 项,可随时关闭

## 与 Web 版的差异

前端改动全部用 `isDesktop`(`window.ark` 探测)运行时门控,Web/PWA 行为零变化:

| 能力 | Web | 桌面 |
|---|---|---|
| 文件导出(xlsx/PNG/备份 JSON/CSES YAML) | 锚点下载 | 原生另存为对话框 |
| 消息系统通知 | 浏览器 Notification(需授权) | 同 API,直接可用 |
| 前端自更新 | PWA Service Worker | 随壳更新(updater 二期) |

## 需要注意

- **Server CORS 白名单**已加入 `ark://app`(`ArkClassHub-Server/src/index.ts`),
  **需要部署 Server 后**打包版才能连生产 API;开发态(localhost:5173)不受影响。
- 二期待办:自动更新(electron-updater + 更新源挂 Cloudflare)、托盘图标、
  麦克风语音消息实机细验。
