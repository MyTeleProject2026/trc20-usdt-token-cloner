const { app, BrowserWindow, protocol, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { URL } = require('node:url')

const APP_SCHEME = 'tronstudio'
const APP_HOST = 'app'
const WEB_ROOT = path.resolve(__dirname, '../dist-electron')
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
})

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}])

function assetPathForRequest(requestUrl) {
  let parsed
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== APP_SCHEME + ':' || parsed.hostname !== APP_HOST) return null
  let pathname
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(WEB_ROOT, relativePath)
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) return null
  return target
}

function openExternalHttps(value) {
  try {
    const target = new URL(value)
    if (target.protocol !== 'https:' || !target.hostname) return
    void shell.openExternal(target.href).catch(() => {})
  } catch {
    // Ignore malformed and non-HTTPS targets; never invoke arbitrary protocols.
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    show: false,
    backgroundColor: '#070b18',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      event.preventDefault()
      return
    }
    if (parsed.protocol === APP_SCHEME + ':' && parsed.hostname === APP_HOST) return
    event.preventDefault()
    openExternalHttps(target)
  })

  void window.loadURL(APP_SCHEME + '://' + APP_HOST + '/')
  return window
}

app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, async (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const filename = assetPathForRequest(request.url)
    if (!filename) return new Response('Not Found', { status: 404 })
    try {
      const data = await fs.readFile(filename)
      const headers = {
        'content-type': MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      }
      return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
