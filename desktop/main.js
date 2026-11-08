// PIANO STUDIO 桌面版外壳
//
// 为什么用 Electron 而不是 Tauri / 系统 WebView：
// 这个应用的核心是 Web Bluetooth（BLE-MIDI）。WebView2 至今没有实现
// navigator.bluetooth，而 Electron 内置完整 Chromium，只要接管设备选择
// 事件，蓝牙连接就与在 Chrome 里一模一样。代价是包体大（~90MB）。
//
// 页面通过自定义协议 piano:// 提供，而不是 file://：
// 1) 自定义协议被注册为 standard + secure，属于「安全上下文」，
//    Web Bluetooth / Web MIDI / AudioContext 全部可用；
// 2) 带 origin，IndexedDB 与 localStorage 的存储位置固定，
//    不会因为路径变化丢工程。
'use strict';

const { app, BrowserWindow, Menu, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// 自动更新：仅安装版可用。开发态（仓库里没装这个依赖）与便携版都跳过，
// 所以这里用 try/catch 按需加载，避免启动即抛错。
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  autoUpdater = null;
}
// 便携版是单文件 exe，没有固定安装目录，无法原地替换自己
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

const SMOKE = process.argv.includes('--smoke');
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
};

// 打包后网页资源在 resources/web，开发时直接用仓库根目录
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.resolve(__dirname, '..');

const SCHEME = 'piano';

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
]);

let mainWindow = null;

/* ---------------------------------------------------------------- 资源协议 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function resolveWebFile(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch (e) {
    return null;
  }
  const rel = pathname.replace(/^\/+/, '') || 'index.html';
  const abs = path.normalize(path.join(WEB_ROOT, rel));
  // 防目录穿越：必须仍在 WEB_ROOT 之内
  const root = path.normalize(WEB_ROOT + path.sep);
  if (!abs.startsWith(root) && abs !== path.normalize(WEB_ROOT)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch (e) {
    return null;
  }
  return abs;
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const file = resolveWebFile(request.url);
    if (!file) return new Response('Not Found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const type = MIME[path.extname(file).toLowerCase()];
    if (type) {
      const headers = new Headers(res.headers);
      headers.set('Content-Type', type);
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  });
}

/* ------------------------------------------------------------------ 蓝牙 */

// Chromium 会为每次 requestDevice() 触发 select-bluetooth-device。
// 必须自己选一个设备并回调，否则请求一直挂着。
let chooser = null;

function pickDevice(list) {
  const named = list.filter((d) => d.deviceName && d.deviceName.trim());
  // 优先名字里带钢琴/MIDI 字样的（梵西 Q1 广播名是 Dight Piano MIDI 2338）
  const byName = named.find((d) => /dight|piano|midi|钢琴/i.test(d.deviceName));
  if (byName) return byName;
  if (named.length) return named[0];
  return list[0] || null;
}

function closeChooser(deviceId) {
  if (!chooser) return;
  const { callback, timer } = chooser;
  chooser = null;
  clearTimeout(timer);
  try {
    callback(deviceId || '');
  } catch (e) {
    /* 已经回调过就忽略 */
  }
}

