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

const { app, BrowserWindow, Menu, protocol, net, session, shell, dialog } = require('electron');
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
        timer: setTimeout(() => closeChooser(''), 20000),
        shown: false
      };
    }
    const list = (deviceList || []).filter((d) => d.deviceId && d.deviceName);
    if (!list.length || chooser.shown) return;
    chooser.shown = true;
    const names = list.map((d) => d.deviceName);
    const buttons = names.concat('取消');
    dialog.showMessageBox(mainWindow || BrowserWindow.getFocusedWindow(), {
      type: 'question',
      title: '选择蓝牙 MIDI 设备',
      message: '请选择要连接的电钢琴或 MIDI 键盘：',
      detail: '如果列表中有多台设备，请确认名称和型号后再选择。',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true
    }).then(({ response }) => {
      if (response >= 0 && response < list.length) closeChooser(list[response].deviceId);
      else closeChooser('');
    }).catch(() => closeChooser(''))
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
        {
          // 更新通道走不通时，这是最快的一条路：直接到发布页点安装包
          label: '打开发布页（手动下载）',
          click: () => shell.openExternal('https://github.com/SYH-y/piano-studio/releases/latest')
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

const RELEASES_URL = 'https://github.com/SYH-y/piano-studio/releases';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// electron-updater 没有超时开关：撞上 504 这种「网关吊着不回」的情况，
// 单次请求能卡 30–60 秒，连试三次就是一分钟以上——用户感受就是「点了没反应」。
// 这里套一层超时，到点就把界面还回去，并给出可操作的选择。
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('TIMEOUT: ' + (label || '请求超时') + '，' + Math.max(1, Math.round(ms / 1000)) + ' 秒没有响应'));
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// electron-updater 失败时会把整段 HTTP 响应头和 Node 堆栈塞进 message，
// 直接弹给用户等于没提示。这里翻译成能看懂的原因。
function classifyUpdateError(err) {
  const raw = String((err && (err.message || err)) || '');
  // 取 HTTP 状态码不用正则：正则里的反斜杠经过多层转义容易写坏，
  // 用 indexOf + 数字判断更稳，也不会误配到其它内容。
  const code = (function () {
    const at = raw.indexOf('HttpError:');
    if (at < 0) return '';
    const n = Number(raw.substr(at + 10, 8).trim().slice(0, 3));
    return n >= 100 && n <= 599 ? String(n) : '';
  })();
  const netIssue = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|net::ERR/i.test(raw);
  const gateway = code === '502' || code === '503' || code === '504' || /Gateway Time-out/i.test(raw);

  // 403 / rate limit：GitHub 给未登录程序的额度是每小时 60 次，
  // 用完之后连备用通道也走不通，但一小时内会自己恢复。
  if (code === '403' || /rate limit/i.test(raw)) {
    const minutes = err && err.rateLimitMinutes;
    return {
      retryable: false,
      title: 'GitHub API 的调用次数用完了',
      detail: [
        'GitHub 给未登录程序的额度是每小时 60 次，这个额度已经用完（403）。',
        minutes ? '大约 ' + minutes + ' 分钟后自动恢复，不用重装也不用改设置。' : '额度每小时自动重置，不用重装也不用改设置。',
        '',
        '急着更新的话，点「打开发布页」直接下载安装包即可。'
      ].join('\n')
    };
  }

  if (/^TIMEOUT:/.test(raw)) {
    return {
      retryable: true,
      title: '检查更新超时',
      detail: [
        raw.replace(/^TIMEOUT:\s*/, '') + '。',
        'GitHub 的更新接口在当前网络下很慢或不通。',
        '',
        '你可以：① 点「重试」；② 点「打开发布页」手动下载。',
        '在中国大陆，检查更新通常需要开着代理。'
      ].join('\n')
    };
  }

  if (gateway || netIssue) {
    return {
      retryable: true,
      title: '连不上 GitHub 的下载服务器',
      detail: [
        'GitHub 的 Release 下载地址返回了 ' + (code ? code + ' ' : '') + '网关错误' + (code === '504' ? '（Gateway Time-out）' : '') + '。',
        '这是 GitHub 那边的问题，不是你电脑或程序的问题，一般过一段时间会自己恢复。',
        '',
        '你可以：① 点「备用通道下载」绕开这个入口；② 点「打开发布页」直接下载安装包。'
      ].join('\n')
    };
  }

  if (code === '404' || /Cannot parse releases feed|Unable to find latest version|latest\.yml/i.test(raw)) {
    return {
      retryable: true,
      title: '没读到可用的发布版本',
      detail: 'GitHub 上没有找到 latest.yml 或最新发布，可能是刚发版、CDN 还没同步完。\n可以点「打开发布页」看看，或稍后重试。'
    };
  }
  return {
    retryable: false,
    title: '检查更新失败',
    detail: '技术原因（前 240 字）：\n' + raw.slice(0, 240)
  };
}

/* --- 备用通道：走 GitHub API 取安装包 -------------------------------
 *
 * 为什么需要它：正常更新读的是
 *   https://github.com/SYH-y/piano-studio/releases/download/<tag>/latest.yml
 * 这个入口会整段返回 502/503/504（实测 x-github-edge-region: japaneast），
 * 同一时刻 api.github.com 却是通的。于是这里改用：
 *   1) api.github.com/.../releases/latest   查最新版本与资产 id
 *   2) api.github.com/.../releases/assets/<id> + Accept: octet-stream 下安装包
 * 两条都走 Chromium 网络栈（跟随系统代理），下完再交给用户确认安装。
 */

function apiRequest(url, accept) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('Accept', accept);
    req.setHeader('User-Agent', 'PIANO-STUDIO-Updater');
    req.on('response', (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });
}

function readJsonBody(res) {
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk.toString('utf8'); });
    res.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('返回内容不是 JSON'));
      }
    });
    res.on('error', reject);
  });
}

function versionParts(v) {
  return String(v || '').replace(/^v/i, '').split(/[^0-9]+/).filter(Boolean).map(Number);
}

function isNewerVersion(remote, local) {
  const a = versionParts(remote);
  const b = versionParts(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function downloadAsset(assetId, dest, expectSize) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.github.com/repos/SYH-y/piano-studio/releases/assets/' + assetId;
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('Accept', 'application/octet-stream');
    req.setHeader('User-Agent', 'PIANO-STUDIO-Updater');
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('HttpError: ' + res.statusCode));
        return;
      }
      const total = Number(res.headers['content-length'] || 0) || Number(expectSize || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (mainWindow && total > 0) {
          mainWindow.setProgressBar(Math.max(0.01, Math.min(1, got / total)));
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (mainWindow) mainWindow.setProgressBar(-1);
        if (total > 0 && got !== total) {
          reject(new Error('下载不完整：' + got + ' / ' + total + ' 字节'));
          return;
        }
        resolve(dest);
      });
      res.pipe(out);
    });
    req.on('error', reject);
    req.end();
  });
}

// 缓存 release 信息 30 分钟：GitHub 未登录的 API 额度只有 60 次/小时，
// 反复点「检查更新」不该把额度烧光。
function releaseCachePath() {
  return path.join(app.getPath('userData'), 'update-cache.json');
}

function readReleaseCache() {
  try {
    const data = JSON.parse(fs.readFileSync(releaseCachePath(), 'utf8'));
    if (data && data.fetchedAt && Date.now() - data.fetchedAt < 30 * 60 * 1000 && data.release) {
      return data.release;
    }
  } catch (err) {
    // 没缓存、缓存坏了都当作没有，不是错误
  }
  return null;
}

function writeReleaseCache(release) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(releaseCachePath(), JSON.stringify({ fetchedAt: Date.now(), release }));
  } catch (err) {
    // 写不进去不影响更新，忽略
  }
}