function setupBluetooth(contents) {
  const ses = contents.session;

  // 渲染进程只加载 piano:// 自己的页面，所以按来源放行即可。
  // 不写死权限名是刻意的：Chromium 的权限枚举随版本增删（bluetooth
  // 就是较新才加进来的），按名字白名单容易在新版本上把蓝牙挡掉。
  const fromOurApp = (wc) => {
    const url = wc && wc.getURL ? wc.getURL() : '';
    return !url || url.startsWith(SCHEME + '://');
  };
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(fromOurApp(wc));
  });
  ses.setPermissionCheckHandler((wc) => fromOurApp(wc));
  ses.setDevicePermissionHandler((details) => details.deviceType === 'bluetooth');

  contents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    if (!chooser) {
      chooser = {
        callback,
        timer: setTimeout(() => closeChooser(''), 20000)
      };
    }
    const best = pickDevice(deviceList || []);
    if (best) closeChooser(best.deviceId);
    // 列表暂时为空就等下一轮事件（Chromium 发现新设备会再触发）
  });
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f2f3f0',
    show: false,
    autoHideMenuBar: false,
    title: 'PIANO STUDIO',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  setupBluetooth(win.webContents);

  win.once('ready-to-show', () => {
    win.show();
  });

  // 站外链接交给系统浏览器，别在应用内开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(SCHEME + '://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(SMOKE ? SCHEME + '://app/index.html?selftest=1' : SCHEME + '://app/index.html');
  return win;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () => checkForUpdates(true)
        },
        { type: 'separator' },
        {
          label: '项目主页',
          click: () => shell.openExternal('https://github.com/SYH-y/piano-studio')
        },
        {
          label: '关于 PIANO STUDIO',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'PIANO STUDIO ' + app.getVersion(),
              detail:
                '电钢琴蓝牙录音工作台（桌面版）\n' +
                'Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome + '\n\n' +
                '代码 MIT，钢琴采样 CC BY 3.0',
              buttons: ['好']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------- 自动更新 */
//
// 安装版走 electron-builder + electron-updater：
// 应用启动 5 秒后静默检查一次 GitHub Release 的 latest.yml，
// 「帮助 → 检查更新…」可以手动检查并看到明确反馈。
// 绿色版（portable）是单个 exe，没法替换自己，只能提示去 Releases 下载。

let updateCheckManual = false;

function updaterState() {
  if (!app.isPackaged) return 'dev';
  if (IS_PORTABLE) return 'portable';
  if (!autoUpdater) return 'missing';
  return 'ok';
}

function dialogBox(opts) {
  const { dialog } = require('electron');
  return mainWindow ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
}

function notifyUpdate(message, detail, type) {
  return dialogBox({ type: type || 'info', title: 'PIANO STUDIO 更新', message, detail, buttons: ['好'], noLink: true });
}

function askUpdate(message, detail, buttons) {
  return dialogBox({
    type: 'question',
    title: 'PIANO STUDIO 更新',
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  });
}

async function checkForUpdates(manual) {
  updateCheckManual = !!manual;
  const state = updaterState();
  if (state === 'dev') {
    if (manual) await notifyUpdate('开发模式不检查更新', '只有在安装版里才会连到 GitHub Releases 检查新版本。');
    return;
  }
  if (state === 'portable') {
    if (manual) {
      await notifyUpdate(
        '绿色版需要手动更新',
        '免安装版是单个 exe，无法在自己身上原地替换。\n请到 Releases 页面下载新版：\nhttps://github.com/SYH-y/piano-studio/releases'
      );
    }
    return;
  }
  if (state === 'missing') {
    if (manual) await notifyUpdate('更新组件缺失', '这个安装包没有包含更新组件，请下载最新的安装版。');
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    updateCheckManual = false;
    if (manual) await notifyUpdate('检查更新失败', String((err && err.message) || err), 'error');
  }
}

function initAutoUpdater() {
  if (updaterState() !== 'ok') return;

  // 不自动下载：先问用户，避免在慢网络下悄悄拉 80MB
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    updateCheckManual = false;
    const answer = await askUpdate(
      '发现新版本 ' + info.version,
      '当前版本 ' + app.getVersion() + '。是否现在下载并安装？\n下载完成后会自动重启。',
      ['下载并安装', '稍后']
    );
    if (answer.response !== 0) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      await notifyUpdate('下载失败', String((err && err.message) || err), 'error');
    }
  });

  autoUpdater.on('update-not-available', async () => {
    if (!updateCheckManual) return;
    updateCheckManual = false;
    await notifyUpdate('已是最新版本', '当前版本 ' + app.getVersion() + '。');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && progress && typeof progress.percent === 'number') {
      // 任务栏进度条：0–1，下载完成后清除
      mainWindow.setProgressBar(Math.max(0.01, Math.min(1, progress.percent / 100)));
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    const answer = await askUpdate(
      '新版本 ' + info.version + ' 已下载完成',
      '是否立即重启并安装？\n选择「稍后」会在下次退出应用时自动安装。',
      ['立即重启并安装', '稍后']
    );
    if (answer.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('error', async (err) => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    if (!updateCheckManual) return;
    updateCheckManual = false;
    await notifyUpdate('更新出错', String((err && err.message) || err), 'error');
  });

  setTimeout(() => { checkForUpdates(false); }, 5000);
}

/* ------------------------------------------------------------- 冒烟自检 */

async function runSmoke(win, outPath) {
  const deadline = Date.now() + 40000;
  let title = '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    title = await win.webContents.executeJavaScript('document.title');
    if (typeof title === 'string' && (title.startsWith('SELFTEST') || title.startsWith('IDB'))) break;
    await sleep(250);
  }

  // 打包后必须带上 electron-updater，否则「检查更新」会静默失效
  const updater = autoUpdater ? 'ok' : 'missing';
  const bt = await win.webContents.executeJavaScript('typeof navigator.bluetooth');
  const secure = await win.webContents.executeJavaScript('window.isSecureContext');
  const tone = await win.webContents.executeJavaScript('typeof (window.AudioContext || window.webkitAudioContext)');
  const workspace = await win.webContents.executeJavaScript(`(() => {
    const tabs = Array.from(document.querySelectorAll('.workspace-tab'));
    const visible = {};
    const result = { tabs: tabs.length, visible, bodyHeight: 0, bodyDisplay: '' };
    tabs.forEach((tab) => {
      tab.click();
      const name = tab.getAttribute('data-workspace');
      let count = 0;
      document.querySelectorAll('[data-workspace]').forEach((el) => {
        // 跳过 <body> 与导航按钮，按真实布局尺寸判断：用 class 判断会漏掉
        // 「body 被加 workspace-hidden 导致整页白屏」这个 bug
        if (el === document.body || el.classList.contains('workspace-tab')) return;
        if (el.getClientRects().length > 0) count++;
      });
      visible[name] = count;
    });
    result.bodyHeight = Math.round(document.body.getBoundingClientRect().height);
    result.bodyDisplay = getComputedStyle(document.body).display;
    result.error = document.body.innerText.indexOf('PIANO STUDIO') >= 0 ? '' : '页面没有主内容';
    return result;
  })()`);

  if (outPath) {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(outPath, img.toPNG());
    } catch (e) {
      console.error('截图失败：' + e.message);
    }
  }

  const navOk = workspace && workspace.tabs === 4
    && workspace.bodyDisplay !== 'none' && workspace.bodyHeight > 300
    && Object.keys(workspace.visible || {}).every((key) => workspace.visible[key] > 0)
    && !workspace.error;
  // 不写死条数：只要「N/N 全通过」且不少于 80 条就算过（加测试时不用同步改这里）
  const countMatch = /^SELFTEST (\d+)\/(\d+)$/.exec(String(title || ''));
  const selfOk = !!countMatch && countMatch[1] === countMatch[2] && Number(countMatch[1]) >= 80;
  const ok = selfOk && bt === 'object' && secure === true && navOk
    && (!app.isPackaged || updater === 'ok');

  // GUI 程序的 stdout 在 CI 里经常收不到，结果必须落盘才算数
  const resultPath = argOf('result');
  if (resultPath) {
    try {
      fs.writeFileSync(resultPath, JSON.stringify({
        ok,
        title,
        bluetooth: bt,
        secureContext: secure,
        audioContext: tone,
        updater,
        workspace,
        electron: process.versions.electron
      }, null, 2));
    } catch (e) {
      console.error('结果文件写入失败：' + e.message);
    }
  }

  console.log('SMOKE title=' + title);
  console.log('SMOKE bluetooth=' + bt);
  console.log('SMOKE secureContext=' + secure);
  console.log('SMOKE audiocontext=' + tone);
  console.log(ok ? 'SMOKE RESULT=PASS' : 'SMOKE RESULT=FAIL');
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ 启动 */

// 冒烟模式不抢单实例锁：否则开发机上开着应用时，CI/本地冒烟会静默退出
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.syhy.pianostudio');
    registerProtocol();
    buildMenu();

    mainWindow = createWindow();

    if (!SMOKE) initAutoUpdater();

    mainWindow.webContents.on('render-process-gone', (e, details) => {
      console.error('渲染进程退出：' + details.reason);
    });

    if (SMOKE) {
      const out = argOf('out');
      mainWindow.webContents.once('did-finish-load', async () => {
        let code = 1;
        try {
          code = await runSmoke(mainWindow, out || null);
        } catch (e) {
          console.error('SMOKE 异常：' + (e && e.stack || e));
        }
        app.exit(code);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