async function downloadViaApi() {
  let release = readReleaseCache();
  if (!release) {
    try {
      const res = await withTimeout(
        apiRequest('https://api.github.com/repos/SYH-y/piano-studio/releases/latest', 'application/vnd.github+json'),
        10000,
        'GitHub API'
      );
      if (res.statusCode === 403) {
        // 把额度恢复时间带出来，用户才知道要等多久
        const reset = Number(res.headers['x-ratelimit-reset'] || 0);
        const err = new Error('HttpError: 403');
        if (reset) err.rateLimitMinutes = Math.max(1, Math.round((reset * 1000 - Date.now()) / 60000));
        throw err;
      }
      if (res.statusCode !== 200) throw new Error('HttpError: ' + res.statusCode);
      release = await readJsonBody(res);
      writeReleaseCache(release);
    } catch (err) {
      const info = classifyUpdateError(err);
      const answer = await dialogBox({
        type: 'error',
        title: 'PIANO STUDIO 更新',
        message: info.title === '检查更新失败' ? '备用通道也连不上' : info.title,
        detail: info.detail,
        buttons: ['打开发布页', '关闭'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (answer.response === 0) shell.openExternal(RELEASES_URL);
      return;
    }
  }

  const remote = String(release.tag_name || '').replace(/^v/i, '');
  if (!isNewerVersion(remote, app.getVersion())) {
    await notifyUpdate('已是最新版本', '当前版本 ' + app.getVersion() + '，线上最新 ' + (remote || '未知') + '。');
    return;
  }

  const assets = release.assets || [];
  const asset = assets.find((item) => /Setup.*[.]exe$/i.test(item.name || ''));
  if (!asset) {
    const answer = await dialogBox({
      type: 'error',
      title: 'PIANO STUDIO 更新',
      message: '这个发布里没有 Windows 安装包',
      detail: '最新版本是 ' + remote + '，但资产里没找到 Setup 安装包。\n请到发布页手动下载。',
      buttons: ['打开发布页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (answer.response === 0) shell.openExternal(RELEASES_URL);
    return;
  }

  const mb = asset.size ? (asset.size / 1048576).toFixed(1) : '?';
  const go = await askUpdate(
    '发现新版本 ' + remote,
    '当前版本 ' + app.getVersion() + '。\n'
      + 'GitHub 的正常更新入口暂时不可用，可以改走备用通道（GitHub API）直接取安装包，约 ' + mb + ' MB。\n'
      + '下载完成后会先问你，再启动安装程序。',
    ['下载', '稍后']
  );
  if (go.response !== 0) return;

  const dest = path.join(app.getPath('temp'), asset.name);
  try {
    await downloadAsset(asset.id, dest, asset.size);
  } catch (err) {
    if (mainWindow) mainWindow.setProgressBar(-1);
    const info = classifyUpdateError(err);
    const answer = await dialogBox({
      type: 'error',
      title: 'PIANO STUDIO 更新',
      message: info.title === '检查更新失败' ? '备用通道下载失败' : info.title,
      detail: info.detail,
      buttons: ['打开发布页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (answer.response === 0) shell.openExternal(RELEASES_URL);
    return;
  }

  const run = await askUpdate(
    '已下载 ' + remote,
    '安装包已保存到：\n' + dest + '\n\n点「立即安装」会启动安装程序；装完再打开应用即可。',
    ['立即安装', '稍后']
  );
  if (run.response === 0) {
    const fail = await shell.openPath(dest);
    if (fail) await notifyUpdate('无法启动安装包', fail + '\n文件位置：\n' + dest, 'error');
  }
}

let updateDialogOpen = false;

// 统一的更新错误弹窗：给出「重试 / 打开发布页」，而不是一坨堆栈
async function updateErrorDialog(err) {
  if (updateDialogOpen) return;
  updateDialogOpen = true;
  try {
    const info = classifyUpdateError(err);
    // 备用通道只在安装版里有意义：绿色版替换不了自己，开发态没有打包
    const canFallback = app.isPackaged && !IS_PORTABLE && !!autoUpdater;
    const buttons = info.retryable
      ? (canFallback ? ['重试', '备用通道下载', '关闭'] : ['重试', '打开发布页', '关闭'])
      : ['重试', '关闭'];
    const detail = info.retryable && canFallback
      ? info.detail + '\n\n「备用通道下载」会绕开这个下载入口，改用 GitHub API 直接取安装包。'
      : info.detail;
    const answer = await dialogBox({
      type: 'error',
      title: 'PIANO STUDIO 更新',
      message: info.title,
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true
    });
    if (answer.response === 0) {
      updateDialogOpen = false;
      return checkForUpdates(true);
    }
    if (info.retryable) {
      if (canFallback && answer.response === 1) {
        updateDialogOpen = false;
        return downloadViaApi();
      }
      if (!canFallback && answer.response === 1) shell.openExternal(RELEASES_URL);
    }
  } finally {
    updateDialogOpen = false;
  }
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
        '免安装版是单个 exe，无法在自己身上原地替换。\n请到 Releases 页面下载新版：\n' + RELEASES_URL
      );
    }
    return;
  }
  if (state === 'missing') {
    if (manual) await notifyUpdate('更新组件缺失', '这个安装包没有包含更新组件，请下载最新的安装版。');
    return;
  }

  // 只试一次：504 往往连续出现，重试三次等于把等待时间乘三，用户只会觉得「卡住」。
  // 超时预算 15 秒（启动时的静默检查 10 秒），到点立刻把选择权交给用户。
  try {
    await withTimeout(autoUpdater.checkForUpdates(), manual ? 12000 : 8000, '检查更新');
    return;
  } catch (err) {
    updateCheckManual = false;
    if (manual) await updateErrorDialog(err);
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
      if (mainWindow) mainWindow.setProgressBar(-1);
      const info = classifyUpdateError(err);
      const answer = await dialogBox({
        type: 'error',
        title: 'PIANO STUDIO 更新',
        message: info.title === '检查更新失败' ? '下载失败' : info.title,
        detail: info.detail + '\n\n也可以点「打开发布页」手动下载安装包。',
        buttons: ['重试下载', '打开发布页', '关闭'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (answer.response === 1) shell.openExternal(RELEASES_URL);
      else if (answer.response === 0) checkForUpdates(true);
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

  // checkForUpdates 的 catch 里已经处理过就不再重复弹窗：
  // electron-updater 会先 emit error、再把 promise 置为 rejected。
  autoUpdater.on('error', async (err) => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    if (!updateCheckManual) return;
    updateCheckManual = false;
    await updateErrorDialog(err);
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
