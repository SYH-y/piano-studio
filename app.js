(function () {
'use strict';

/* ============================================================
   常量
   ============================================================ */
var SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
var CHAR_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';
var SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
var FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
var LETTER_PC = { c:0, d:2, e:4, f:5, g:7, a:9, b:11 };
var LETTERS = ['c','d','e','f','g','a','b'];
var MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
var MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
var KEY_SIG_NAME = { 0:'C', 1:'G', 2:'D', 3:'A', 4:'E', 5:'B', 6:'F#', '-1':'F', '-2':'Bb', '-3':'Eb', '-4':'Ab', '-5':'Db', '-6':'Gb' };

var $ = function (id) { return document.getElementById(id); };

/* ============================================================
   状态
   ============================================================ */
var state = {
  connected: false,
  transport: null,          // 'ble' | 'usb'
  deviceName: '',
  recording: false,
  playing: false,
  notes: [],
  pending: {},
  ccs: [],
  t0: 0,
  lastDur: 0,
  bpm: 90,
  bpmAuto: true,
  timeSig: '4/4',
  gridDiv: 2,
  keyOverride: 'auto',
  wet: 0.38,
  vol: 0.8,
  view: 'roll'
};

/* ============================================================
   练习中心
   ============================================================ */
var practice = {
  active: false,
  startMs: 0,
  endMs: 0,
  speed: 100,
  hand: 'all',
  loop: true,
  cycle: 0,
  hits: 0,
  total: 0,
  wrong: 0,
  early: 0,
  late: 0,
  missed: 0,
  expected: [],
  expectedFinalized: false,
  cycleStartedAt: 0,
  timer: null,
  startedAt: 0,
  history: []
};

var midiImport = {
  fileName: '',
  ppq: 480,
  bpm: 120,
  timeSig: '4/4',
  tracks: [],
  selected: {},
  muted: {},
  solo: {},
  hand: 'all'
};

var audioInput = {
  stream: null,
  recorder: null,
  chunks: [],
  source: null,
  gain: null,
  analyser: null,
  monitorGain: null,
  meterRaf: 0,
  gainValue: 1,
  latencyMs: 0,
  recording: false,
  deviceId: ''
};

/* ============================================================
   音频引擎
   ============================================================ */
var actx = null, live = null;
var samples = new Map();
var samplesReady = false;
var activeNodes = [];

function stopAllSound() {
  for (var i = 0; i < activeNodes.length; i++) {
    try { activeNodes[i].stop(0); } catch (e) {}
  }
  activeNodes = [];
}

// 播放过的节点必须自己退场，否则长录音会把上万个已结束的节点留在数组里
function trackNode(node) {
  activeNodes.push(node);
  node.onended = function () {
    var i = activeNodes.indexOf(node);
    if (i >= 0) activeNodes.splice(i, 1);
  };
  return node;
}

function makeIR(ac, seconds, decay) {
  var rate = ac.sampleRate, len = Math.floor(rate * seconds);
  var buf = ac.createBuffer(2, len, rate);
  for (var c = 0; c < 2; c++) {
    var d = buf.getChannelData(c);
    for (var i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function buildGraph(ac, wetAmount, vol) {
  var master = ac.createGain();
  master.gain.value = vol;

  var comp = ac.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 8;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;

  master.connect(comp);
  comp.connect(ac.destination);

  var dry = ac.createGain();
  dry.gain.value = 1;
  dry.connect(master);

  var conv = ac.createConvolver();
  conv.buffer = makeIR(ac, 2.6, 2.6);
  var wet = ac.createGain();
  wet.gain.value = wetAmount;
  wet.connect(conv);
  conv.connect(master);

  return { dry: dry, wet: wet, master: master };
}

function initLive() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  live = buildGraph(actx, state.wet, state.vol);
}

function freqOf(p) { return 440 * Math.pow(2, (p - 69) / 12); }

function synthVoice(ac, outs, t, freq, vel, dur, rel) {
  var amp = Math.pow(vel / 127, 1.5) * 0.17;
  var partials = [[1,1.00,2.9],[2,0.46,1.7],[3,0.24,1.15],[4,0.13,0.8],[5,0.07,0.55],[6,0.04,0.4]];
  var bus = ac.createGain();
  bus.connect(outs.dry);
  bus.connect(outs.wet);

  var stopAt = t + Math.max(dur, 0.05) + rel + 0.12;

  for (var i = 0; i < partials.length; i++) {
    var mult = partials[i][0], pa = partials[i][1], pd = partials[i][2];
    if (freq * mult > ac.sampleRate / 2.2) continue;

    var osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * mult * (1 + (Math.random() - 0.5) * 0.0009);

    var g = ac.createGain();
    var peak = Math.max(amp * pa, 0.0002);
    var decayTo = Math.max(peak * 0.015, 0.0002);
    var decayAt = t + Math.max(0.25, 2.4 / pd);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(decayTo, decayAt);
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(decayAt + 0.02, t + Math.max(dur, 0.05) + rel));

    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(stopAt);
    trackNode(osc);
  }
  return bus;
}

function nearestSample(pitch) {
  var best = null, bestD = 999;
  samples.forEach(function (buf, key) {
    var d = Math.abs(key - pitch);
    if (d < bestD) { bestD = d; best = key; }
  });
  return best;
}

function sampleVoice(ac, outs, t, pitch, vel, dur, rel) {
  var key = nearestSample(pitch);
  if (key === null) return false;

  var src = ac.createBufferSource();
  src.buffer = samples.get(key);
  src.playbackRate.value = Math.pow(2, (pitch - key) / 12);

  var g = ac.createGain();
  var amp = Math.pow(vel / 127, 1.1) * 0.9;
  var end = t + Math.max(dur, 0.06);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.004);
  g.gain.setValueAtTime(amp, end);
  g.gain.exponentialRampToValueAtTime(0.0001, end + rel);

  src.connect(g);
  g.connect(outs.dry);
  g.connect(outs.wet);
  src.start(t);
  src.stop(end + rel + 0.1);
  trackNode(src);
  return g;
}

function playTone(ac, outs, t, pitch, vel, dur, rel) {
  if (samplesReady) {
    try {
      var v = sampleVoice(ac, outs, t, pitch, vel, dur, rel);
      if (v) return v;
    } catch (e) {}
  }
  return synthVoice(ac, outs, t, freqOf(pitch), vel, dur, rel);
}

async function loadSamples() {
  initLive();
  if (actx.state === 'suspended') actx.resume();

  var btn = $('btnSamples');
  btn.disabled = true;

  var pitches = [];
  for (var p = 21; p <= 108; p += 2) pitches.push(p);

  var ok = 0;
  for (var i = 0; i < pitches.length; i++) {
    var pc = pitches[i] % 12;
    var nm = FLAT[pc] + (Math.floor(pitches[i] / 12) - 1);
    try {
      var res = await fetch('samples/' + nm + '.mp3');
      if (res.ok) {
        var raw = await res.arrayBuffer();
        var buf = await actx.decodeAudioData(raw);
        samples.set(pitches[i], buf);
        ok++;
      }
    } catch (e) {}
    btn.textContent = '加载中 ' + Math.round((i + 1) / pitches.length * 100) + '%';
  }

  samplesReady = samples.size > 20;
  btn.textContent = samplesReady ? '真实采样已就绪（' + samples.size + ' 键）' : '加载失败，改用合成音色';
  btn.disabled = false;
}

/* ============================================================
   键盘
   ============================================================ */
var KEY_LOW = 21, KEY_HIGH = 108;
var keyEls = {};

(function buildKeys() {
  var host = $('keys');
  var whites = [];
  for (var n = KEY_LOW; n <= KEY_HIGH; n++) {
    var pc = n % 12;
    if (pc !== 1 && pc !== 3 && pc !== 6 && pc !== 8 && pc !== 10) whites.push(n);
  }
  var W = 100 / whites.length;

  whites.forEach(function (n, i) {
    var d = document.createElement('div');
    d.className = 'wk';
    d.style.left = (i * W) + '%';
    d.style.width = W + '%';
    if (n % 12 === 0) d.textContent = 'C' + (Math.floor(n / 12) - 1);
    host.appendChild(d);
    keyEls[n] = d;
  });

  for (var m = KEY_LOW; m <= KEY_HIGH; m++) {
    var p = m % 12;
    if (p !== 1 && p !== 3 && p !== 6 && p !== 8 && p !== 10) continue;
    var before = whites.filter(function (w) { return w < m; }).length;
    var b = document.createElement('div');
    b.className = 'bk';
    b.style.left = (before * W - W * 0.31) + '%';
    b.style.width = (W * 0.62) + '%';
    host.appendChild(b);
    keyEls[m] = b;
  }

  setTimeout(function () {
    var sc = host.parentNode;
    if (sc && sc.classList.contains('keys-scroll')) {
      sc.scrollLeft = (host.scrollWidth - sc.clientWidth) / 2;
    }
  }, 30);
})();

function lightKey(n, on) {
  var el = keyEls[n];
  if (!el) return;
  if (on) el.classList.add('on'); else el.classList.remove('on');
}

/* ============================================================
   BLE MIDI
   ============================================================ */
/* BLE-MIDI 事件包（BEP）结构：
 *
 *   [包头 0x80|ts高6位]  ( [ts低7位] [状态字节] [数据...] )*
 *
 * 包头携带 13 位时间戳的高 6 位，每条消息前各带一个低 7 位的时间戳字节。
 * 时间戳字节可以省略，表示沿用上一个。
 *
 * 难点在于时间戳字节（0x80–0xFF）和状态字节（0x80–0xEF）、系统实时消息（0xF8–0xFF）
 * 的取值范围完全重叠。裁决规则只有一条：
 *
 *   时间戳后面一定跟状态字节（>=0x80）；
 *   状态字节后面一定是数据字节（<0x80）。
 *
 * 所以看一眼下一个字节就能定，不需要猜。
 */
function createMidiParser() {
  var carry = [];      // 上一包没消费完的字节
  var ts = 0;          // 当前生效的时间戳（已解回绕，单位 ms）
  var lastRaw = -1;    // 上一个原始 13 位时间戳
  var wrapBase = 0;    // 回绕累计

  function dataLen(status) {
    var k = status & 0xF0;
    return (k === 0xC0 || k === 0xD0) ? 1 : 2;   // 音色切换 / 通道压力只有 1 个数据字节
  }

  function feed(bytes) {
    var out = [];
    if (!bytes.length) return out;

    var hi6 = 0, off = 0;
    if (bytes[0] & 0x80) { hi6 = bytes[0] & 0x3F; off = 1; }

    var buf = carry.concat(Array.prototype.slice.call(bytes, off));
    carry = [];

    var i = 0;
    while (i < buf.length) {
      var b = buf[i];
      if (b < 0x80) { i++; continue; }            // 孤立的数据字节，丢弃

      var next = buf[i + 1];
      if (next === undefined) { carry = buf.slice(i); break; }   // 判别不了，等下一包

      if (next >= 0x80) {                          // 后面还是高位字节 → 这是时间戳
        var raw = (hi6 << 7) | (b & 0x7F);
        if (lastRaw >= 0 && raw < lastRaw && lastRaw - raw > 4096) wrapBase += 8192;
        lastRaw = raw;
        ts = wrapBase + raw;
        i++;
        continue;
      }

      if (b >= 0xF8) { out.push({ ts: ts, msg: [b] }); i++; continue; }   // 实时消息
      if (b === 0xF0) {                            // SysEx：跳到结束字节，不做解析
        while (i < buf.length && buf[i] !== 0xF7) i++;
        i++;
        continue;
      }
      if (b >= 0xF1 && b <= 0xF7) { i++; continue; }  // 其余系统公共消息，跳过

      var n = dataLen(b);
      if (i + n >= buf.length) { carry = buf.slice(i); break; }
      out.push({ ts: ts, msg: buf.slice(i, i + n + 1) });
      i += n + 1;
    }
    return out;
  }

  return {
    feed: feed,
    reset: function () { carry = []; ts = 0; lastRaw = -1; wrapBase = 0; }
  };
}

var midiParser = createMidiParser();

function nowMs() {
  return state.recording ? performance.now() - state.t0 : 0;
}

var monitorNodes = {};

function onNoteOn(pitch, vel, t) {
  lightKey(pitch, true);
  practiceHandleNote(pitch);
  if (state.recording) {
    state.pending[pitch] = { pitch: pitch, vel: vel, tOn: t, tOff: null };
  }
  if ($('monitor').checked) {
    initLive();
    if (actx.state === 'suspended') actx.resume();
    // 同一音高连按时，先把上一个还响着的收掉，避免叠成一片
    var prev = monitorNodes[pitch];
    if (prev) {
      try {
        var tn = actx.currentTime;
        prev.gain.cancelScheduledValues(tn);
        prev.gain.setValueAtTime(Math.max(prev.gain.value, 0.0001), tn);
        prev.gain.exponentialRampToValueAtTime(0.0001, tn + 0.06);
      } catch (e) {}
    }
    // 时值给足，真正的收声交给抬键
    monitorNodes[pitch] = playTone(actx, live, actx.currentTime + 0.01, pitch, vel, 4, 0.5);
  }
  drawRoll();
}

function onNoteOff(pitch, t) {
  lightKey(pitch, false);

  var mn = monitorNodes[pitch];
  if (mn && actx) {
    delete monitorNodes[pitch];
    try {
      var now = actx.currentTime;
      mn.gain.cancelScheduledValues(now);
      mn.gain.setValueAtTime(Math.max(mn.gain.value, 0.0001), now);
      mn.gain.exponentialRampToValueAtTime(0.0001, now + ($('sustain').checked ? 0.6 : 0.18));
    } catch (e) {}
  }

  if (state.recording) {
    var p = state.pending[pitch];
    if (p) {
      p.tOff = t;
      state.notes.push(p);
      delete state.pending[pitch];
      $('mNotes').textContent = state.notes.length;
    }
  }
  drawRoll();
}

function handleMessage(msg, t) {
  var kind = msg[0] & 0xF0;
  if (kind === 0x90 && msg.length >= 3 && msg[2] > 0) {
    onNoteOn(msg[1], msg[2], t);
  } else if (kind === 0x80 || (kind === 0x90 && msg.length >= 3 && msg[2] === 0)) {
    onNoteOff(msg[1], t);
  } else if (kind === 0xB0) {
    state.ccs.push({ cc: msg[1], value: msg[2], t: t });
    $('mCc').textContent = state.ccs.length;
    var label = msg[1] === 64 ? '延音踏板' : ('CC' + msg[1]);
    $('ccbox').textContent = label + '：B0 ' + msg[1].toString(16).toUpperCase() + ' ' + msg[2].toString(16).toUpperCase() + '（值 ' + msg[2] + '）';
  }
}

var bleChar = null;
var bleDevice = null;

function setPill(text, cls) {
  $('pillText').textContent = text;
  $('pill').className = 'pill' + (cls ? ' ' + cls : '');
}

function disconnectBle() {
  if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
    try { bleDevice.gatt.disconnect(); } catch (e) {}
  }
  bleChar = null;
  monitorNodes = {};
}

async function connect() {
  if (!navigator.bluetooth) {
    setPill('浏览器不支持蓝牙');
    alert('这个浏览器不支持 Web Bluetooth。请用 Chrome 或 Edge 打开。');
    return;
  }
  try {
    // 换琴时先把旧连接断掉，否则旧的 characteristic 监听会一直挂着
    disconnectBle();
    disconnectMidiInput(true);
    $('midiMenu').classList.remove('show');

    $('btnConnect').disabled = true;
    setPill('搜索中…');

    var device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [SERVICE] },
        { namePrefix: 'Dight' },
        { namePrefix: 'Piano' }
      ],
      optionalServices: [SERVICE]
    });

    setPill('连接中…');
    midiParser.reset();
    bleDevice = device;
    var server = await device.gatt.connect();
    var service = await server.getPrimaryService(SERVICE);
    bleChar = await service.getCharacteristic(CHAR_UUID);
    await bleChar.startNotifications();

    bleChar.addEventListener('characteristicvaluechanged', function (ev) {
      var dv = ev.target.value;
      var bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

      var arrival = nowMs();
      var list = midiParser.feed(bytes);
      if (!list.length) return;

      // 包间用本机时钟，包内用设备时间戳做偏移。
      // 这样既避免设备时钟漂移，又能还原同一包里多个音的真实先后
      // （否则一个和弦会被压成同一毫秒）。设备时间戳恒定时偏移为 0，自动退回到达时刻。
      var base = list[0].ts;
      for (var mi = 0; mi < list.length; mi++) {
        var off = list[mi].ts - base;
        if (!(off >= 0 && off <= 500)) off = 0;
        handleMessage(list[mi].msg, arrival + off);
      }
    });

    device.addEventListener('gattserverdisconnected', function () {
      state.connected = false;
      bleChar = null;
      state.transport = null;
      state.deviceName = '';
      $('btnConnect').disabled = false;
      $('btnConnect').textContent = '连接钢琴';
      setPill('已断开');
    });

    state.connected = true;
    state.transport = 'ble';
    state.deviceName = device.name || 'BLE MIDI';
    $('btnConnect').disabled = false;
    $('btnConnect').textContent = '已连接';
    setPill(state.deviceName, 'on');
  } catch (err) {
    $('btnConnect').disabled = false;
    setPill('未连接');
    if (err && err.name !== 'NotFoundError') alert('连接失败：' + err.message);
  }
}

/* ============================================================
   Web MIDI（USB 线）
   ============================================================ */
/* 与 BLE 的区别：Web MIDI 交上来的是**完整 MIDI 消息**，不含 BLE 的包头和时间戳，
 * 所以不需要走 createMidiParser，直接交给 handleMessage 即可。
 * 时间戳用本机时钟——USB 传输没有打包延迟，不需要设备时间戳补偿。
 */
var webMidi = { access: null, input: null };

function applyMidiEvent(data, t) {
  if (!data || !data.length) return false;
  if (data[0] >= 0xF0) return false;      // 系统公共/实时消息不参与演奏
  handleMessage(Array.prototype.slice.call(data), t);
  return true;
}

function midiMenuClose() {
  $('midiMenu').classList.remove('show');
}

function renderMidiMenu() {
  var host = $('midiMenu');
  host.textContent = '';

  if (!webMidi.access) {
    host.innerHTML = '<div class="mempty">没有取到 MIDI 权限。</div>';
    return;
  }

  var list = [];
  webMidi.access.inputs.forEach(function (inp) { list.push(inp); });

  if (!list.length) {
    var em = document.createElement('div');
    em.className = 'mempty';
    em.textContent = '没有发现 MIDI 输入。插上 USB 线、把琴切到 USB/COMPUTER 模式后点下面的「重新扫描」。';
    host.appendChild(em);
  }

  list.forEach(function (inp) {
    var b = document.createElement('button');
    b.className = 'mi' + (webMidi.input && webMidi.input.id === inp.id ? ' on' : '');
    b.type = 'button';

    var name = document.createElement('b');
    name.textContent = inp.name || '未命名 MIDI 输入';
    var meta = document.createElement('span');
    var bits = [];
    if (inp.manufacturer) bits.push(inp.manufacturer);
    if (inp.state === 'connected') bits.push('已就绪'); else bits.push('已断开');
    if (webMidi.input && webMidi.input.id === inp.id) bits.push('当前使用中');
    meta.textContent = bits.join(' · ');

    b.appendChild(name);
    b.appendChild(meta);
    b.addEventListener('click', function () {
      connectMidiInput(inp.id);
      midiMenuClose();
    });
    host.appendChild(b);
  });

  var sep = document.createElement('div');
  sep.className = 'msep';
  host.appendChild(sep);

  var re = document.createElement('button');
  re.className = 'mi';
  re.type = 'button';
  re.innerHTML = '<b>重新扫描</b><span>插拔设备后点这里</span>';
  re.addEventListener('click', function () { refreshMidiPorts(); });
  host.appendChild(re);

  if (webMidi.input) {
    var off = document.createElement('button');
    off.className = 'mi';
    off.type = 'button';
    off.innerHTML = '<b>断开 USB</b><span>回到未连接状态</span>';
    off.addEventListener('click', function () {
      disconnectMidiInput();
      midiMenuClose();
    });
    host.appendChild(off);
  }
}

async function refreshMidiPorts() {
  if (!navigator.requestMIDIAccess) {
    alert('这个浏览器不支持 Web MIDI。Chrome / Edge 89 以上可用。');
    return;
  }
  try {
    if (!webMidi.access) {
      webMidi.access = await navigator.requestMIDIAccess({ sysex: false });
      webMidi.access.onstatechange = function () {
        if ($('midiMenu').classList.contains('show')) renderMidiMenu();
      };
    }
    renderMidiMenu();
    $('midiMenu').classList.add('show');
  } catch (err) {
    alert('无法访问 MIDI 设备：' + (err && err.message ? err.message : err) +
          '\n\n如果浏览器弹出了权限提示，请选择「允许」。');
  }
}

function connectMidiInput(id) {
  if (!webMidi.access) return;
  var inp = webMidi.access.inputs.get(id);
  if (!inp) { alert('这个端口已经不在了，点「重新扫描」试试。'); return; }

  if (webMidi.input && webMidi.input.id !== id) {
    try { webMidi.input.onmidimessage = null; } catch (e) {}
  }
  disconnectBle();

  inp.onmidimessage = function (ev) {
    var arrival = nowMs();
    applyMidiEvent(ev.data, arrival);
  };

  webMidi.input = inp;
  state.connected = true;
  state.transport = 'usb';
  state.deviceName = inp.name || 'USB MIDI';
  $('btnConnect').textContent = '已连接';
  setPill('USB · ' + state.deviceName, 'on');
  renderMidiMenu();
}

function disconnectMidiInput(silent) {
  if (webMidi.input) {
    try { webMidi.input.onmidimessage = null; } catch (e) {}
    webMidi.input = null;
  }
  if (!silent) {
    if (state.transport === 'usb') {
      state.connected = false;
      state.transport = null;
      state.deviceName = '';
      $('btnConnect').textContent = '连接钢琴';
      setPill('未连接');
    }
  }
}

/* ============================================================
   录音 / 播放
   ============================================================ */
var metro = { timer: null, next: 0, count: 0, spb: 0 };

function metroClick(at, accent) {
  initLive();
  var ac = actx;
  var o = ac.createOscillator();
  var g = ac.createGain();
  o.type = 'square';
  o.frequency.value = accent ? 1800 : 1200;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.20, at + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  o.connect(g);
  g.connect(ac.destination);
  o.start(at);
  o.stop(at + 0.09);
  trackNode(o);
}

function startMetro() {
  stopMetro();
  initLive();
  if (actx.state === 'suspended') actx.resume();
  metro.spb = 60 / state.bpm;
  metro.next = actx.currentTime + 0.12;
  metro.count = 0;
  metro.timer = setInterval(function () {
    while (metro.next < actx.currentTime + 0.25) {
      metroClick(metro.next, metro.count % 4 === 0);
      metro.next += metro.spb;
      metro.count++;
    }
  }, 40);
}

function stopMetro() {
  if (metro.timer) { clearInterval(metro.timer); metro.timer = null; }
}

function runCountIn(cb) {
  initLive();
  if (actx.state === 'suspended') actx.resume();
  var spb = 60 / state.bpm;
  var t0 = actx.currentTime + 0.15;
  for (var i = 0; i < 4; i++) metroClick(t0 + i * spb, i === 0);

  var left = 4;
  setPill('预备 ' + left, 'rec');
  var iv = setInterval(function () {
    left--;
    if (left > 0) setPill('预备 ' + left, 'rec');
  }, spb * 1000);

  setTimeout(function () {
    clearInterval(iv);
    setPill('录音中', 'rec');
    cb();
  }, (t0 - actx.currentTime + 4 * spb) * 1000);
}

function startRec() {
  initLive();
  if (actx.state === 'suspended') actx.resume();

  if ($('chkCountIn').checked) {
    $('btnRec').disabled = true;
    runCountIn(function () {
      $('btnRec').disabled = false;
      startRecNow();
    });
    return;
  }
  startRecNow();
}

function startRecNow() {
  initLive();
  if (actx.state === 'suspended') actx.resume();
  if (practice.active) stopPractice();

  state.notes = [];
  state.pending = {};
  state.ccs = [];
  practiceUpdate();
  state.lastDur = 0;
  noteEdit.selected = -1;
  noteEdit.undo = [];
  noteEdit.redo = [];
  noteEdit.drag = null;
  velDragStart = null;
  state.recording = true;
  state.bpmAuto = true;
  state.t0 = performance.now();
  if ($('chkMetro').checked) startMetro();

  $('mNotes').textContent = '0';
  $('mCc').textContent = '0';
  $('mTime').textContent = '0.0s';
  $('ccbox').textContent = '等待数据…';
  $('btnRec').textContent = '■ 停止录音';
  $('btnRec').classList.add('danger');
  $('btnPlay').disabled = true;
  setPill('录音中', 'rec');
  updateMini();
  tick();
}

function stopRec() {
  state.recording = false;
  stopMetro();
  var t = performance.now() - state.t0;
  Object.keys(state.pending).forEach(function (k) {
    var p = state.pending[k];
    p.tOff = t;
    state.notes.push(p);
  });
  state.pending = {};
  state.lastDur = t / 1000;
  practiceSyncBounds();

  $('mNotes').textContent = state.notes.length;
  $('mTime').textContent = state.lastDur.toFixed(1) + 's';
  $('btnRec').textContent = '● 开始录音';
  $('btnRec').classList.remove('danger');
  setPill(state.deviceName || '已连接', 'on');

  var has = state.notes.length > 0;
  $('btnPlay').disabled = !has;
  $('btnMidi').disabled = !has;
  $('btnWav').disabled = !has;
  $('btnMp3').disabled = !has;
  $('btnStop').disabled = !has;

  if (has) {
    estimateTempo();
    buildScore();
    renderAll();
  }
  drawRoll();
  scheduleSave();
  if (has) saveSnapshot(true);
  updateMini();
}

var lastLiveRender = 0;
var lastTempoGuess = 0;
var lastLiveSig = '';

function tick() {
  if (!state.recording) return;
  $('mTime').textContent = ((performance.now() - state.t0) / 1000).toFixed(1) + 's';

  var now = performance.now();

  if (state.bpmAuto && now - lastTempoGuess > 2500 && state.notes.length >= 6) {
    lastTempoGuess = now;
    estimateTempo();
  }

  if (now - lastLiveRender > 700) {
    lastLiveRender = now;
    var sig = state.notes.length + ':' + Object.keys(state.pending).length;
    if (sig !== lastLiveSig) {
      lastLiveSig = sig;
      buildScore();
      renderStaff();
      renderJianpu();
    }
  }

  drawRoll();
  requestAnimationFrame(tick);
}

var playTimer = null;

function play() {
  var done = state.notes.filter(function (n) { return n.tOff !== null; });
  if (!done.length) return;
  initLive();
  if (actx.state === 'suspended') actx.resume();

  if (state.playing) stopPlay();

  var rel = $('sustain').checked ? 1.4 : 0.12;
  var start = actx.currentTime + 0.12;
  done.forEach(function (n) {
    var dur = Math.max(0.05, (n.tOff - n.tOn) / 1000);
    playTone(actx, live, start + n.tOn / 1000, n.pitch, n.vel, dur, rel);
  });

  state.playing = true;
  $('btnStop').disabled = false;
  var total = Math.max.apply(null, done.map(function (n) { return n.tOff; })) / 1000;
  state.playStart = start;
  state.playTotal = total;
  setPill('播放中', 'on');
  animatePlayhead();

  playTimer = setTimeout(function () {
    state.playing = false;
    setPill(state.deviceName || '已连接', 'on');
    drawRoll();
  }, (total + 1.6) * 1000);
}

function stopPlay() {
  state.playing = false;
  stopAllSound();
  if (playTimer) clearTimeout(playTimer);
  drawRoll();
}

function animatePlayhead() {
  if (!state.playing) return;
  drawRoll();
  requestAnimationFrame(animatePlayhead);
}

/* ============================================================
   练习中心：选段循环、速度训练与基础命中统计
   ============================================================ */
function practiceDoneNotes() {
  return state.notes.filter(function (n) { return n && n.tOff !== null && n.tOff > n.tOn; });
}

function practiceMaxSec() {
  var notes = practiceDoneNotes();
  var maxMs = 0;
  notes.forEach(function (n) { if (n.tOff > maxMs) maxMs = n.tOff; });
  return Math.max(state.lastDur || 0, maxMs / 1000);
}

function practiceMatchesHand(pitch) {
  if (practice.hand === 'right') return pitch >= 60;
  if (practice.hand === 'left') return pitch < 60;
  return true;
}


function practiceRenderHistory() {
  var host = $('practiceHistoryList');
  if (!host) return;
  host.textContent = '';
  practice.history.slice().reverse().slice(0, 5).forEach(function (entry) {
    var row = document.createElement('div');
    row.className = 'practice-history-row';
    var when = new Date(entry.ts);
    var label = document.createElement('span');
    label.textContent = pad2(when.getMonth() + 1) + '/' + pad2(when.getDate()) + ' ' + pad2(when.getHours()) + ':' + pad2(when.getMinutes()) + ' · ' + entry.rounds + ' 轮';
    var value = document.createElement('b');
    value.textContent = entry.accuracy + '% · 错 ' + entry.wrong + ' · 漏 ' + entry.missed;
    row.appendChild(label);
    row.appendChild(value);
    host.appendChild(row);
  });
}
function practiceLoadHistory() {
  try {
    var raw = localStorage.getItem('pianoStudio.practiceHistory');
    practice.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(practice.history)) practice.history = [];
  } catch (e) { practice.history = []; }
  practiceRenderHistory();
}
function practiceSaveSession() {
  if (!practice.total) return;
  var entry = { ts: Date.now(), rounds: practice.cycle, accuracy: Math.round(practice.hits / practice.total * 100), wrong: practice.wrong, early: practice.early, late: practice.late, missed: practice.missed, duration: Math.max(0, Date.now() - practice.startedAt) };
  practice.history.push(entry);
  if (practice.history.length > 20) practice.history.shift();
  try { localStorage.setItem('pianoStudio.practiceHistory', JSON.stringify(practice.history)); } catch (e) {}
  practiceRenderHistory();
}
function practiceFinalizeCycle() {
  if (practice.expectedFinalized) return;
  practice.expectedFinalized = true;
  practice.missed += practice.expected.filter(function (e) { return !e.hit; }).length;
}

function practiceUpdate() {
  var start = $('practiceStart'), end = $('practiceEnd');
  var max = practiceMaxSec();
  if (start && end) {
    start.max = max.toFixed(1);
    end.max = max.toFixed(1);
  }
  if ($('practiceTempoVal')) $('practiceTempoVal').textContent = practice.speed + '%';
  if ($('practiceRounds')) $('practiceRounds').textContent = practice.cycle;
  if ($('practiceWrong')) $('practiceWrong').textContent = practice.wrong;
  if ($('practiceEarly')) $('practiceEarly').textContent = practice.early;
  if ($('practiceLate')) $('practiceLate').textContent = practice.late;
  if ($('practiceMissed')) $('practiceMissed').textContent = practice.missed;
  if ($('practiceAccuracy')) {
    $('practiceAccuracy').textContent = practice.total ? Math.round(practice.hits / practice.total * 100) + '%' : '—';
  }
  var ready = practiceDoneNotes().length > 0;
  if ($('btnPracticeStart')) $('btnPracticeStart').disabled = !ready || practice.active;
  if ($('btnPracticeStop')) $('btnPracticeStop').disabled = !practice.active;
  if ($('practiceHint') && !practice.active) {
    $('practiceHint').textContent = ready
      ? '选好起止时间后开始练习；弹奏时会按音高和时机统计基础准确率。'
      : '录完一段后选择起止时间，软件会按当前速度循环播放这一段。';
  }
}

function practiceSyncBounds() {
  var max = practiceMaxSec();
  var start = $('practiceStart'), end = $('practiceEnd');
  if (!start || !end) return;
  start.max = max.toFixed(1);
  end.max = max.toFixed(1);
  if (!(parseFloat(end.value) > 0) || parseFloat(end.value) > max) end.value = max.toFixed(1);
  if (parseFloat(start.value) > max) start.value = '0';
  practiceUpdate();
}

function practiceSetFull() {
  var max = practiceMaxSec();
  $('practiceStart').value = '0';
  $('practiceEnd').value = max.toFixed(1);
  practiceUpdate();
}

function practiceRange() {
  var max = practiceMaxSec();
  var a = Math.max(0, parseFloat($('practiceStart').value) || 0);
  var b = Math.min(max, parseFloat($('practiceEnd').value) || max);
  if (b <= a + 0.05) { a = 0; b = max; }
  $('practiceStart').value = a.toFixed(1);
  $('practiceEnd').value = b.toFixed(1);
  return { start: a * 1000, end: b * 1000 };
}

function practiceStartCycle() {
  if (!practice.active) return;
  if (practice.timer) clearTimeout(practice.timer);
  stopAllSound();
  initLive();
  if (actx.state === 'suspended') actx.resume();

  var scale = 100 / practice.speed;
  var notes = practiceDoneNotes().filter(function (n) {
    return n.tOn >= practice.startMs && n.tOn < practice.endMs && practiceMatchesHand(n.pitch);
  });
  practice.expected = notes.map(function (n) {
    return { pitch: n.pitch, at: (n.tOn - practice.startMs) / 1000 * scale, hit: false };
  });
  practice.expectedFinalized = false;
  practice.total += practice.expected.length;
  var base = actx.currentTime + 0.08;
  practice.cycleStartedAt = performance.now() + 80;
  var rel = $('sustain').checked ? 1.0 : 0.12;
  notes.forEach(function (n) {
    var at = base + (n.tOn - practice.startMs) / 1000 * scale;
    var dur = Math.max(0.05, (n.tOff - n.tOn) / 1000 * scale);
    playTone(actx, live, at, n.pitch, n.vel, dur, rel);
  });

  var cycleDur = Math.max(0.2, (practice.endMs - practice.startMs) / 1000 * scale);
  if ($('practiceHint')) $('practiceHint').textContent = '第 ' + (practice.cycle + 1) + ' 轮 · 弹奏高亮声部，软件会统计音高和时机。';
  practice.timer = setTimeout(function () {
    if (!practice.active) return;
    practiceFinalizeCycle();
    practice.cycle++;
    practiceUpdate();
    if (practice.loop) practiceStartCycle(); else stopPractice();
  }, cycleDur * 1000 + 120);
}

function practiceHandleNote(pitch) {
  if (!practice.active || !practiceMatchesHand(pitch)) return;
  
  var elapsed = (performance.now() - practice.cycleStartedAt) / 1000;
  var best = null, bestDiff = Infinity;
  practice.expected.forEach(function (e) {
    if (e.hit || e.pitch !== pitch) return;
    var diff = Math.abs(e.at - elapsed);
    if (diff < bestDiff) { best = e; bestDiff = diff; }
  });
  var tolerance = Math.max(0.18, 0.24 * (100 / practice.speed));
  if (best && bestDiff <= tolerance) {
    best.hit = true;
    practice.hits++;
    var signed = elapsed - best.at;
    var feedback = $('practiceFeedback');
    if (signed < -0.08) {
      practice.early++;
      if (feedback) { feedback.textContent = '偏早 ' + Math.round(-signed * 1000) + ' ms · ' + noteNameOf(pitch); feedback.className = 'practice-feedback early'; }
    } else if (signed > 0.08) {
      practice.late++;
      if (feedback) { feedback.textContent = '偏晚 ' + Math.round(signed * 1000) + ' ms · ' + noteNameOf(pitch); feedback.className = 'practice-feedback late'; }
    } else {
      if (feedback) { feedback.textContent = '命中 · ' + noteNameOf(pitch); feedback.className = 'practice-feedback'; }
    }
  } else {
    practice.wrong++;
    var wrongFeedback = $('practiceFeedback');
    if (wrongFeedback) { wrongFeedback.textContent = '错音 · ' + noteNameOf(pitch); wrongFeedback.className = 'practice-feedback wrong'; }
  }
  practiceUpdate();
}

function startPractice() {
  if (!practiceDoneNotes().length) { alert('还没有可练习的录音。先录一段或打开工程。'); return; }
  if (practice.active) stopPractice();
  stopPlay();
  var range = practiceRange();
  if (range.end - range.start < 100) return;
  practice.startMs = range.start;
  practice.endMs = range.end;
  practice.speed = parseInt($('practiceTempo').value, 10) || 100;
  practice.hand = $('practiceHand').value || 'all';
  practice.loop = $('practiceLoop').checked;
  practice.active = true;
  practice.cycle = 0;
  practice.hits = 0;
  practice.total = 0;
  practice.wrong = 0;
  practice.early = 0;
  practice.late = 0;
  practice.missed = 0;
  practice.expectedFinalized = false;
  practice.startedAt = Date.now();
  if ($('practiceFeedback')) { $('practiceFeedback').textContent = '等待弹奏反馈'; $('practiceFeedback').className = 'practice-feedback'; }
  practiceUpdate();
  setPill('练习中', 'rec');
  practiceStartCycle();
}

function stopPractice() {
  if (practice.timer) clearTimeout(practice.timer);
  practice.timer = null;
  var wasActive = practice.active;
  if (wasActive) practiceFinalizeCycle();
  practice.active = false;
  practice.expected = [];
  stopAllSound();
  practiceUpdate();
  if (wasActive) practiceSaveSession();
  if (wasActive) setPill(state.deviceName || '已连接', 'on');
}

function setupPractice() {
  if (!$('btnPracticeStart')) return;
  $('practiceTempo').addEventListener('input', function (e) {
    practice.speed = parseInt(e.target.value, 10) || 100;
    practiceUpdate();
  });
  $('practiceHand').addEventListener('change', function (e) { practice.hand = e.target.value; });
  $('practiceLoop').addEventListener('change', function (e) { practice.loop = e.target.checked; });
  $('practiceFull').addEventListener('click', practiceSetFull);
  $('btnPracticeStart').addEventListener('click', startPractice);
  $('btnPracticeStop').addEventListener('click', stopPractice);
  practiceSyncBounds();
  practiceLoadHistory();
}

/* ============================================================
   卷帘
   ============================================================ */
var roll = null, rctx = null;

function fitRoll() {
  roll = $('roll');
  rctx = roll.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  roll.width = Math.floor(roll.clientWidth * dpr);
  roll.height = Math.floor(roll.clientHeight * dpr);
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRoll();
}

// 卷帘布局几何：drawRoll 与命中检测共用同一套坐标，避免两处算法漂移
function rollGeometry() {
  var w = roll.clientWidth, h = roll.clientHeight;
  var top = 22, drawH = h - top - 10;
  var allNotes = state.notes.concat(Object.keys(state.pending).map(function (k) { return state.pending[k]; }));
  var lo = 108, hi = 21;
  allNotes.forEach(function (n) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; });
  lo = Math.max(KEY_LOW, lo - 3);
  hi = Math.min(KEY_HIGH, hi + 3);
  if (hi - lo < 20) {
    var mid = Math.round((hi + lo) / 2);
    lo = Math.max(KEY_LOW, mid - 10);
    hi = Math.min(KEY_HIGH, mid + 10);
  }
  var span = hi - lo + 1;
  var rowH = drawH / span;
  var elapsed = state.recording ? (performance.now() - state.t0) / 1000 : state.lastDur;
  var maxEnd = 0;
  state.notes.forEach(function (n) { if (n.tOff && n.tOff / 1000 > maxEnd) maxEnd = n.tOff / 1000; });
  if (maxEnd > elapsed) elapsed = maxEnd;
  var tMax = Math.max(3, elapsed);
  return { w: w, h: h, top: top, drawH: drawH, lo: lo, hi: hi, span: span, rowH: rowH, elapsed: elapsed, tMax: tMax };
}

function noteRect(n, geo) {
  var t0 = n.tOn / 1000;
  var t1 = n.tOff !== null ? n.tOff / 1000 : geo.elapsed;
  var x0 = (t0 / geo.tMax) * geo.w;
  var x1 = (t1 / geo.tMax) * geo.w;
  var y = geo.top + geo.drawH - (n.pitch - geo.lo + 1) * geo.rowH;
  return { x0: x0, x1: x1, y: y, hh: Math.max(3, geo.rowH - 0.6) };
}

function drawRoll() {
  if (!rctx) return;
  var geo = rollGeometry();
  rctx.clearRect(0, 0, geo.w, geo.h);

  if (!state.notes.length && !state.recording) {
    // 空状态：居中提示 + 一圈虚线，避免大片空白显得像没加载出来
    rctx.strokeStyle = uiPick('#e9efea', '#2a312e');
    rctx.lineWidth = 1;
    rctx.setLineDash([6, 6]);
    rctx.strokeRect(10.5, 10.5, Math.max(0, geo.w - 21), Math.max(0, geo.h - 21));
    rctx.setLineDash([]);
    rctx.fillStyle = '#8c988f';
    rctx.font = '13px system-ui, sans-serif';
    rctx.textAlign = 'center';
    rctx.fillText('录一段，这里会显示音符（点击可编辑）', geo.w / 2, geo.h / 2);
    rctx.textAlign = 'start';
    return;
  }

  rctx.strokeStyle = uiPick('#eeede7', '#2b3531');
  rctx.lineWidth = 1;
  for (var p = geo.lo; p <= geo.hi; p++) {
    if (p % 12 === 0) {
      var gy = geo.top + geo.drawH - (p - geo.lo + 1) * geo.rowH;
      rctx.beginPath();
      rctx.moveTo(0, Math.round(gy) + 0.5);
      rctx.lineTo(geo.w, Math.round(gy) + 0.5);
      rctx.stroke();
    }
  }

  rctx.fillStyle = '#b6b5ad';
  rctx.font = '11px system-ui, sans-serif';
  rctx.strokeStyle = uiPick('#e6e5de', '#333d38');
  for (var s = 0; s <= Math.ceil(geo.tMax); s++) {
    var sx = (s / geo.tMax) * geo.w;
    rctx.beginPath();
    rctx.moveTo(Math.round(sx) + 0.5, geo.top - 6);
    rctx.lineTo(Math.round(sx) + 0.5, geo.h);
    rctx.stroke();
    if (s % Math.max(1, Math.ceil(geo.tMax / 8)) === 0) {
      rctx.fillText(s + 's', sx + 3, 12);
    }
  }

  state.notes.forEach(function (n, i) {
    var r = noteRect(n, geo);
    var v = n.vel / 127;
    var selected = i === noteEdit.selected;
    rctx.fillStyle = selected ? '#0f6e56' : ('rgba(15,110,86,' + (0.2 + v * 0.75).toFixed(2) + ')');
    rctx.fillRect(r.x0, r.y, Math.max(2, r.x1 - r.x0), r.hh);
    if (selected) {
      rctx.strokeStyle = uiPick('#0a4f3c', '#7fe0c0');
      rctx.lineWidth = 1.5;
      rctx.strokeRect(r.x0 + 0.5, r.y + 0.5, Math.max(2, r.x1 - r.x0) - 1, r.hh - 1);
      rctx.fillStyle = '#0a4f3c';
      rctx.fillRect(r.x1 - 2.5, r.y, 5, r.hh);
    }
  });

  if (state.playing && actx) {
    var now = actx.currentTime - state.playStart;
    if (now >= 0) {
      var px = (now / geo.tMax) * geo.w;
      rctx.strokeStyle = uiPick('#c2453f', '#e0706a');
      rctx.lineWidth = 1.5;
      rctx.beginPath();
      rctx.moveTo(px, geo.top - 6);
      rctx.lineTo(px, geo.h);
      rctx.stroke();
    }
  }
}

/* ============================================================
   MIDI 音符编辑器
   ============================================================ */
var noteEdit = { selected: -1, undo: [], redo: [], drag: null };
var velDragStart = null;

function noteNameOf(p) {
  return SHARP[p % 12] + (Math.floor(p / 12) - 1);
}

function noteSnapshot() {
  return state.notes.map(function (n) { return { pitch: n.pitch, vel: n.vel, tOn: n.tOn, tOff: n.tOff }; });
}

function noteRestore(snap) {
  state.notes = snap.map(function (n) { return { pitch: n.pitch, vel: n.vel, tOn: n.tOn, tOff: n.tOff }; });
}

function selectedNoteRef() {
  return noteEdit.selected >= 0 && noteEdit.selected < state.notes.length ? state.notes[noteEdit.selected] : null;
}

function afterNoteEdit() {
  buildScore();
  renderAll();
  $('mNotes').textContent = state.notes.length;
  practiceSyncBounds();
  scheduleSave();
  updateNoteTools();
}

function updateNoteTools() {
  var sel = selectedNoteRef();
  var info = $('noteSel'), vel = $('noteVel'), velVal = $('noteVelVal');
  if (sel) {
    var dur = (sel.tOff - sel.tOn) / 1000;
    info.textContent = noteNameOf(sel.pitch) + ' · 力度 ' + sel.vel + ' · 起 ' + (sel.tOn / 1000).toFixed(2) + 's · 长 ' + dur.toFixed(2) + 's';
    vel.disabled = false;
    vel.value = sel.vel;
    velVal.textContent = sel.vel;
    $('noteDel').disabled = false;
  } else {
    info.textContent = state.notes.length ? '未选中（点卷帘里的音符）' : '没有音符可编辑';
    vel.disabled = true;
    velVal.textContent = '—';
    $('noteDel').disabled = true;
  }
  $('noteUndo').disabled = !noteEdit.undo.length;
  $('noteRedo').disabled = !noteEdit.redo.length;
  var any = state.notes.length > 0;
  ['noteDown', 'noteUp', 'noteOctDown', 'noteOctUp', 'noteQuant'].forEach(function (id) { $(id).disabled = !any; });
}

function notePushUndo(snap) {
  noteEdit.undo.push(snap || noteSnapshot());
  if (noteEdit.undo.length > 50) noteEdit.undo.shift();
  noteEdit.redo.length = 0;
  updateNoteTools();
}

function noteUndo() {
  if (!noteEdit.undo.length) return;
  noteEdit.redo.push(noteSnapshot());
  noteRestore(noteEdit.undo.pop());
  noteEdit.selected = -1;
  afterNoteEdit();
}

function noteRedo() {
  if (!noteEdit.redo.length) return;
  noteEdit.undo.push(noteSnapshot());
  noteRestore(noteEdit.redo.pop());
  noteEdit.selected = -1;
  afterNoteEdit();
}

function selectNote(idx) {
  if (idx >= 0 && idx >= state.notes.length) idx = -1;
  noteEdit.selected = idx;
  velDragStart = null;
  updateNoteTools();
  drawRoll();
}

function deleteSelectedNote() {
  if (noteEdit.selected < 0) return;
  notePushUndo();
  state.notes.splice(noteEdit.selected, 1);
  noteEdit.selected = -1;
  afterNoteEdit();
}

function transposeNotes(semitones) {
  var sel = selectedNoteRef();
  var targets = sel ? [sel] : state.notes;
  var any = false;
  for (var i = 0; i < targets.length; i++) {
    var np = targets[i].pitch + semitones;
    if (np >= KEY_LOW && np <= KEY_HIGH) { any = true; break; }
  }
  if (!any) return;
  notePushUndo();
  for (var j = 0; j < targets.length; j++) {
    var npp = targets[j].pitch + semitones;
    if (npp >= KEY_LOW && npp <= KEY_HIGH) targets[j].pitch = npp;
  }
  afterNoteEdit();
}

function quantizeNotes() {
  if (!state.notes.length) return;
  notePushUndo();
  var spb = 60 / state.bpm;
  var gb = 1 / state.gridDiv;
  state.notes.forEach(function (n) {
    var s = Math.round((n.tOn / 1000 / spb) / gb) * gb;
    var e = Math.round((n.tOff / 1000 / spb) / gb) * gb;
    if (e <= s) e = s + gb;
    n.tOn = s * spb * 1000;
    n.tOff = e * spb * 1000;
  });
  afterNoteEdit();
}

function hitTestNote(x, y) {
  var geo = rollGeometry();
  for (var i = state.notes.length - 1; i >= 0; i--) {
    var r = noteRect(state.notes[i], geo);
    if (y < r.y || y > r.y + r.hh) continue;
    if (x >= r.x1 - 8 && x <= r.x1 + 3) return { idx: i, mode: 'resize' };
    if (x >= r.x0 && x <= r.x1) return { idx: i, mode: 'move' };
  }
  return null;
}

function rollMousePos(e) {
  var rect = roll.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function finishNoteDrag(e) {
  if (!noteEdit.drag) return;
  var o = noteEdit.drag.orig;
  var n = state.notes[noteEdit.drag.idx];
  var snap = noteEdit.drag.snap;
  noteEdit.drag = null;
  if (n.pitch !== o.pitch || Math.abs(n.tOn - o.tOn) > 1 || Math.abs(n.tOff - o.tOff) > 1) {
    notePushUndo(snap);
    afterNoteEdit();
  } else {
    drawRoll();
  }
  if (e && e.pointerId !== undefined) {
    try { roll.releasePointerCapture(e.pointerId); } catch (err) {}
  }
}

function setupNoteEditor() {
  roll.addEventListener('pointerdown', function (e) {
    if (state.recording) return;
    e.preventDefault();
    var pos = rollMousePos(e);
    var hit = hitTestNote(pos.x, pos.y);
    if (!hit) { selectNote(-1); return; }
    selectNote(hit.idx);
    var n = state.notes[hit.idx];
    noteEdit.drag = {
      mode: hit.mode, idx: hit.idx,
      startX: pos.x, startY: pos.y,
      orig: { pitch: n.pitch, tOn: n.tOn, tOff: n.tOff },
      snap: noteSnapshot()
    };
    try { roll.setPointerCapture(e.pointerId); } catch (err) {}
  });

  roll.addEventListener('pointermove', function (e) {
    if (noteEdit.drag) {
      var dragPos = rollMousePos(e);
      var geo = rollGeometry();
      var dn = state.notes[noteEdit.drag.idx];
      var dOrig = noteEdit.drag.orig;
      if (noteEdit.drag.mode === 'move') {
        var dTime = ((dragPos.x - noteEdit.drag.startX) / geo.w) * geo.tMax * 1000;
        dn.tOn = Math.max(0, dOrig.tOn + dTime);
        var dPitch = Math.round((noteEdit.drag.startY - dragPos.y) / geo.rowH);
        dn.pitch = Math.min(KEY_HIGH, Math.max(KEY_LOW, dOrig.pitch + dPitch));
      } else {
        var dTime2 = ((dragPos.x - noteEdit.drag.startX) / geo.w) * geo.tMax * 1000;
        dn.tOff = Math.max(dn.tOn + 30, dOrig.tOff + dTime2);
      }
      drawRoll();
      return;
    }
    if (state.recording) { roll.style.cursor = 'default'; return; }
    var pos = rollMousePos(e);
    var hit = hitTestNote(pos.x, pos.y);
    roll.style.cursor = hit ? (hit.mode === 'resize' ? 'ew-resize' : 'move') : 'default';
  });

  roll.addEventListener('pointerup', finishNoteDrag);
  roll.addEventListener('pointercancel', finishNoteDrag);

  $('noteDown').addEventListener('click', function () { transposeNotes(-1); });
  $('noteUp').addEventListener('click', function () { transposeNotes(1); });
  $('noteOctDown').addEventListener('click', function () { transposeNotes(-12); });
  $('noteOctUp').addEventListener('click', function () { transposeNotes(12); });
  $('noteQuant').addEventListener('click', function () { quantizeNotes(); });
  $('noteDel').addEventListener('click', function () { deleteSelectedNote(); });
  $('noteUndo').addEventListener('click', function () { noteUndo(); });
  $('noteRedo').addEventListener('click', function () { noteRedo(); });

  $('noteVel').addEventListener('input', function (e) {
    var sel = selectedNoteRef();
    if (!sel) return;
    if (velDragStart === null) velDragStart = noteSnapshot();
    sel.vel = parseInt(e.target.value, 10);
    $('noteVelVal').textContent = sel.vel;
    drawRoll();
  });
  $('noteVel').addEventListener('change', function () {
    if (velDragStart === null) return;
    noteEdit.undo.push(velDragStart);
    if (noteEdit.undo.length > 50) noteEdit.undo.shift();
    noteEdit.redo.length = 0;
    velDragStart = null;
    afterNoteEdit();
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && noteEdit.selected >= 0) {
      e.preventDefault();
      deleteSelectedNote();
    }
  });

  updateNoteTools();
}

/* ============================================================
   制谱分析：量化 → 和弦 → 小节
   ============================================================ */
var score = null;

var NOTE_DURS = [
  { b: 4, d: 'w' }, { b: 3, d: 'h', dot: 1 }, { b: 2, d: 'h' },
  { b: 1.5, d: 'q', dot: 1 }, { b: 1, d: 'q' },
  { b: 0.75, d: '8', dot: 1 }, { b: 0.5, d: '8' }, { b: 0.25, d: '16' }
];
var REST_DURS = [{ b: 4, d: 'w' }, { b: 2, d: 'h' }, { b: 1, d: 'q' }, { b: 0.5, d: '8' }, { b: 0.25, d: '16' }];

function decompose(len, table) {
  var out = [], left = len;
  while (left > 0.001) {
    var hit = null;
    for (var i = 0; i < table.length; i++) {
      if (table[i].b <= left + 0.001) { hit = table[i]; break; }
    }
    if (!hit) break;
    out.push(hit);
    left -= hit.b;
  }
  return out;
}

function snapDown(len) {
  for (var i = 0; i < NOTE_DURS.length; i++) {
    if (NOTE_DURS[i].b <= len + 0.001) return NOTE_DURS[i];
  }
  return NOTE_DURS[NOTE_DURS.length - 1];
}

function syncBpmLabel() {
  var el = $('mBpm');
  if (el) el.textContent = state.bpm;
}

function estimateTempo() {
  var starts = state.notes.map(function (n) { return n.tOn; }).sort(function (a, b) { return a - b; });
  if (starts.length < 4) return;
  var gaps = [];
  for (var i = 1; i < starts.length; i++) {
    var g = starts[i] - starts[i - 1];
    if (g > 60 && g < 3000) gaps.push(g);
  }
  if (!gaps.length) return;
  gaps.sort(function (a, b) { return a - b; });
  var med = gaps[Math.floor(gaps.length / 2)];
  var bpm = Math.round(60000 / med);
  while (bpm > 180) bpm = Math.round(bpm / 2);
  while (bpm < 50) bpm = Math.round(bpm * 2);
  if (bpm >= 50 && bpm <= 200) {
    state.bpm = bpm;
    $('bpm').value = bpm;
    $('bpmVal').textContent = bpm;
    syncBpmLabel();
  }
}

function detectKey(list) {
  var src = list || state.notes;
  var hist = new Array(12).fill(0);
  src.forEach(function (n) {
    hist[n.pitch % 12] += Math.max(0.2, (n.tOff - n.tOn) / 1000);
  });
  var bestTonic = 0, bestMode = 'major', bestScore = -1;
  for (var t = 0; t < 12; t++) {
    var scMaj = 0, scMin = 0;
    for (var pc = 0; pc < 12; pc++) {
      var rel = (pc - t + 12) % 12;
      scMaj += hist[pc] * MAJOR_PROFILE[rel];
      scMin += hist[pc] * MINOR_PROFILE[rel];
    }
    if (scMaj > bestScore) { bestScore = scMaj; bestTonic = t; bestMode = 'major'; }
    if (scMin > bestScore) { bestScore = scMin; bestTonic = t; bestMode = 'minor'; }
  }
  return { tonicPc: bestTonic, mode: bestMode };
}

function keyInfoFor(tonicPc, mode) {
  mode = mode || 'major';
  // 小调的调号与关系大调相同，拼写也沿用关系大调
  var sigTonic = mode === 'minor' ? (tonicPc + 3) % 12 : tonicPc;

  var TONIC_LETTER = [0,0,1,2,2,3,3,4,5,5,6,6];
  var startLetter = TONIC_LETTER[sigTonic];
  var letters = [];
  for (var k = 0; k < 7; k++) letters.push(LETTERS[(startLetter + k) % 7]);

  var scaleOff = [0, 2, 4, 5, 7, 9, 11];
  var spelling = {};

  for (var j = 0; j < 7; j++) {
    var pc = (sigTonic + scaleOff[j]) % 12;
    var letter = letters[j];
    var base = LETTER_PC[letter];
    var acc = ((pc - base) % 12 + 12) % 12;
    var accSym = (acc === 0) ? 0 : (acc === 11 ? -1 : 1);
    spelling[pc] = { letter: letter, acc: accSym };
  }

  var SIG_BY_TONIC = { 0:0, 7:1, 2:2, 9:3, 4:4, 11:5, 6:6, 5:-1, 10:-2, 3:-3, 8:-4, 1:-5 };
  var sig = SIG_BY_TONIC[sigTonic];
  if (sig === undefined) sig = 0;

  // 调外音按调号方向取等音拼写。
  // 原来用「下方音级 + 一个升号」推导，F# / C# 调会得到重升号，
  // 而渲染层只支持 ±1 个升降号，重升会被当成还原音，音高整体错位。
  var SHARP_SPELL = [
    { letter:'c', acc:0 }, { letter:'c', acc:1 }, { letter:'d', acc:0 }, { letter:'d', acc:1 },
    { letter:'e', acc:0 }, { letter:'f', acc:0 }, { letter:'f', acc:1 }, { letter:'g', acc:0 },
    { letter:'g', acc:1 }, { letter:'a', acc:0 }, { letter:'a', acc:1 }, { letter:'b', acc:0 }
  ];
  var FLAT_SPELL = [
    { letter:'c', acc:0 }, { letter:'d', acc:-1 }, { letter:'d', acc:0 }, { letter:'e', acc:-1 },
    { letter:'e', acc:0 }, { letter:'f', acc:0 }, { letter:'g', acc:-1 }, { letter:'g', acc:0 },
    { letter:'a', acc:-1 }, { letter:'a', acc:0 }, { letter:'b', acc:-1 }, { letter:'b', acc:0 }
  ];
  var chrom = sig >= 0 ? SHARP_SPELL : FLAT_SPELL;

  for (var pc2 = 0; pc2 < 12; pc2++) {
    if (spelling[pc2]) continue;
    spelling[pc2] = { letter: chrom[pc2].letter, acc: chrom[pc2].acc };
  }

  return {
    tonicPc: tonicPc,
    tonicMidi: 60 + tonicPc,
    mode: mode,
    sig: sig,
    sigName: KEY_SIG_NAME[String(sig)] || 'C',
    spelling: spelling
  };
}

function keyDisplayName(ki) {
  var sp = ki.spelling[ki.tonicPc] || { letter: 'c', acc: 0 };
  var letter = sp.letter;
  var accStr = sp.acc === 1 ? '#' : (sp.acc === -1 ? 'b' : '');
  var name = (ki.mode === 'minor' ? letter : letter.toUpperCase()) + accStr;
  return name + (ki.mode === 'minor' ? ' 小调' : ' 大调');
}

function vexKey(pitch, ki) {
  var pc = pitch % 12;
  var sp = ki.spelling[pc];
  var letter = sp ? sp.letter : 'c';
  var acc = sp ? sp.acc : 0;
  var accStr = acc === 1 ? '#' : (acc === -1 ? 'b' : '');
  return letter + accStr + '/' + (Math.floor(pitch / 12) - 1);
}

function buildScore() {
  var src = state.notes.slice();
  if (state.recording) {
    var nowT = performance.now() - state.t0;
    Object.keys(state.pending).forEach(function (k) {
      var p = state.pending[k];
      src.push({ pitch: p.pitch, vel: p.vel, tOn: p.tOn, tOff: Math.max(nowT, p.tOn + 90) });
    });
  }
  if (!src.length) { score = null; return null; }

  var bpm = state.bpm;
  var spb = 60 / bpm;
  var gb = 1 / state.gridDiv;

  var keyRes = state.keyOverride === 'auto' ? detectKey(src) : { tonicPc: parseInt(state.keyOverride, 10), mode: 'major' };
  var ki = keyInfoFor(keyRes.tonicPc, keyRes.mode);

  var sigParts = (state.timeSig || '4/4').split('/');
  var sigNum = parseInt(sigParts[0], 10) || 4;
  var sigDen = parseInt(sigParts[1], 10) || 4;
  var barLen = sigNum * 4 / sigDen;

  function chordsFor(staffTest) {
    var map = {};
    src.forEach(function (n) {
      if (!staffTest(n.pitch)) return;
      var s = Math.round((n.tOn / 1000 / spb) / gb) * gb;
      var e = Math.round((n.tOff / 1000 / spb) / gb) * gb;
      if (e <= s) e = s + gb;
      var k = s.toFixed(3);
      if (!map[k]) map[k] = { s: s, e: e, pitches: [] };
      map[k].pitches.push(n.pitch);
      if (e > map[k].e) map[k].e = e;
    });
    var list = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.s - b.s; });
    for (var i = 0; i < list.length; i++) {
      var next = i + 1 < list.length ? list[i + 1].s : 1e9;
      // 保留真实时长（可跨小节），只按下一个和弦起点截断以避免重叠
      var dur = Math.min(list[i].e - list[i].s, next - list[i].s);
      list[i].dur = dur > 0 ? dur : gb;
    }
    return list;
  }

  function measures(list) {
    var maxEnd = 0;
    list.forEach(function (c) { var e = c.s + c.dur; if (e > maxEnd) maxEnd = e; });
    var nMeas = Math.max(1, Math.ceil(maxEnd / barLen));
    var out = [], ci = 0, carry = [], tieCounter = 0;
    for (var m = 0; m < nMeas; m++) {
      var items = [];
      var cursor = m * barLen;

      // 先处理上一小节延续过来的延音（跨小节 tie 的续段）
      var newCarry = [];
      carry.forEach(function (cc) {
        var remain = (m + 1) * barLen - cursor;
        var d = Math.min(cc.dur, remain);
        var sd = snapDown(d);
        items.push({ rest: false, b: sd.b, d: sd.d, dot: sd.dot || 0, tie: true, tieId: cc.tieId, pitches: cc.pitches.slice() });
        cursor += sd.b;
        if (cc.dur > remain + 0.001) {
          newCarry.push({ pitches: cc.pitches, dur: cc.dur - sd.b, tieId: cc.tieId });
        }
      });
      carry = newCarry;

      var guard = 0;
      while (ci < list.length && list[ci].s < (m + 1) * barLen && guard++ < 64) {
        var c = list[ci];
        if (c.s < cursor) { ci++; continue; }
        if (c.s > cursor + 0.001) {
          decompose(c.s - cursor, REST_DURS).forEach(function (r) {
            items.push({ rest: true, b: r.b, d: r.d });
          });
          cursor = c.s;
        }
        var remain = (m + 1) * barLen - cursor;
        var d = Math.min(c.dur, remain);
        var sd = snapDown(d);
        var item = { rest: false, b: sd.b, d: sd.d, dot: sd.dot || 0, pitches: c.pitches.slice().sort(function (a, b) { return a - b; }) };
        if (c.dur > remain + 0.001) {
          item.tie = true;
          item.tieId = ++tieCounter;
          carry.push({ pitches: c.pitches, dur: c.dur - sd.b, tieId: item.tieId });
        }
        items.push(item);
        cursor += sd.b;
        ci++;
      }
      var left = (m + 1) * barLen - cursor;
      if (left > 0.001) {
        decompose(left, REST_DURS).forEach(function (r) {
          items.push({ rest: true, b: r.b, d: r.d });
        });
      }
      out.push(items);
    }
    return out;
  }

  var treble = measures(chordsFor(function (p) { return p >= 60; }));
  var bass = measures(chordsFor(function (p) { return p < 60; }));

  var n = Math.max(treble.length, bass.length);
  function padMeasure() {
    return decompose(barLen, REST_DURS).map(function (r) {
      return { rest: true, b: r.b, d: r.d };
    });
  }
  while (treble.length < n) treble.push(padMeasure());
  while (bass.length < n) bass.push(padMeasure());

  score = { treble: treble, bass: bass, n: n, key: ki, bpm: bpm, sig: sigNum + '/' + sigDen };
  return score;
}

/* ============================================================
   五线谱（VexFlow）
   ============================================================ */
function renderStaff() {
  var host = $('staffHost');
  host.innerHTML = '';

  if (!window.Vex || !window.Vex.Flow) {
    host.innerHTML = '<p class="empty">乐谱库没有加载成功，检查 lib/vexflow.js 是否存在。</p>';
    return;
  }
  if (!score) {
    host.innerHTML = '<p class="empty">录一段，这里会生成五线谱</p>';
    return;
  }

  var per = 3;
  var width = Math.max(720, host.clientWidth || 720);
  var systems = Math.ceil(score.n / per);
  var sysH = 212;
  var height = systems * sysH + 18;

  var renderer, ctx;
  try {
    renderer = new Vex.Flow.Renderer(host, Vex.Flow.Renderer.Backends.SVG);
    renderer.resize(width, height);
    ctx = renderer.getContext();
  } catch (e) {
    host.innerHTML = '<p class="empty">乐谱渲染器初始化失败：' + e.message + '</p>';
    return;
  }

  var allTiesT = [], allTiesB = [];
  for (var s = 0; s < systems; s++) {
    var yTop = s * sysH + 18;
    var yBot = yTop + 104;

    var cols = Math.min(per, score.n - s * per);
    var mw = (width - 24) / cols;

    for (var m = 0; m < cols; m++) {
      var idx = s * per + m;
      if (idx >= score.n) break;

      var x = 12 + m * mw;

      var tStave = new Vex.Flow.Stave(x, yTop, mw);
      var bStave = new Vex.Flow.Stave(x, yBot, mw);

      if (m === 0) {
        tStave.addClef('treble');
        bStave.addClef('bass');
      }
      if (idx === 0) {
        tStave.addTimeSignature(score.sig || '4/4');
        bStave.addTimeSignature(score.sig || '4/4');
        if (score.key.sigName !== 'C') {
          try { tStave.addKeySignature(score.key.sigName); bStave.addKeySignature(score.key.sigName); } catch (e) {}
        }
      }

      tStave.setContext(ctx).draw();
      bStave.setContext(ctx).draw();

      try {
        var r = drawMeasure(ctx, tStave, bStave, score.treble[idx], score.bass[idx], score.key);
        allTiesT = allTiesT.concat(r.treble);
        allTiesB = allTiesB.concat(r.bass);
      } catch (e2) {
        console.warn('measure draw failed', idx, e2);
      }
    }
  }
  drawTies(ctx, allTiesT);
  drawTies(ctx, allTiesB);
}

function drawMeasure(ctx, tStave, bStave, tItems, bItems, ki) {
  var tt = drawVoice(ctx, tStave, tItems, 'treble', ki);
  var bt = drawVoice(ctx, bStave, bItems, 'bass', ki);
  return { treble: tt || [], bass: bt || [] };
}

function drawVoice(ctx, stave, items, clef, ki) {
  var notes = [];
  var ties = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.rest) {
      notes.push(new Vex.Flow.StaveNote({
        clef: clef,
        keys: [clef === 'treble' ? 'b/4' : 'd/3'],
        duration: it.d + 'r'
      }));
    } else {
      var keys = it.pitches.map(function (p) { return vexKey(p, ki); });
      // dots 必须在构造时传入：事后 buildAndAttach 只画符头，不会计入 tick，
      // 结果是每出现一个附点音符，小节就少算半拍。
      var sn = new Vex.Flow.StaveNote({
        clef: clef,
        keys: keys,
        duration: it.d,
        dots: it.dot || 0,
        auto_stem: true
      });
      notes.push(sn);
      if (it.tie) ties.push({ tieId: it.tieId, note: sn, nKeys: it.pitches.length });
    }
  }
  if (!notes.length) return ties;

  var sigP = (score.sig || '4/4').split('/');
  var voice = new Vex.Flow.Voice({
    num_beats: parseInt(sigP[0], 10) || 4,
    beat_value: parseInt(sigP[1], 10) || 4
  });
  voice.setStrict(false);
  voice.addTickables(notes);

  try {
    if (Vex.Flow.Accidental && Vex.Flow.Accidental.applyAccidentals) {
      Vex.Flow.Accidental.applyAccidentals([voice], ki.sigName === 'F#' ? 'F#' : ki.sigName);
    }
  } catch (e) {}

  var beams = null;
  try {
    var sigG = (score.sig || '4/4').split('/');
    var grp = (parseInt(sigG[1], 10) === 8)
      ? [new Vex.Flow.Fraction(3, 8)]
      : [new Vex.Flow.Fraction(2, 8)];
    beams = Vex.Flow.Beam.generateBeams(notes, {
      beam_rests: false,
      maintain_stem_directions: false,
      groups: grp
    });
    beams.forEach(function (b) { b.setContext(ctx); });
  } catch (e) {
    beams = null;
  }

  var fmt = new Vex.Flow.Formatter();
  fmt.joinVoices([voice]).format([voice], stave.getWidth() - 34);
  voice.draw(ctx, stave);

  if (beams) {
    for (var gi = 0; gi < beams.length; gi++) {
      try { beams[gi].draw(); } catch (e) {}
    }
  }
  return ties;
}

// 按 tieId 分组，链内相邻音符两两连延音线
function drawTies(ctx, tieList) {
  var groups = {};
  tieList.forEach(function (t) {
    if (!groups[t.tieId]) groups[t.tieId] = [];
    groups[t.tieId].push(t);
  });
  Object.keys(groups).forEach(function (id) {
    var arr = groups[id];
    for (var i = 0; i + 1 < arr.length; i++) {
      try {
        var idx = [];
        for (var k = 0; k < arr[i].nKeys; k++) idx.push(k);
        var idx2 = [];
        for (var k2 = 0; k2 < arr[i + 1].nKeys; k2++) idx2.push(k2);
        new Vex.Flow.StaveTie({
          first_note: arr[i].note,
          last_note: arr[i + 1].note,
          first_indices: idx,
          last_indices: idx2
        }).setContext(ctx).draw();
      } catch (e) {}
    }
  });
}

/* ============================================================
   简谱
   ============================================================ */
function renderJianpu() {
  var host = $('jianpuHost');
  host.innerHTML = '';

  if (!score) {
    host.innerHTML = '<p class="empty">录一段，这里会生成简谱</p>';
    return;
  }

  var ki = score.key;
  var scaleOff = [0, 2, 4, 5, 7, 9, 11];
  var wrap = document.createElement('div');
  wrap.className = 'jp-wrap';

  function degreeOf(pitch) {
    var rel = pitch - ki.tonicMidi;
    var oct = Math.floor(rel / 12);
    var off = rel - oct * 12;
    for (var d = 0; d < 7; d++) {
      if (scaleOff[d] === off) return { digit: d + 1, acc: '', oct: oct };
    }
    for (var d2 = 6; d2 >= 0; d2--) {
      if (scaleOff[d2] < off) return { digit: d2 + 1, acc: '#', oct: oct };
    }
    return { digit: 1, acc: '', oct: oct };
  }

  // 把一条声部渲染进一行，返回这一行是否有实际音符
  function emit(items, row) {
    var hasNote = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var el = document.createElement('div');
      el.className = 'jp-item';

      if (it.rest) {
        el.innerHTML = '<span class="jp-dots-top">&nbsp;</span><span class="jp-rest">0</span><span class="jp-dots-bot">&nbsp;</span>';
        if (it.b >= 2) el.innerHTML += '<span class="jp-hold">' + new Array(Math.round(it.b)).join('– ') + '</span>';
      } else {
        hasNote = true;
        var inner = document.createElement('div');
        inner.className = 'jp-chord jp-inner';
        if (it.tie) el.classList.add('jp-tie');

        it.pitches.forEach(function (p) {
          var info = degreeOf(p);
          var line = document.createElement('span');
          line.className = 'jp-num';
          line.textContent = (info.acc || '') + info.digit;
          var holder = document.createElement('div');
          holder.style.display = 'flex';
          holder.style.flexDirection = 'column';
          holder.style.alignItems = 'center';

          var top = document.createElement('span');
          top.className = 'jp-dots-top';
          top.textContent = info.oct > 0 ? new Array(info.oct + 1).join('·') : '\u00a0';

          var bot = document.createElement('span');
          bot.className = 'jp-dots-bot';
          bot.textContent = info.oct < 0 ? new Array(-info.oct + 1).join('·') : '\u00a0';

          holder.appendChild(top);
          holder.appendChild(line);
          holder.appendChild(bot);
          inner.appendChild(holder);
        });

        if (it.b < 1) {
          inner.classList.add(it.b <= 0.25 ? 'jp-u2' : 'jp-u1');
        }

        el.appendChild(inner);

        if (it.b >= 2) {
          var hold = document.createElement('span');
          hold.className = 'jp-hold';
          hold.textContent = it.b >= 4 ? '– – –' : (it.b >= 3 ? '– –' : '–');
          el.appendChild(hold);
        }
        if (it.dot) {
          var dotEl = document.createElement('span');
          dotEl.className = 'jp-hold';
          dotEl.textContent = '·';
          el.appendChild(dotEl);
        }
      }
      row.appendChild(el);
    }
    return hasNote;
  }

  for (var m = 0; m < score.n; m++) {
    var meas = document.createElement('div');
    meas.className = 'jp-measure';

    var tRow = document.createElement('div');
    tRow.className = 'jp-row';
    emit(score.treble[m] || [], tRow);

    var bRow = document.createElement('div');
    bRow.className = 'jp-row bass';
    var bHas = emit(score.bass[m] || [], bRow);

    meas.appendChild(tRow);
    if (bHas) meas.appendChild(bRow);
    wrap.appendChild(meas);
  }

  host.appendChild(wrap);
  var note = document.createElement('p');
  note.className = 'notation-note';
  note.textContent = '调性：' + keyDisplayName(ki) + '　速度：' + score.bpm + ' BPM　网格：1/' + (state.gridDiv * 4);
  host.appendChild(note);
}

/* ============================================================
   视图切换与刷新
   ============================================================ */
function renderAll() {
  if (!score) buildScore();
  drawRoll();
  drawWave();
  renderStaff();
  renderJianpu();
  updateMini();
  updateNoteTools();
  updateScoreExportButtons();
}

/* ============================================================
   导出
   ============================================================ */
function stamp() {
  var d = new Date();
  var p = function (x) { return (x < 10 ? '0' : '') + x; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function download(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function scoreXmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreExportName(value) {
  return String(value || 'piano_score').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'piano_score';
}

function scoreCssText() {
  var out = '';
  for (var i = 0; i < document.styleSheets.length; i++) {
    try {
      var rules = document.styleSheets[i].cssRules || [];
      for (var j = 0; j < rules.length; j++) out += rules[j].cssText + '\n';
    } catch (e) {}
  }
  return out;
}

function exportScoreHostPng(hostId, suffix) {
  var host = $(hostId);
  if (!host || !state.notes.length || host.querySelector('.empty')) {
    alert('还没有可导出的谱面。先录一段或载入 MIDI。');
    return;
  }
  var rect = host.getBoundingClientRect();
  var width = Math.max(640, Math.ceil(host.scrollWidth || rect.width || 640));
  var height = Math.max(180, Math.ceil(host.scrollHeight || rect.height || 180));
  var title = $('scoreTitle').value.trim() || 'PIANO STUDIO 乐谱';
  var author = $('scoreAuthor').value.trim();
  var top = 58;
  var clone = host.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  clone.style.width = width + 'px';
  clone.style.height = height + 'px';
  var serialized = new XMLSerializer().serializeToString(clone);
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + width + '" height="' + (height + top) + '">' +
    '<style>' + scoreCssText() + '</style>' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    '<text x="24" y="26" font-family="system-ui, sans-serif" font-size="18" font-weight="600" fill="#1e2925">' + scoreXmlEscape(title) + '</text>' +
    (author ? '<text x="24" y="46" font-family="system-ui, sans-serif" font-size="11" fill="#66716b">' + scoreXmlEscape(author) + '</text>' : '') +
    '<foreignObject x="0" y="' + top + '" width="' + width + '" height="' + height + '">' + serialized + '</foreignObject></svg>';
  var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  var img = new Image();
  img.onload = function () {
    var scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil((height + top) * scale);
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height + top);
    URL.revokeObjectURL(url);
    canvas.toBlob(function (blob) {
      if (blob) download(blob, scoreExportName(title) + '_' + suffix + '.png');
    }, 'image/png');
  };
  img.onerror = function () {
    URL.revokeObjectURL(url);
    alert('谱面图片生成失败，请改用“打印 / 保存 PDF”。');
  };
  img.src = url;
}

function updatePrintHeading() {
  var title = $('scoreTitle') ? $('scoreTitle').value.trim() : '';
  var author = $('scoreAuthor') ? $('scoreAuthor').value.trim() : '';
  $('printHeadingTitle').textContent = title || 'PIANO STUDIO 乐谱';
  $('printHeadingAuthor').textContent = author;
}

function updateScoreExportButtons() {
  var ready = !!state.notes.length && !!score;
  ['btnStaffPng', 'btnJianpuPng', 'btnPrintScore'].forEach(function (id) {
    if ($(id)) $(id).disabled = !ready;
  });
  updatePrintHeading();
}

function printScore() {
  if (!state.notes.length || !score) {
    alert('还没有可打印的谱面。先录一段或载入 MIDI。');
    return;
  }
  updatePrintHeading();
  document.body.classList.add('printing-score');
  setTimeout(function () { window.print(); }, 50);
}

window.addEventListener('afterprint', function () {
  document.body.classList.remove('printing-score');
});

function varlen(n) {
  var out = [n & 0x7F];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7F) | 0x80); n >>= 7; }
  return out;
}

function parseMidiData(input) {
  var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  var pos = 0;
  function need(n) { if (pos + n > bytes.length) throw new Error('MIDI 文件被截断'); }
  function u16() { need(2); var v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; }
  function u32() { need(4); var v = bytes[pos] * 0x1000000 + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; return v; }
  function text(data) {
    var out = '';
    for (var i = 0; i < data.length; i++) out += data[i] >= 32 ? String.fromCharCode(data[i]) : ' ';
    return out.replace(/\s+/g, ' ').trim();
  }
  function vlq(at) {
    var value = 0, count = 0, b;
    do {
      if (at >= bytes.length || count++ > 4) throw new Error('MIDI 可变长度字段无效');
      b = bytes[at++];
      value = (value << 7) | (b & 0x7F);
    } while (b & 0x80);
    return { value: value, next: at };
  }
  function ascii4(a, b, c, d) { return String.fromCharCode(a, b, c, d); }

  need(14);
  if (ascii4(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') throw new Error('不是标准 MIDI 文件');
  pos = 4;
  var headerLen = u32();
  if (headerLen < 6) throw new Error('MIDI 文件头无效');
  var format = u16();
  var trackCount = u16();
  var division = u16();
  pos = 8 + headerLen;
  if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间码 MIDI');
  var ppq = division || 480;
  var tempoEvents = [{ tick: 0, micro: 500000 }];
  var sigEvents = [];
  var tracks = [];

  for (var ti = 0; ti < trackCount; ti++) {
    need(8);
    if (ascii4(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]) !== 'MTrk') throw new Error('第 ' + (ti + 1) + ' 条轨道无效');
    pos += 4;
    var len = u32();
    var end = Math.min(bytes.length, pos + len);
    var tick = 0, running = 0, name = '';
    var notes = [], ccs = [], pending = {}, channels = {};
    while (pos < end) {
      var d = vlq(pos); pos = d.next; tick += d.value;
      need(1);
      var status = bytes[pos++];
      if (status < 0x80) {
        if (!running) throw new Error('MIDI running status 无效');
        pos--;
        status = running;
      } else if (status < 0xF0) {
        running = status;
      }

      if (status === 0xFF) {
        need(1); var metaType = bytes[pos++];
        var ml = vlq(pos); pos = ml.next; need(ml.value);
        var data = bytes.slice(pos, pos + ml.value); pos += ml.value;
        if (metaType === 0x03 && !name) name = text(data);
        if (metaType === 0x51 && data.length === 3) {
          tempoEvents.push({ tick: tick, micro: (data[0] << 16) | (data[1] << 8) | data[2] });
        }
        if (metaType === 0x58 && data.length >= 2) {
          sigEvents.push({ tick: tick, n: data[0], d: Math.pow(2, data[1]) });
        }
        if (metaType === 0x2F) break;
        continue;
      }
      if (status === 0xF0 || status === 0xF7) {
        var sl = vlq(pos); pos = sl.next; need(sl.value); pos += sl.value; running = 0; continue;
      }
      if (status >= 0xF1) { continue; }

      var kind = status & 0xF0, channel = status & 0x0F;
      var dataLen = (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
      need(dataLen);
      var a = bytes[pos++], b = dataLen === 2 ? bytes[pos++] : 0;
      channels[channel] = true;
      if (kind === 0x90 && b > 0) {
        var onKey = channel + ':' + a;
        if (!pending[onKey]) pending[onKey] = [];
        pending[onKey].push({ pitch: a, vel: b, channel: channel, tOnTick: tick });
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        var offKey = channel + ':' + a;
        var stack = pending[offKey];
        if (stack && stack.length) {
          var on = stack.pop();
          notes.push({ pitch: on.pitch, vel: on.vel, channel: on.channel, tOnTick: on.tOnTick, tOffTick: Math.max(tick, on.tOnTick + 1) });
        }
      } else if (kind === 0xB0) {
        ccs.push({ cc: a, value: b, channel: channel, tick: tick });
      }
    }
    Object.keys(pending).forEach(function (key) {
      pending[key].forEach(function (on) {
        notes.push({ pitch: on.pitch, vel: on.vel, channel: on.channel, tOnTick: on.tOnTick, tOffTick: Math.max(tick, on.tOnTick + 1) });
      });
    });
    pos = end;
    tracks.push({ id: ti, name: name || ('轨道 ' + (ti + 1)), notes: notes, ccs: ccs, channels: Object.keys(channels).map(Number), endTick: tick });
  }

  tempoEvents.sort(function (a, b) { return a.tick - b.tick; });
  var tempoMap = [], curTick = 0, curMs = 0, curMicro = 500000;
  tempoEvents.forEach(function (e) {
    if (e.tick < curTick) return;
    curMs += (e.tick - curTick) * curMicro / 1000 / ppq;
    curTick = e.tick;
    curMicro = e.micro > 0 ? e.micro : curMicro;
    tempoMap.push({ tick: curTick, ms: curMs, micro: curMicro });
  });
  function tickMs(t) {
    var last = tempoMap[0] || { tick: 0, ms: 0, micro: 500000 };
    for (var i = 1; i < tempoMap.length; i++) {
      if (tempoMap[i].tick > t) break;
      last = tempoMap[i];
    }
    return last.ms + (t - last.tick) * last.micro / 1000 / ppq;
  }
  var maxTick = 0;
  tracks.forEach(function (tr) {
    maxTick = Math.max(maxTick, tr.endTick);
    tr.notes = tr.notes.map(function (n) {
      maxTick = Math.max(maxTick, n.tOffTick);
      return { pitch: n.pitch, vel: n.vel, channel: n.channel, tOn: tickMs(n.tOnTick), tOff: tickMs(n.tOffTick) };
    });
    tr.ccs = tr.ccs.map(function (c) {
      maxTick = Math.max(maxTick, c.tick);
      return { cc: c.cc, value: c.value, channel: c.channel, t: tickMs(c.tick) };
    });
    tr.durationMs = tickMs(tr.endTick);
    tr.noteCount = tr.notes.length;
  });
  var firstTempo = 500000;
  tempoEvents.forEach(function (e) { if (e.tick === 0) firstTempo = e.micro; });
  var firstSig = sigEvents.sort(function (a, b) { return a.tick - b.tick; })[0] || { n: 4, d: 4 };
  var timeSig = ['4/4', '3/4', '2/4', '6/8'].indexOf(firstSig.n + '/' + firstSig.d) >= 0 ? firstSig.n + '/' + firstSig.d : '4/4';
  return { format: format, ppq: ppq, tracks: tracks, durationMs: tickMs(maxTick), bpm: Math.max(1, Math.round(60000000 / firstTempo)), timeSig: timeSig };
}

function renderMidiTracks() {
  var host = $('midiTrackList');
  if (!host) return;
  host.textContent = '';
  if (!midiImport.tracks.length) {
    host.innerHTML = '<div class="midi-track-empty">还没有导入 MIDI 文件。</div>';
    $('btnMidiLoad').disabled = true;
    $('btnMidiClear').disabled = true;
    return;
  }
  midiImport.tracks.forEach(function (tr) {
    var row = document.createElement('div');
    row.className = 'midi-track';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!midiImport.selected[tr.id];
    checkbox.addEventListener('change', function () {
      midiImport.selected[tr.id] = checkbox.checked;
      renderMidiTracks();
    });
    var info = document.createElement('span');
    info.className = 'midi-track-info';
    var name = document.createElement('b');
    name.textContent = tr.name;
    var meta = document.createElement('span');
    var channels = tr.channels.length ? '通道 ' + tr.channels.map(function (c) { return c + 1; }).join(',') : '无通道事件';
    meta.textContent = tr.noteCount + ' 个音符 · ' + (tr.durationMs / 1000).toFixed(1) + 's · ' + channels;
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(checkbox);
    row.appendChild(info);
    var actions = document.createElement('span');
    actions.className = 'midi-track-actions';
    var solo = document.createElement('button');
    solo.type = 'button';
    solo.className = 'btn mini' + (midiImport.solo[tr.id] ? ' active' : '');
    solo.textContent = '独奏';
    solo.addEventListener('click', function () { midiImport.solo[tr.id] = !midiImport.solo[tr.id]; renderMidiTracks(); });
    var mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'btn mini' + (midiImport.muted[tr.id] ? ' active' : '');
    mute.textContent = '静音';
    mute.addEventListener('click', function () { midiImport.muted[tr.id] = !midiImport.muted[tr.id]; renderMidiTracks(); });
    actions.appendChild(solo);
    actions.appendChild(mute);
    row.appendChild(actions);
    host.appendChild(row);
  });
  var selected = midiImport.tracks.filter(function (tr) { return midiImport.selected[tr.id]; });
  $('btnMidiLoad').disabled = !selected.length;
  $('btnMidiClear').disabled = false;
}


function renderMidiCcEditor() {
  var host = $('midiCcList');
  if (!host) return;
  host.textContent = '';
  var ccs = state.ccs || [];
  if ($('midiCcSummary')) $('midiCcSummary').textContent = ccs.length ? ccs.length + ' 个 CC 事件' : '当前工程没有 CC 控制器事件';
  if ($('btnMidiClearCc')) $('btnMidiClearCc').disabled = !ccs.length;
  ccs.slice(0, 80).forEach(function (cc, index) {
    var row = document.createElement('div');
    row.className = 'midi-cc-row';
    var label = document.createElement('span');
    label.textContent = 'CC' + cc.cc + ' · ' + (cc.t / 1000).toFixed(2) + 's';
    var range = document.createElement('input');
    range.type = 'range'; range.min = 0; range.max = 127; range.value = cc.value;
    var value = document.createElement('span');
    value.textContent = cc.value;
    range.addEventListener('input', function () { cc.value = parseInt(range.value, 10); value.textContent = cc.value; });
    range.addEventListener('change', function () { $('mCc').textContent = state.ccs.length; scheduleSave(); });
    var del = document.createElement('button');
    del.className = 'btn'; del.type = 'button'; del.textContent = '×';
    del.addEventListener('click', function () { state.ccs.splice(index, 1); renderMidiCcEditor(); $('mCc').textContent = state.ccs.length; scheduleSave(); });
    row.appendChild(label); row.appendChild(range); row.appendChild(value); row.appendChild(del);
    host.appendChild(row);
  });
  if (ccs.length > 80) {
    var more = document.createElement('p'); more.className = 'hint'; more.textContent = '仅显示前 80 个事件，完整 CC 仍会随 MIDI 导出。'; host.appendChild(more);
  }
}

async function importMIDIFile(file) {
  if (!file) return;
  try {
    setPill('读取 MIDI…');
    var data = await file.arrayBuffer();
    var parsed = parseMidiData(data);
    midiImport.fileName = file.name || '未命名 MIDI';
    midiImport.ppq = parsed.ppq;
    midiImport.bpm = parsed.bpm;
    midiImport.timeSig = parsed.timeSig;
    midiImport.tracks = parsed.tracks;
    midiImport.selected = {};
    midiImport.muted = {};
    midiImport.solo = {};
    var first = parsed.tracks.find(function (tr) { return tr.noteCount > 0; });
    if (first) midiImport.selected[first.id] = true;
    $('midiImportSummary').textContent = midiImport.fileName + ' · ' + parsed.tracks.length + ' 条轨道 · ' +
      parsed.tracks.reduce(function (n, tr) { return n + tr.noteCount; }, 0) + ' 个音符 · ' +
      (parsed.durationMs / 1000).toFixed(1) + 's · 约 ' + parsed.bpm + ' BPM';
    renderMidiTracks();
    setPill('MIDI 已读取', 'on');
  } catch (e) {
    midiImport.tracks = [];
    midiImport.selected = {};
    renderMidiTracks();
    setPill(state.deviceName || '已连接', 'on');
    alert('MIDI 文件读取失败：' + (e && e.message ? e.message : e));
  }
}

function loadSelectedMidiTracks() {
  var soloIds = midiImport.tracks.filter(function (tr) { return midiImport.solo[tr.id]; }).map(function (tr) { return tr.id; });
  var hand = $('midiHandFilter') ? $('midiHandFilter').value : 'all';
  midiImport.hand = hand;
  var chosen = midiImport.tracks.filter(function (tr) {
    if (!midiImport.selected[tr.id] || midiImport.muted[tr.id]) return false;
    return !soloIds.length || midiImport.solo[tr.id];
  });
  var notes = [], ccs = [];
  chosen.forEach(function (tr) {
    notes = notes.concat(tr.notes.filter(function (n) {
      return hand === 'all' || (hand === 'right' ? n.pitch >= 60 : n.pitch < 60);
    }));
    ccs = ccs.concat(tr.ccs);
  });
  if (!notes.length) { alert('所选轨道没有音符。'); return; }
  notes.sort(function (a, b) { return a.tOn - b.tOn || a.pitch - b.pitch; });
  ccs.sort(function (a, b) { return a.t - b.t; });
  saveSnapshot(true);
  state.notes = notes.map(function (n) { return { pitch: n.pitch, vel: n.vel, tOn: n.tOn, tOff: n.tOff }; });
  state.ccs = ccs.map(function (c) { return { cc: c.cc, value: c.value, t: c.t }; });
  state.pending = {};
  state.lastDur = Math.max.apply(null, state.notes.map(function (n) { return n.tOff; })) / 1000;
  state.bpm = midiImport.bpm || 120;
  state.bpmAuto = false;
  state.timeSig = midiImport.timeSig || '4/4';
  $('bpm').value = state.bpm;
  $('bpmVal').textContent = state.bpm;
  syncBpmLabel();
  $('timeSig').value = state.timeSig;
  $('mNotes').textContent = state.notes.length;
  $('mTime').textContent = state.lastDur.toFixed(1) + 's';
  $('mCc').textContent = state.ccs.length;
  renderMidiCcEditor();
  noteEdit.selected = -1;
  noteEdit.undo = [];
  noteEdit.redo = [];
  noteEdit.drag = null;
  velDragStart = null;
  ['btnPlay', 'btnMidi', 'btnWav', 'btnMp3', 'btnStop'].forEach(function (id) { $(id).disabled = false; });
  buildScore();
  renderAll();
  practiceSyncBounds();
  scheduleSave();
  saveSnapshot(true);
  updateMini();
  setPill('已载入 ' + chosen.length + ' 条 MIDI 轨道', 'on');
}

function clearMidiImport() {
  midiImport.fileName = '';
  midiImport.tracks = [];
  midiImport.selected = {};
  midiImport.muted = {};
  midiImport.solo = {};
  $('midiImportSummary').textContent = '支持标准 MIDI 文件（.mid / .midi）。导入后可以选择一条或多条轨道载入卷帘。';
  renderMidiTracks();
}

/* ============================================================
   工作区导航与设备诊断
   ============================================================ */
// 画布配色跟随明暗主题（canvas 里的颜色是画上去的，CSS 管不到）
function uiIsDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}
function uiPick(light, dark) {
  return uiIsDark() ? dark : light;
}

var currentWorkspace = 'performance';

function setWorkspace(name) {
  currentWorkspace = name;
  document.querySelectorAll('[data-workspace]').forEach(function (el) {
    // 跳过导航按钮本身，以及 <body>：body 上挂的是「当前工作区」状态，
    // 如果让它也被 [data-workspace] 选中，第二次点击时 body 会被加上
    // workspace-hidden（display:none !important），整页直接白屏。
    if (el === document.body || el.classList.contains('workspace-tab')) return;
    var groups = (el.getAttribute('data-workspace') || '').split(/\s+/);
    el.classList.toggle('workspace-hidden', groups.indexOf(name) < 0);
  });
  document.querySelectorAll('.workspace-tab').forEach(function (tab) {
    var active = tab.getAttribute('data-workspace') === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  var layout = document.querySelector('.layout');
  var aside = layout && layout.querySelector('aside');
  var asideVisible = aside && Array.prototype.some.call(aside.querySelectorAll('[data-workspace]'), function (el) {
    return !el.classList.contains('workspace-hidden');
  });
  if (layout) layout.classList.toggle('workspace-single', !asideVisible);
  // 单独属性名记录当前工作区，避免和上面 [data-workspace] 的选择器互相踩
  document.body.setAttribute('data-workspace-current', name);
  if (name === 'edit') {
    setTimeout(function () { fitWave(); fitOverview(); }, 30);
  }
}

function setupWorkspaceNav() {
  document.querySelectorAll('.workspace-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { setWorkspace(tab.getAttribute('data-workspace')); });
  });
  setWorkspace('performance');
}

function diagnosticRow(label, detail, status) {
  var row = document.createElement('div');
  row.className = 'diagnostic-row';
  var dot = document.createElement('i');
  dot.className = 'diagnostic-dot ' + status;
  var copy = document.createElement('div');
  copy.className = 'diagnostic-copy';
  var b = document.createElement('b');
  b.textContent = label;
  var span = document.createElement('span');
  span.textContent = detail;
  copy.appendChild(b);
  copy.appendChild(span);
  row.appendChild(dot);
  row.appendChild(copy);
  return row;
}

async function runDiagnostics() {
  var host = $('diagnosticList');
  if (!host) return;
  host.textContent = '';
  var rows = [];
  var secure = window.isSecureContext === true;
  rows.push(diagnosticRow('安全上下文', secure ? '当前地址允许访问硬件 API。' : '请使用 HTTPS、localhost 或桌面版。', secure ? 'ok' : 'bad'));
  var ble = typeof navigator.bluetooth === 'object';
  rows.push(diagnosticRow('蓝牙 BLE-MIDI', ble ? '浏览器支持蓝牙；点击顶部“连接钢琴”开始授权。' : '当前环境没有 Web Bluetooth。', ble ? 'ok' : 'bad'));
  if (ble && typeof navigator.bluetooth.getAvailability === 'function') {
    try {
      var available = await navigator.bluetooth.getAvailability();
      rows.push(diagnosticRow('蓝牙开关', available ? '系统报告蓝牙可用。' : '系统报告蓝牙不可用，请打开蓝牙。', available ? 'ok' : 'warn'));
    } catch (e) {
      rows.push(diagnosticRow('蓝牙开关', '无法读取系统蓝牙状态，可以继续尝试连接。', 'warn'));
    }
  }
  var midi = typeof navigator.requestMIDIAccess === 'function';
  if (!midi) {
    rows.push(diagnosticRow('USB-MIDI', '当前浏览器不支持 Web MIDI。', 'bad'));
  } else if (webMidi.access) {
    rows.push(diagnosticRow('USB-MIDI', '已获得权限，发现 ' + webMidi.access.inputs.size + ' 个输入端口。', webMidi.access.inputs.size ? 'ok' : 'warn'));
  } else {
    rows.push(diagnosticRow('USB-MIDI', '浏览器支持，尚未请求端口权限；点击顶部“USB”开始扫描。', 'warn'));
  }
  var audio = typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  rows.push(diagnosticRow('音频引擎', audio ? 'Web Audio 可用，可以监听和播放。' : '当前环境不支持 Web Audio。', audio ? 'ok' : 'bad'));
  var input = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
  rows.push(diagnosticRow('音频输入', input ? '支持麦克风或线路录音。' : '当前环境不支持 MediaRecorder 音频录音。', input ? 'ok' : 'warn'));
  rows.push(diagnosticRow('当前连接', state.connected ? (state.transport === 'usb' ? 'USB · ' : '蓝牙 · ') + (state.deviceName || '已连接') : '尚未连接钢琴。', state.connected ? 'ok' : 'warn'));
  rows.forEach(function (row) { host.appendChild(row); });
}

function setupDiagnostics() {
  var mask = $('diagnosticMask');
  if (!mask) return;
  function open() { mask.classList.add('show'); runDiagnostics(); }
  function close() { mask.classList.remove('show'); }
  $('btnDiagnostics').addEventListener('click', open);
  $('btnDiagnosticRefresh').addEventListener('click', runDiagnostics);
  $('btnDiagnosticClose').addEventListener('click', close);
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mask.classList.contains('show')) close();
  });
}

/* ============================================================
   音频输入：麦克风 / 线路录音与延迟校准
   ============================================================ */
function audioInputStatus(text) {
  if ($('audioInputStatus')) $('audioInputStatus').textContent = text;
}

function audioInputUpdateUI() {
  var rec = $('btnAudioRecord'), stop = $('btnAudioStop');
  if (rec) {
    rec.textContent = audioInput.recording ? '录音中…' : '开始录音';
    rec.classList.toggle('danger', audioInput.recording);
  }
  if (stop) stop.disabled = !audioInput.recording;
  if ($('audioInputGainVal')) $('audioInputGainVal').textContent = Math.round(audioInput.gainValue * 100) + '%';
  updateAudioAlignButton();
}

function updateAudioAlignButton() {
  var btn = $('btnAudioAutoAlign');
  if (btn) btn.disabled = !(state.notes.length >= 3 && edit && edit.srcBuf);
}

async function refreshAudioInputDevices() {
  var sel = $('audioInputDevice');
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    audioInputStatus('当前环境不支持音频输入设备枚举。');
    return;
  }
  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
    var keep = audioInput.deviceId || sel.value;
    sel.textContent = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = inputs.length ? '默认输入设备' : '没有发现输入设备';
    sel.appendChild(def);
    inputs.forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || ('输入设备 ' + (i + 1));
      sel.appendChild(o);
    });
    sel.value = keep;
    audioInputStatus(inputs.length ? '发现 ' + inputs.length + ' 个音频输入设备。' : '没有发现音频输入设备，请检查麦克风或声卡。');
  } catch (e) {
    audioInputStatus('读取输入设备失败：' + (e.message || e));
  }
}

function stopAudioInputStream() {
  if (audioInput.meterRaf) cancelAnimationFrame(audioInput.meterRaf);
  audioInput.meterRaf = 0;
  [audioInput.source, audioInput.gain, audioInput.analyser, audioInput.monitorGain].forEach(function (node) {
    if (node) { try { node.disconnect(); } catch (e) {} }
  });
  audioInput.source = null;
  audioInput.gain = null;
  audioInput.analyser = null;
  audioInput.monitorGain = null;
  if (audioInput.stream) audioInput.stream.getTracks().forEach(function (track) { track.stop(); });
  audioInput.stream = null;
}

function updateAudioInputMeter() {
  if (!audioInput.recording || !audioInput.analyser) return;
  var data = new Float32Array(audioInput.analyser.fftSize);
  audioInput.analyser.getFloatTimeDomainData(data);
  var peak = 0;
  for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  var pct = Math.min(100, Math.round(peak * 100));
  var level = $('audioInputLevel');
  var peakText = $('audioInputPeak');
  var clip = $('audioInputClip');
  if (level) {
    level.style.width = pct + '%';
    level.classList.toggle('hot', peak > 0.75 && peak < 0.98);
    level.classList.toggle('clip', peak >= 0.98);
  }
  if (peakText) peakText.textContent = peak > 0.0001 ? '峰值 ' + (20 * Math.log10(peak)).toFixed(1) + ' dB' : '峰值 —';
  if (clip) {
    clip.textContent = peak >= 0.98 ? '已削波' : '未削波';
    clip.classList.toggle('clip', peak >= 0.98);
  }
  audioInput.meterRaf = requestAnimationFrame(updateAudioInputMeter);
}

function offsetAudioBuffer(buf, offsetMs) {
  var shift = Math.round(offsetMs / 1000 * buf.sampleRate);
  if (!shift) return buf;
  var outLen = shift > 0 ? Math.max(1, buf.length - shift) : buf.length - shift;
  var out = actx.createBuffer(buf.numberOfChannels, outLen, buf.sampleRate);
  var srcStart = shift > 0 ? shift : 0;
  var dstStart = shift < 0 ? -shift : 0;
  for (var c = 0; c < buf.numberOfChannels; c++) {
    var src = buf.getChannelData(c);
    out.getChannelData(c).set(src.subarray(srcStart, Math.min(src.length, srcStart + outLen - dstStart)), dstStart);
  }
  return out;
}


function audioEnergyAt(buf, seconds) {
  var data = buf.getChannelData(0);
  var center = Math.round(seconds * buf.sampleRate);
  var half = Math.max(32, Math.round(buf.sampleRate * 0.025));
  var from = Math.max(0, center - half);
  var to = Math.min(data.length, center + half);
  if (to <= from) return 0;
  var sum = 0, peak = 0;
  for (var i = from; i < to; i += 2) {
    var v = Math.abs(data[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  return Math.max(peak * 0.35, Math.sqrt(sum / Math.max(1, Math.ceil((to - from) / 2))));
}

function autoAlignMidiAudio() {
  if (!edit.srcBuf || state.notes.length < 3) {
    alert('需要至少 3 个 MIDI 音符和一段音频才能自动对齐。');
    return;
  }
  var notes = state.notes.filter(function (n) { return n.tOff !== null; }).sort(function (a, b) { return a.tOn - b.tOn; });
  var onsets = [];
  notes.forEach(function (n) {
    if (!onsets.length || n.tOn - onsets[onsets.length - 1] > 35) onsets.push(n.tOn);
  });
  if (onsets.length < 3) {
    alert('MIDI 音符起音太密，无法可靠估算对齐偏移。');
    return;
  }
  var bestOffset = 0, bestScore = -Infinity;
  for (var offset = -500; offset <= 500; offset += 10) {
    var score = 0, used = 0;
    onsets.forEach(function (t) {
      var sec = (t + offset) / 1000;
      if (sec >= 0 && sec <= edit.srcBuf.duration) {
        score += audioEnergyAt(edit.srcBuf, sec);
        used++;
      }
    });
    if (used < 3) return;
    score /= used;
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  if (!isFinite(bestScore)) {
    alert('音频和 MIDI 的时间范围没有足够重叠，无法自动对齐。');
    return;
  }
  audioInput.latencyMs = Math.max(-500, Math.min(500, audioInput.latencyMs + bestOffset));
  if ($('audioInputLatency')) $('audioInputLatency').value = audioInput.latencyMs;
  var aligned = offsetAudioBuffer(edit.srcBuf, bestOffset);
  loadBuffer(aligned);
  setWorkspace('edit');
  audioInputStatus('已自动对齐，估算偏移 ' + (bestOffset >= 0 ? '+' : '') + bestOffset + ' ms。');
  setPill('MIDI / 音频已对齐', 'on');
}

async function importAudioRecording(blob) {
  initLive();
  var buf = await actx.decodeAudioData(await blob.arrayBuffer());
  if (buf.numberOfChannels === 1) {
    var mono = buf.getChannelData(0);
    var stereo = actx.createBuffer(2, buf.length, buf.sampleRate);
    stereo.copyToChannel(mono, 0);
    stereo.copyToChannel(mono, 1);
    buf = stereo;
  }
  buf = offsetAudioBuffer(buf, audioInput.latencyMs);
  loadBuffer(buf);
  setWorkspace('edit');
  audioInputStatus('录音已载入剪辑器（延迟校准 ' + audioInput.latencyMs + ' ms）。');
}

async function startAudioInputRecording() {
  if (audioInput.recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('当前环境不支持麦克风录音，请使用最新版 Chrome / Edge 或桌面版。');
    return;
  }
  try {
    stopAudioInputStream();
    var deviceId = $('audioInputDevice').value;
    var constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    audioInput.stream = await navigator.mediaDevices.getUserMedia(constraints);
    audioInput.deviceId = deviceId;
    initLive();
    if (actx.state === 'suspended') await actx.resume();
    audioInput.source = actx.createMediaStreamSource(audioInput.stream);
    audioInput.gain = actx.createGain();
    audioInput.gain.gain.value = audioInput.gainValue;
    audioInput.analyser = actx.createAnalyser();
    audioInput.analyser.fftSize = 2048;
    audioInput.source.connect(audioInput.gain);
    audioInput.gain.connect(audioInput.analyser);
    audioInput.monitorGain = actx.createGain();
    audioInput.monitorGain.gain.value = $('audioInputMonitor').checked ? 0.8 : 0;
    audioInput.gain.connect(audioInput.monitorGain);
    audioInput.monitorGain.connect(actx.destination);
    var mime = '';
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].some(function (type) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) { mime = type; return true; }
      return false;
    });
    audioInput.chunks = [];
    audioInput.recorder = new MediaRecorder(audioInput.stream, mime ? { mimeType: mime } : undefined);
    audioInput.recorder.ondataavailable = function (e) { if (e.data && e.data.size) audioInput.chunks.push(e.data); };
    audioInput.recorder.onstop = async function () {
      var blob = new Blob(audioInput.chunks, { type: audioInput.recorder.mimeType || 'audio/webm' });
      stopAudioInputStream();
      try {
        await importAudioRecording(blob);
        setPill(state.deviceName || '已连接', 'on');
      } catch (e) {
        audioInputStatus('录音载入失败：' + (e.message || e));
        alert('录音载入失败：' + (e.message || e));
      }
    };
    audioInput.recorder.start(250);
    audioInput.recording = true;
    audioInputUpdateUI();
    audioInputStatus('正在录音，弹奏或播放外部音源后点击停止。');
    setPill('音频录音中', 'rec');
    updateAudioInputMeter();
    refreshAudioInputDevices();
  } catch (e) {
    stopAudioInputStream();
    audioInput.recording = false;
    audioInputUpdateUI();
    audioInputStatus('无法打开输入设备：' + (e.message || e));
    alert('无法打开输入设备：' + (e.message || e) + '\\n请检查浏览器麦克风权限。');
  }
}

function stopAudioInputRecording() {
  if (!audioInput.recording) return;
  audioInput.recording = false;
  audioInputUpdateUI();
  audioInputStatus('正在处理录音…');
  if (audioInput.recorder && audioInput.recorder.state !== 'inactive') audioInput.recorder.stop();
}

function setupAudioInput() {
  if (!$('btnAudioRecord')) return;
  $('btnAudioRefresh').addEventListener('click', refreshAudioInputDevices);
  $('btnAudioRecord').addEventListener('click', function () {
    if (audioInput.recording) stopAudioInputRecording(); else startAudioInputRecording();
  });
  $('btnAudioStop').addEventListener('click', stopAudioInputRecording);
  $('audioInputGain').addEventListener('input', function (e) {
    audioInput.gainValue = parseInt(e.target.value, 10) / 100;
    if (audioInput.gain) audioInput.gain.gain.value = audioInput.gainValue;
    audioInputUpdateUI();
  });
  $('audioInputMonitor').addEventListener('change', function (e) {
    if (audioInput.monitorGain) audioInput.monitorGain.gain.value = e.target.checked ? 0.8 : 0;
  });
  $('audioInputLatency').addEventListener('change', function (e) {
    audioInput.latencyMs = Math.max(-500, Math.min(500, parseInt(e.target.value, 10) || 0));
    e.target.value = audioInput.latencyMs;
  });
  $('btnAudioAutoAlign').addEventListener('click', autoAlignMidiAudio);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshAudioInputDevices);
  }
  refreshAudioInputDevices();
  audioInputUpdateUI();
}

function exportMIDI() {
  var notes = state.notes.filter(function (n) { return n.tOff !== null; });
  if (!notes.length) return;

  var PPQ = 480;
  var TPS = PPQ * state.bpm / 60;
  var tempoMicro = Math.round(60000000 / state.bpm);

  var evs = [];
  notes.forEach(function (n) {
    evs.push([Math.round(n.tOn / 1000 * TPS), [0x90, n.pitch, Math.max(1, n.vel)]]);
    evs.push([Math.round(n.tOff / 1000 * TPS), [0x80, n.pitch, 0]]);
  });
  state.ccs.forEach(function (c) {
    evs.push([Math.round(c.t / 1000 * TPS), [0xB0, c.cc, c.value]]);
  });
  evs.sort(function (a, b) { return a[0] - b[0]; });

  var track = [0x00, 0xFF, 0x51, 0x03,
    (tempoMicro >> 16) & 255, (tempoMicro >> 8) & 255, tempoMicro & 255];
  var last = 0;
  evs.forEach(function (e) {
    var d = Math.max(0, e[0] - last);
    last = e[0];
    varlen(d).forEach(function (b) { track.push(b); });
    e[1].forEach(function (b) { track.push(b); });
  });
  track.push(0x00, 0xFF, 0x2F, 0x00);

  var bytes = [0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,(PPQ >> 8) & 255, PPQ & 255,
               0x4D,0x54,0x72,0x6B,
               (track.length >>> 24) & 255, (track.length >>> 16) & 255, (track.length >>> 8) & 255, track.length & 255]
               .concat(track);

  download(new Blob([new Uint8Array(bytes)], { type: 'audio/midi' }), 'piano_' + stamp() + '.mid');
}

function encodeWav(buffer) {
  var numCh = buffer.numberOfChannels, len = buffer.length;
  var ab = new ArrayBuffer(44 + len * numCh * 2);
  var dv = new DataView(ab);
  var str = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + len * numCh * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * numCh * 2, true); dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, len * numCh * 2, true);

  var chans = [];
  for (var c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  var off = 44;
  for (var i = 0; i < len; i++) {
    for (var c2 = 0; c2 < numCh; c2++) {
      var v = Math.max(-1, Math.min(1, chans[c2][i]));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function renderOffline() {
  var notes = state.notes.filter(function (n) { return n.tOff !== null; });
  if (!notes.length) return null;

  var rel = $('sustain').checked ? 1.4 : 0.12;
  var endMs = Math.max.apply(null, notes.map(function (n) { return n.tOff; }));
  var total = endMs / 1000 + rel + 1.5;

  var offline = new OfflineAudioContext(2, Math.ceil(total * 44100), 44100);
  var outs = buildGraph(offline, state.wet, state.vol);

  notes.forEach(function (n) {
    var dur = Math.max(0.05, (n.tOff - n.tOn) / 1000);
    playTone(offline, outs, n.tOn / 1000 + 0.02, n.pitch, n.vel, dur, rel);
  });

  return await offline.startRendering();
}

async function exportWav() {
  var btn = $('btnWav');
  btn.disabled = true;
  setPill('合成 WAV…');
  try {
    var buf = await renderOffline();
    if (buf) download(encodeWav(buf), 'piano_' + stamp() + '.wav');
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('WAV 导出失败：' + e.message);
  }
  btn.disabled = false;
}

function floatTo16(input) {
  var out = new Int16Array(input.length);
  for (var i = 0; i < input.length; i++) {
    var s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

async function encodeMp3Blob(buf) {
  var enc = new lamejs.Mp3Encoder(2, buf.sampleRate, 128);
  var left = buf.getChannelData(0);
  var right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
  var block = 1152, chunks = [];
  for (var i = 0; i < buf.length; i += block) {
    var l = floatTo16(left.subarray(i, i + block));
    var r = floatTo16(right.subarray(i, i + block));
    var mp3buf = enc.encodeBuffer(l, r);
    if (mp3buf.length) chunks.push(new Int8Array(mp3buf));
  }
  var end = enc.flush();
  if (end.length) chunks.push(new Int8Array(end));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

async function exportMp3() {
  var btn = $('btnMp3');
  if (!window.lamejs) { alert('MP3 编码器没有加载成功，检查 lib/lame.min.js。'); return; }
  btn.disabled = true;
  setPill('编码 MP3…');
  try {
    var buf = await renderOffline();
    if (!buf) return;
    download(await encodeMp3Blob(buf), 'piano_' + stamp() + '.mp3');
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('MP3 导出失败：' + e.message);
  }
  btn.disabled = false;
}

/* ============================================================
   音频剪辑（多片段时间轴）
   ============================================================ */
var WAVE_H = 260;
var RULER_H = 26;

var edit = {
  srcBuf: null,
  clips: [],
  nextId: 1,
  sel: null,
  selClip: null,
  playhead: 0,
  viewStart: 0,
  viewDur: 0,
  playing: false,
  loop: false,
  sources: [],
  endTimer: null,
  playFrom: 0,
  playTo: null,
  playCtxStart: 0,
  undo: [],
  redo: [],
  clip: null,
  cache: null,
  cacheKey: '',
  pending: null,
  peakCache: { buf: null, val: 0 },
  pyramid: null,
  declk: 0.008
};

var waveCanvas = null, wctx = null;
var dragMode = null;
var dragClip = null;
var dragOrigin = null;
var dragPushed = false;

function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function computePeaks(data, w) {
  var out = new Float32Array(w * 2);
  var n = data.length;
  for (var x = 0; x < w; x++) {
    var i0 = Math.floor(x / w * n);
    var i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * n));
    var mn = 0, mx = 0;
    for (var i = i0; i < i1 && i < n; i++) {
      var v = data[i];
      if (v < mn) mn = v;
      else if (v > mx) mx = v;
    }
    out[x * 2] = mn;
    out[x * 2 + 1] = mx;
  }
  return out;
}

/* ---------- 片段模型 ---------- */
function sr() { return edit.srcBuf ? edit.srcBuf.sampleRate : 44100; }
function clipDur(c) { return (c.b - c.a) / sr(); }
function clipEnd(c) { return c.start + clipDur(c); }
function nid() { return edit.nextId++; }

function sortClips() {
  edit.clips.sort(function (a, b) { return a.start - b.start; });
}

function timelineDur() {
  var d = 0;
  for (var i = 0; i < edit.clips.length; i++) {
    var e = clipEnd(edit.clips[i]);
    if (e > d) d = e;
  }
  return d;
}

function clipAtTime(t) {
  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    if (t >= c.start && t < clipEnd(c)) return c;
  }
  return null;
}

function neighborBounds(clip) {
  // 允许片段重叠：不再用相邻片段夹住，只约束 start >= 0。交叉淡化负责过渡。
  return [0, Infinity];
}

function cloneClips() {
  return edit.clips.map(function (c) { return { id: c.id, a: c.a, b: c.b, start: c.start }; });
}

function scanPeak(lo, hi) {
  if (!edit.srcBuf) return 0;
  var d = edit.srcBuf.getChannelData(0);
  var end = Math.min(hi, d.length);
  var start = Math.max(0, lo);
  if (end <= start) return 0;
  var stride = Math.max(1, Math.floor((end - start) / 20000));
  var p = 0;
  for (var i = start; i < end; i += stride) {
    var v = Math.abs(d[i]);
    if (v > p) p = v;
  }
  return p;
}

function globalPeak() {
  if (!edit.srcBuf) return 0;
  if (edit.peakCache.buf === edit.srcBuf && edit.peakCache.len === edit.srcBuf.length) {
    return edit.peakCache.val;
  }
  var p = scanPeak(0, edit.srcBuf.length);
  edit.peakCache = { buf: edit.srcBuf, len: edit.srcBuf.length, val: p };
  return p;
}

function buildPyramid() {
  if (!edit.srcBuf) { edit.pyramid = null; return null; }
  var p = edit.pyramid;
  if (p && p.buf === edit.srcBuf && p.len === edit.srcBuf.length) return p;

  var data = edit.srcBuf.getChannelData(0);
  var step = 128;
  var n = Math.ceil(data.length / step);
  var mn = new Float32Array(n);
  var mx = new Float32Array(n);

  for (var i = 0; i < n; i++) {
    var s = i * step;
    var e = Math.min(s + step, data.length);
    var a = 0, b = 0;
    for (var j = s; j < e; j++) {
      var v = data[j];
      if (v < a) a = v;
      else if (v > b) b = v;
    }
    mn[i] = a;
    mx[i] = b;
  }

  edit.pyramid = { buf: edit.srcBuf, len: data.length, step: step, min: mn, max: mx };
  return edit.pyramid;
}

function peakRange(sa, sb) {
  var p = buildPyramid();
  if (!p) return [0, 0];

  var b0 = Math.floor(sa / p.step);
  var b1 = Math.ceil(sb / p.step);
  b1 = Math.min(b1, p.min.length);

  if (b1 - b0 <= 2) {
    var data = edit.srcBuf.getChannelData(0);
    var a = 0, b = 0;
    for (var i = Math.max(0, sa); i < Math.min(sb, data.length); i++) {
      var v = data[i];
      if (v < a) a = v;
      else if (v > b) b = v;
    }
    return [a, b];
  }

  var lo = 0, hi = 0;
  for (var k = Math.max(0, b0); k < b1; k++) {
    if (p.min[k] < lo) lo = p.min[k];
    if (p.max[k] > hi) hi = p.max[k];
  }
  return [lo, hi];
}

function scheduleClipAt(ac, dest, clip, when, offset, dur, fadeIn, fadeOut) {
  var src = ac.createBufferSource();
  src.buffer = edit.srcBuf;

  var g = ac.createGain();
  var fi = (fadeIn === undefined) ? (edit.declk || 0) : fadeIn;
  var fo = (fadeOut === undefined) ? (edit.declk || 0) : fadeOut;
  fi = Math.max(0, Math.min(fi, dur * 0.45));
  fo = Math.max(0, Math.min(fo, dur * 0.45));
  var t0 = when, t1 = when + dur;

  g.gain.setValueAtTime(fi > 0.0005 ? 0 : 1, t0);
  if (fi > 0.0005) g.gain.linearRampToValueAtTime(1, t0 + fi);
  g.gain.setValueAtTime(1, Math.max(t0 + fi, t1 - fo));
  if (fo > 0.0005) g.gain.linearRampToValueAtTime(0, t1);

  src.connect(g);
  g.connect(dest);
  src.start(when, clip.a / sr() + offset, dur);
  return src;
}

/* ---------- 视图坐标 ---------- */
function fmtTime(t) {
  if (!isFinite(t)) return '—';
  if (t < 60) return t.toFixed(2) + 's';
  var m = Math.floor(t / 60);
  var s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}

function timeToX(t) {
  if (!edit.viewDur) return 0;
  return (t - edit.viewStart) / edit.viewDur * waveCanvas.clientWidth;
}

function xToTime(x) {
  var w = waveCanvas.clientWidth || 1;
  return edit.viewStart + (x / w) * edit.viewDur;
}

function clampView() {
  var dur = Math.max(timelineDur(), 0.5);
  edit.viewDur = clampNum(edit.viewDur || dur, Math.min(0.05, dur), dur);
  edit.viewStart = clampNum(edit.viewStart, 0, Math.max(0, dur - edit.viewDur));
}

function setCacheDirty() { edit.cacheKey = ''; }

/* ---------- 状态 ---------- */
function editControls() {
  var has = !!edit.srcBuf;
  var hasSel = !!(edit.sel && Math.abs(edit.sel[1] - edit.sel[0]) > 0.01);
  var hasClip = !!edit.selClip;

  ['btnCut', 'btnTrim', 'btnSilence', 'btnReverse', 'btnNorm', 'btnFadeIn', 'btnFadeOut',
   'btnEditPlay', 'btnEditStop', 'btnEditWav', 'btnEditMp3', 'btnZoomIn', 'btnZoomOut',
   'btnZoomFit', 'btnTrimSilence', 'btnSplit'].forEach(function (id) {
    var el = $(id);
    if (el) el.disabled = !has;
  });
  var bc = $('btnCopy'); if (bc) bc.disabled = !hasSel;
  var bp = $('btnPaste'); if (bp) bp.disabled = !(has && edit.clip);
  var bd = $('btnDelClip'); if (bd) bd.disabled = !hasClip;
  var bu = $('btnUndo'); if (bu) bu.disabled = edit.undo.length === 0;
  var br = $('btnRedo'); if (br) br.disabled = edit.redo.length === 0;
}

function updateStatus() {
  var dur = timelineDur();
  $('stDur').textContent = edit.srcBuf ? fmtTime(dur) : '—';
  $('stPos').textContent = fmtTime(edit.playhead);
  $('stZoom').textContent = edit.srcBuf ? (edit.viewDur >= dur - 0.001 ? '全宽' : fmtTime(edit.viewDur)) : '—';
  if ($('stClips')) $('stClips').textContent = edit.srcBuf ? edit.clips.length + ' 段' : '—';

  if (edit.sel && Math.abs(edit.sel[1] - edit.sel[0]) > 0.01) {
    var a = Math.min(edit.sel[0], edit.sel[1]);
    var b = Math.max(edit.sel[0], edit.sel[1]);
    $('stSel').textContent = fmtTime(a) + ' – ' + fmtTime(b) + '（' + (b - a).toFixed(2) + 's）';
  } else {
    $('stSel').textContent = '未选择';
  }

  if (edit.srcBuf) {
    var r = (edit.sel && Math.abs(edit.sel[1] - edit.sel[0]) > 0.01)
      ? [Math.min(edit.sel[0], edit.sel[1]), Math.max(edit.sel[0], edit.sel[1])] : null;
    var peak = 0;
    if (r) {
      forEachSrcRange(r[0], r[1], function (sa, sb) {
        var p2 = scanPeak(sa, sb);
        if (p2 > peak) peak = p2;
      });
    } else {
      peak = globalPeak();
    }
    $('stPeak').textContent = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) + ' dBFS' : '-∞';
  } else {
    $('stPeak').textContent = '—';
  }
  editControls();
}

/* ---------- 画布 ---------- */
function fitWave() {
  waveCanvas = $('wave');
  wctx = waveCanvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.floor(waveCanvas.clientWidth * dpr);
  waveCanvas.height = Math.floor(WAVE_H * dpr);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setCacheDirty();
  drawWave();
}

function niceStep(range) {
  var steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (var i = 0; i < steps.length; i++) if (range / steps[i] <= 10) return steps[i];
  return 600;
}

function tickLabel(t, step) {
  if (step < 1) return t.toFixed(2);
  if (t >= 60) {
    var m = Math.floor(t / 60);
    var s = Math.round(t - m * 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  return Math.round(t) + 's';
}

function cacheKeyNow(w) {
  var parts = [w, WAVE_H, edit.viewStart.toFixed(4), edit.viewDur.toFixed(4),
               edit.srcBuf ? edit.srcBuf.length : 0];
  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    parts.push(c.a + ':' + c.b + ':' + c.start.toFixed(4));
  }
  parts.push(edit.selClip ? edit.selClip.id : 0);
  return parts.join('|');
}

function rebuildCache(w, h) {
  var dpr = window.devicePixelRatio || 1;
  var c = document.createElement('canvas');
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  var cc = c.getContext('2d');
  cc.setTransform(dpr, 0, 0, dpr, 0, 0);
  edit.cache = c;

  var t0 = edit.viewStart, t1 = edit.viewStart + edit.viewDur;

  cc.fillStyle = uiPick('#fcfcf9', '#171d1b');
  cc.fillRect(0, 0, w, RULER_H);

  var step = niceStep(edit.viewDur);
  cc.font = '10px ui-monospace, Consolas, monospace';
  cc.textBaseline = 'middle';

  for (var t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    var x = (t - t0) / edit.viewDur * w;
    if (x < -40 || x > w + 40) continue;
    cc.strokeStyle = uiPick('#eeede7', '#2b3531');
    cc.beginPath();
    cc.moveTo(Math.round(x) + 0.5, RULER_H);
    cc.lineTo(Math.round(x) + 0.5, h);
    cc.stroke();
    cc.fillStyle = '#a3a29a';
    cc.fillText(tickLabel(t, step), x + 4, RULER_H / 2);
  }

  cc.strokeStyle = uiPick('#e6e5de', '#333d38');
  cc.beginPath();
  cc.moveTo(0, RULER_H - 0.5);
  cc.lineTo(w, RULER_H - 0.5);
  cc.stroke();

  var data = edit.srcBuf.getChannelData(0);
  var CLIP_TOP = RULER_H + 8;
  var CLIP_H = h - RULER_H - 16;
  var HDR = 15;

  for (var i = 0; i < edit.clips.length; i++) {
    var cl = edit.clips[i];
    var x0 = (cl.start - t0) / edit.viewDur * w;
    var x1 = (clipEnd(cl) - t0) / edit.viewDur * w;
    if (x1 < -30 || x0 > w + 30) continue;

    var cw = Math.max(2, x1 - x0);
    var selected = edit.selClip && edit.selClip.id === cl.id;

    cc.fillStyle = selected ? 'rgba(15,110,86,0.13)' : 'rgba(15,110,86,0.05)';
    roundRect(cc, x0, CLIP_TOP, cw, CLIP_H, 5);
    cc.fill();

    cc.save();
    cc.beginPath();
    roundRect(cc, x0, CLIP_TOP, cw, CLIP_H, 5);
    cc.clip();

    cc.fillStyle = selected ? 'rgba(15,110,86,0.22)' : 'rgba(15,110,86,0.10)';
    cc.fillRect(x0, CLIP_TOP, cw, HDR);

    var mid = CLIP_TOP + HDR + (CLIP_H - HDR) / 2;
    var half = (CLIP_H - HDR) / 2 - 6;

    cc.strokeStyle = selected ? '#0b5a46' : '#2f8a70';
    cc.lineWidth = 1;
    cc.beginPath();

    var pStart = Math.max(0, Math.floor(x0));
    var pEnd = Math.min(w, Math.ceil(x1));
    var span = cl.b - cl.a;

    for (var px = pStart; px < pEnd; px++) {
      var fa = (px - x0) / cw;
      var fb = (px + 1 - x0) / cw;
      var sa = cl.a + Math.floor(fa * span);
      var sb = cl.a + Math.floor(fb * span);
      sa = Math.max(cl.a, Math.min(cl.b - 1, sa));
      sb = Math.max(sa + 1, Math.min(cl.b, sb));
      var mm = peakRange(sa, sb);
      cc.moveTo(px + 0.5, mid - mm[1] * half);
      cc.lineTo(px + 0.5, mid - mm[0] * half);
    }
    cc.stroke();

    if (cw > 44) {
      cc.fillStyle = selected ? '#085041' : '#3d8a74';
      cc.font = '10px ui-monospace, Consolas, monospace';
      cc.fillText('音频 ' + clipDur(cl).toFixed(2) + 's', x0 + 7, CLIP_TOP + HDR / 2 + 1);
    }

    cc.restore();

    cc.strokeStyle = selected ? '#0b5a46' : '#8fcbb6';
    cc.lineWidth = selected ? 2 : 1;
    roundRect(cc, x0 + 0.5, CLIP_TOP + 0.5, cw - 1, CLIP_H - 1, 5);
    cc.stroke();

    if (cw > 16) {
      cc.fillStyle = selected ? '#0b5a46' : 'rgba(15,110,86,0.40)';
      cc.fillRect(x0 + 1, CLIP_TOP + 5, 3, CLIP_H - 10);
      cc.fillRect(x0 + cw - 4, CLIP_TOP + 5, 3, CLIP_H - 10);
    }
  }
}

function drawWave() {
  if (!wctx) return;
  var w = waveCanvas.clientWidth, h = WAVE_H;
  wctx.clearRect(0, 0, w, h);

  if (!edit.srcBuf) {
    wctx.strokeStyle = uiPick('#e9efea', '#2a312e');
    wctx.lineWidth = 1;
    wctx.setLineDash([6, 6]);
    wctx.strokeRect(10.5, 10.5, Math.max(0, w - 21), Math.max(0, h - 21));
    wctx.setLineDash([]);
    wctx.fillStyle = '#8c988f';
    wctx.font = '13px system-ui, sans-serif';
    wctx.textAlign = 'center';
    wctx.fillText('导入音频或载入录音，然后在标尺上拖动框选', w / 2, h / 2);
    wctx.textAlign = 'start';
    drawOverview();
    return;
  }

  if (!edit.viewDur) { edit.viewDur = Math.max(timelineDur(), 0.5); edit.viewStart = 0; }
  clampView();

  var key = cacheKeyNow(w);
  if (key !== edit.cacheKey) {
    rebuildCache(w, h);
    edit.cacheKey = key;
  }
  wctx.drawImage(edit.cache, 0, 0, w, h);

  if (edit.sel) {
    var a = Math.min(edit.sel[0], edit.sel[1]);
    var b = Math.max(edit.sel[0], edit.sel[1]);
    var x0 = timeToX(a), x1 = timeToX(b);
    if (x1 - x0 > 0.5) {
      wctx.fillStyle = 'rgba(15,110,86,0.12)';
      wctx.fillRect(x0, RULER_H, x1 - x0, h - RULER_H);
      wctx.strokeStyle = uiPick('#0f6e56', '#3fb994');
      wctx.lineWidth = 2;
      wctx.beginPath();
      wctx.moveTo(x0, RULER_H); wctx.lineTo(x0, h);
      wctx.moveTo(x1, RULER_H); wctx.lineTo(x1, h);
      wctx.stroke();
      wctx.fillStyle = '#0f6e56';
      roundRect(wctx, x0 - 3, RULER_H, 6, 15, 2); wctx.fill();
      roundRect(wctx, x1 - 3, RULER_H, 6, 15, 2); wctx.fill();
      roundRect(wctx, x0 - 3, h - 15, 6, 15, 2); wctx.fill();
      roundRect(wctx, x1 - 3, h - 15, 6, 15, 2); wctx.fill();

      var lab = (b - a).toFixed(2) + 's';
      wctx.font = '11px ui-monospace, Consolas, monospace';
      var tw = wctx.measureText(lab).width + 16;
      var cx = clampNum((x0 + x1) / 2 - tw / 2, 2, Math.max(2, w - tw - 2));
      wctx.fillStyle = 'rgba(15,110,86,0.94)';
      roundRect(wctx, cx, RULER_H + 8, tw, 18, 4); wctx.fill();
      wctx.fillStyle = '#fff';
      wctx.textAlign = 'center';
      wctx.fillText(lab, cx + tw / 2, RULER_H + 21);
      wctx.textAlign = 'left';
    }
  }

  var pxp = timeToX(edit.playhead);
  if (pxp >= -60 && pxp <= w + 60) {
    wctx.strokeStyle = uiPick('#d1463f', '#e0706a');
    wctx.lineWidth = 1.5;
    wctx.beginPath();
    wctx.moveTo(pxp, RULER_H - 2);
    wctx.lineTo(pxp, h);
    wctx.stroke();

    var hw = 46, hh = 17;
    var hx = clampNum(pxp - hw / 2, 0, Math.max(0, w - hw));
    wctx.fillStyle = '#d1463f';
    roundRect(wctx, hx, 2, hw, hh, 3); wctx.fill();
    wctx.fillStyle = '#fff';
    wctx.font = '10px ui-monospace, Consolas, monospace';
    wctx.textAlign = 'center';
    wctx.fillText(edit.playhead.toFixed(2) + 's', hx + hw / 2, 13);
    wctx.textAlign = 'left';
  }

  drawOverview();
}

/* ---------- 概览条 ---------- */
var ovCanvas = null, ovctx = null, ovPeaks = null, ovKey = '', ovDrag = false;

function fitOverview() {
  ovCanvas = $('overview');
  ovctx = ovCanvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  ovCanvas.width = Math.floor(ovCanvas.clientWidth * dpr);
  ovCanvas.height = Math.floor(42 * dpr);
  ovctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ovPeaks = null;
  drawOverview();
}

function drawOverview() {
  if (!ovctx) return;
  var w = ovCanvas.clientWidth, h = 42;
  ovctx.clearRect(0, 0, w, h);

  if (!edit.srcBuf) {
    ovctx.fillStyle = '#d9d8d1';
    ovctx.fillRect(0, h / 2 - 0.5, w, 1);
    return;
  }

  var key = w + '|' + edit.srcBuf.length;
  if (key !== ovKey || !ovPeaks) {
    ovPeaks = computePeaks(edit.srcBuf.getChannelData(0), Math.floor(w));
    ovKey = key;
  }

  var mid = h / 2, half = h / 2 - 5;
  ovctx.strokeStyle = '#cbcac2';
  ovctx.lineWidth = 1;
  ovctx.beginPath();
  for (var x = 0; x < ovPeaks.length / 2; x++) {
    ovctx.moveTo(x + 0.5, mid - ovPeaks[x * 2 + 1] * half);
    ovctx.lineTo(x + 0.5, mid - ovPeaks[x * 2] * half);
  }
  ovctx.stroke();

  var dur = Math.max(timelineDur(), 0.001);
  var vx = 0, vw = w;
  if (edit.viewDur < dur - 0.001) {
    vx = edit.viewStart / dur * w;
    vw = Math.max(8, edit.viewDur / dur * w);
  }
  ovctx.fillStyle = 'rgba(255,255,255,0.6)';
  ovctx.fillRect(vx, 0, vw, h);
  ovctx.strokeStyle = '#0f6e56';
  ovctx.lineWidth = 1.5;
  ovctx.strokeRect(vx + 0.75, 1, vw - 1.5, h - 2);

  var px = clampNum(edit.playhead / dur, 0, 1) * w;
  ovctx.strokeStyle = '#d1463f';
  ovctx.lineWidth = 1.5;
  ovctx.beginPath();
  ovctx.moveTo(px, 0);
  ovctx.lineTo(px, h);
  ovctx.stroke();
}

function ovSeek(clientX) {
  if (!edit.srcBuf) return;
  var r = ovCanvas.getBoundingClientRect();
  var dur = Math.max(timelineDur(), 0.001);
  var ratio = clampNum((clientX - r.left) / r.width, 0, 1);
  edit.viewStart = clampNum(ratio * dur - edit.viewDur / 2, 0, Math.max(0, dur - edit.viewDur));
  setCacheDirty();
  updateStatus();
  drawWave();
}

/* ---------- 撤销 ---------- */
function beginOp() {
  edit.pending = { clipsBefore: cloneClips(), clipsAfter: null, ranges: [] };
}

function commitOp() {
  if (!edit.pending) return;
  edit.pending.clipsAfter = cloneClips();
  edit.undo.push(edit.pending);
  if (edit.undo.length > 30) edit.undo.shift();
  edit.redo.length = 0;
  edit.pending = null;
  scheduleSave();
}

function abortOp() {
  edit.pending = null;
}

function applyPatches(entry, which) {
  if (!entry.ranges || !entry.ranges.length) return;
  for (var i = 0; i < entry.ranges.length; i++) {
    var r = entry.ranges[i];
    var ch = edit.srcBuf.getChannelData(r.ch);
    ch.set(r[which], r.start);
  }
  edit.peakCache = { buf: null, val: 0 };
  edit.pyramid = null;
  ovPeaks = null;
}

function setClips(list) {
  edit.clips = list.map(function (c) { return { id: c.id, a: c.a, b: c.b, start: c.start }; });
}

function undoEdit() {
  if (!edit.undo.length) return;
  var e = edit.undo.pop();
  applyPatches(e, 'before');
  setClips(e.clipsBefore);
  edit.redo.push(e);
  edit.sel = null;
  edit.selClip = null;
  afterChange();
}

function redoEdit() {
  if (!edit.redo.length) return;
  var e = edit.redo.pop();
  applyPatches(e, 'after');
  setClips(e.clipsAfter || e.clipsBefore);
  edit.undo.push(e);
  edit.sel = null;
  edit.selClip = null;
  afterChange();
}

function afterChange() {
  sortClips();
  if (edit.selClip && edit.clips.indexOf(edit.selClip) === -1) edit.selClip = null;
  setCacheDirty();
  var dur = timelineDur();
  if (edit.viewDur > dur) edit.viewDur = Math.max(dur, 0.5);
  edit.playhead = clampNum(edit.playhead, 0, Math.max(0, dur));
  updateStatus();
  drawWave();
}

/* ---------- 载入 ---------- */
function loadBuffer(buf) {
  edit.srcBuf = buf;
  edit.clips = [{ id: nid(), a: 0, b: buf.length, start: 0 }];
  edit.sel = null;
  edit.selClip = null;
  edit.undo = [];
  edit.redo = [];
  edit.playhead = 0;
  edit.viewStart = 0;
  edit.viewDur = Math.max(buf.duration, 0.5);
  edit.cacheKey = '';
  ovPeaks = null;
  updateStatus();
  drawWave();
  updateAudioAlignButton();
  scheduleSave();
}

/* ---------- 编辑 */
function selectionRange() {
  if (!edit.sel) return null;
  var a = Math.min(edit.sel[0], edit.sel[1]);
  var b = Math.max(edit.sel[0], edit.sel[1]);
  if (b - a < 0.005) return null;
  return [a, b];
}

function splitRaw(t) {
  var c = clipAtTime(t);
  if (!c) return false;
  var off = Math.round((t - c.start) * sr());
  if (off <= 20 || off >= (c.b - c.a) - 20) return false;
  var right = { id: nid(), a: c.a + off, b: c.b, start: t };
  c.b = c.a + off;
  edit.clips.push(right);
  sortClips();
  return true;
}

function splitAtPlayhead() {
  if (!edit.srcBuf) return;
  beginOp();
  if (!splitRaw(edit.playhead)) {
    abortOp();
    setPill('这里切不开：播放头要在片段内部，且离两端都留有空间');
    setTimeout(function () { setPill(state.deviceName || '已连接', 'on'); }, 2200);
    return;
  }
  commitOp();
  afterChange();
}

function deleteRange(a, b) {
  if (!edit.srcBuf || b <= a) return false;
  var len = b - a;
  var rate = sr();
  var out = [];

  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    var s = c.start, e = clipEnd(c);

    if (e <= a + 1e-9) { out.push(c); continue; }
    if (s >= b - 1e-9) { c.start = s - len; out.push(c); continue; }

    var leftLen = Math.max(0, a - s);
    var rightLen = Math.max(0, e - b);

    if (leftLen > 2 / rate) {
      out.push({ id: nid(), a: c.a, b: c.a + Math.round(leftLen * rate), start: s });
    }
    if (rightLen > 2 / rate) {
      out.push({ id: nid(), a: c.b - Math.round(rightLen * rate), b: c.b, start: a });
    }
  }

  edit.clips = out;
  sortClips();
  return true;
}

function cutSelection() {
  var r = selectionRange();
  if (!r) return;
  beginOp();
  deleteRange(r[0], r[1]);
  commitOp();
  edit.sel = null;
  edit.selClip = null;
  edit.playhead = Math.min(edit.playhead, r[0]);
  afterChange();
}

function deleteSelectedClip() {
  if (!edit.selClip) return;
  var c = edit.selClip;
  beginOp();
  deleteRange(c.start, clipEnd(c));
  commitOp();
  edit.selClip = null;
  edit.sel = null;
  afterChange();
}

function trimToSelection() {
  var r = selectionRange();
  if (!r) return;
  beginOp();
  var rate = sr();
  var kept = [];

  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    var s = c.start, e = clipEnd(c);
    if (e <= r[0] || s >= r[1]) continue;
    var ns = Math.max(s, r[0]);
    var ne = Math.min(e, r[1]);
    var na = c.a + Math.round((ns - s) * rate);
    var nb = na + Math.round((ne - ns) * rate);
    if (nb - na < 20) continue;
    kept.push({ id: nid(), a: na, b: nb, start: ns - r[0] });
  }

  edit.clips = kept;
  edit.sel = null;
  edit.selClip = null;
  edit.playhead = 0;
  edit.viewStart = 0;
  edit.viewDur = Math.max(timelineDur(), 0.5);
  commitOp();
  afterChange();
}

function forEachSrcRange(a, b, fn) {
  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    var s = c.start, e = clipEnd(c);
    var os = Math.max(s, a), oe = Math.min(e, b);
    if (oe <= os) continue;
    var sa = c.a + Math.round((os - s) * sr());
    var sb = c.a + Math.round((oe - s) * sr());
    if (sb > sa) fn(sa, sb);
  }
}

function effectOnSelection(fn) {
  var r = selectionRange();
  if (!r) return;

  var ranges = [];
  forEachSrcRange(r[0], r[1], function (sa, sb) { ranges.push([sa, sb]); });
  if (!ranges.length) return;

  beginOp();
  var entry = edit.pending;
  var chans = edit.srcBuf.numberOfChannels;

  for (var i = 0; i < ranges.length; i++) {
    for (var c = 0; c < chans; c++) {
      var d = edit.srcBuf.getChannelData(c);
      entry.ranges.push({
        ch: c,
        start: ranges[i][0],
        before: d.slice(ranges[i][0], ranges[i][1]),
        after: null
      });
    }
  }

  for (var k = 0; k < ranges.length; k++) fn(ranges[k][0], ranges[k][1]);

  for (var m = 0; m < entry.ranges.length; m++) {
    var rr = entry.ranges[m];
    rr.after = edit.srcBuf.getChannelData(rr.ch).slice(rr.start, rr.start + rr.before.length);
  }

  commitOp();
  edit.peakCache = { buf: null, val: 0 };
  edit.pyramid = null;
  ovPeaks = null;
  ovKey = '';
  setCacheDirty();
  ovPeaks = null;
  updateStatus();
  drawWave();
}

function silenceSelection() {
  effectOnSelection(function (sa, sb) {
    for (var c = 0; c < edit.srcBuf.numberOfChannels; c++) {
      edit.srcBuf.getChannelData(c).fill(0, sa, sb);
    }
  });
}

function reverseSelection() {
  effectOnSelection(function (sa, sb) {
    for (var c = 0; c < edit.srcBuf.numberOfChannels; c++) {
      var d = edit.srcBuf.getChannelData(c);
      var seg = d.slice(sa, sb);
      seg.reverse();
      d.set(seg, sa);
    }
  });
}

function normalizeSelection() {
  var r = selectionRange();
  if (!r) return;
  var peak = 0;
  forEachSrcRange(r[0], r[1], function (sa, sb) {
    for (var c = 0; c < edit.srcBuf.numberOfChannels; c++) {
      var d = edit.srcBuf.getChannelData(c);
      for (var i = sa; i < sb; i++) {
        var v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
  });
  if (peak < 0.0005) return;
  var g = 0.97 / peak;
  effectOnSelection(function (sa, sb) {
    for (var c = 0; c < edit.srcBuf.numberOfChannels; c++) {
      var d = edit.srcBuf.getChannelData(c);
      for (var i = sa; i < sb; i++) d[i] *= g;
    }
  });
}

function fadeSelection(kind) {
  var r = selectionRange();
  if (!r) return;
  effectOnSelection(function (sa, sb) {
    var span = sb - sa;
    if (span < 4) return;
    for (var c = 0; c < edit.srcBuf.numberOfChannels; c++) {
      var d = edit.srcBuf.getChannelData(c);
      for (var i = 0; i < span; i++) {
        var k = i / span;
        d[sa + i] *= kind === 'in' ? k : (1 - k);
      }
    }
  });
}

function trimSilence() {
  if (!edit.srcBuf) return;
  var th = 0.002;
  var rate = sr();
  var d = edit.srcBuf.getChannelData(0);
  var startSec = null, endSec = null;

  // 逐个片段找首/末个有声采样。必须每段都比对一遍：
  // 只取第一段会把 endSec 落在第一段末尾，后面的片段会被整段删掉。
  for (var ci = 0; ci < edit.clips.length; ci++) {
    var c = edit.clips[ci];
    var from = Math.max(0, c.a);
    var to = Math.min(c.b, d.length);
    if (to <= from) continue;

    var first = -1, last = -1;
    for (var p = from; p < to; p++) {
      if (Math.abs(d[p]) > th) { first = p; break; }
    }
    if (first < 0) continue;
    for (var q = to - 1; q >= from; q--) {
      if (Math.abs(d[q]) > th) { last = q; break; }
    }

    var s0 = c.start + (first - c.a) / rate;
    var s1 = c.start + (last - c.a) / rate + 0.02;
    if (startSec === null || s0 < startSec) startSec = s0;
    if (endSec === null || s1 > endSec) endSec = s1;
  }

  if (startSec === null || endSec === null) { alert('整段几乎都是静音。'); return; }

  beginOp();
  deleteRange(endSec, timelineDur() + 1);
  deleteRange(0, startSec);
  commitOp();
  edit.sel = null;
  edit.selClip = null;
  edit.playhead = 0;
  afterChange();
}

function copySelection() {
  var r = selectionRange();
  if (!r) return;
  var ranges = [], total = 0;
  forEachSrcRange(r[0], r[1], function (sa, sb) {
    ranges.push({ a: sa, b: sb });
    total += (sb - sa) / sr();
  });
  if (!ranges.length) return;
  edit.clip = { ranges: ranges, total: total };
  updateStatus();
}

function pasteAtPlayhead() {
  if (!edit.clip || !edit.srcBuf) return;
  var t = edit.playhead;
  var rate = sr();
  var chans = edit.srcBuf.numberOfChannels;

  var totalSamples = 0;
  edit.clip.ranges.forEach(function (rg) { totalSamples += (rg.b - rg.a); });
  if (!totalSamples) return;

  beginOp();

  var oldBuf = edit.srcBuf;
  var oldLen = oldBuf.length;
  var newBuf = actx.createBuffer(chans, oldLen + totalSamples, oldBuf.sampleRate);

  for (var c = 0; c < chans; c++) {
    var dst = newBuf.getChannelData(c);
    dst.set(oldBuf.getChannelData(c), 0);
  }

  var writeAt = oldLen;
  var newRanges = [];
  edit.clip.ranges.forEach(function (rg) {
    var len = rg.b - rg.a;
    for (var c2 = 0; c2 < chans; c2++) {
      newBuf.getChannelData(c2).set(oldBuf.getChannelData(c2).subarray(rg.a, rg.b), writeAt);
    }
    newRanges.push({ a: writeAt, b: writeAt + len });
    writeAt += len;
  });

  edit.srcBuf = newBuf;
  edit.peakCache = { buf: null, val: 0 };
  ovPeaks = null;

  splitRaw(t);

  for (var i = 0; i < edit.clips.length; i++) {
    var cl = edit.clips[i];
    if (cl.start >= t - 1e-9) cl.start += edit.clip.total;
  }

  var pos = t;
  newRanges.forEach(function (rg2) {
    edit.clips.push({ id: nid(), a: rg2.a, b: rg2.b, start: pos });
    pos += (rg2.b - rg2.a) / rate;
  });

  edit.playhead = pos;
  commitOp();
  afterChange();
}

/* ---------- 播放 ---------- */
function animateWave() {
  if (!edit.playing) return;
  if (edit.srcBuf && edit.viewDur < timelineDur() - 0.001 && actx) {
    var t = edit.playFrom + (actx.currentTime - edit.playCtxStart);
    if (t > edit.viewStart + edit.viewDur * 0.92 || t < edit.viewStart) {
      edit.viewStart = clampNum(t - edit.viewDur * 0.25, 0, Math.max(0, timelineDur() - edit.viewDur));
      setCacheDirty();
    }
  }
  drawWave();
  requestAnimationFrame(animateWave);
}

function editPlay() {
  if (!edit.srcBuf || !edit.clips.length) return;
  initLive();
  if (actx.state === 'suspended') actx.resume();
  stopEditPlay();

  var r = selectionRange();
  var from = r ? r[0] : edit.playhead;
  var to = r ? r[1] : timelineDur();
  if (from >= to - 0.01) from = 0;

  var base = actx.currentTime + 0.06;
  var rate = sr();
  var scheduled = 0;
  edit.sources = [];

  edit.clips.forEach(function (c) {
    var s = c.start, e = clipEnd(c);
    if (e <= from || s >= to) return;
    var startAt = Math.max(s, from);
    var endAt = Math.min(e, to);
    var off = startAt - s;
    var dur = endAt - startAt;
    if (dur <= 0.01) return;

    var src = scheduleClipAt(actx, actx.destination, c, base + (startAt - from), off, dur);
    edit.sources.push(src);
    scheduled++;
  });

  if (!scheduled) return;

  edit.playing = true;
  edit.playFrom = from;
  edit.playTo = to;
  edit.playCtxStart = base;
  animateWave();

  edit.endTimer = setTimeout(function () {
    if (!edit.playing) return;
    if (edit.loop) { edit.playing = false; editPlay(); return; }
    edit.playing = false;
    edit.playhead = to;
    updateStatus();
    drawWave();
  }, (to - from) * 1000 + 150);
}

function stopEditPlay() {
  if (edit.endTimer) { clearTimeout(edit.endTimer); edit.endTimer = null; }
  (edit.sources || []).forEach(function (s) { try { s.stop(0); } catch (e) {} });
  edit.sources = [];
  if (actx && edit.playing) {
    var t = edit.playFrom + (actx.currentTime - edit.playCtxStart);
    edit.playhead = clampNum(t, 0, timelineDur());
  }
  edit.playing = false;
  updateStatus();
  drawWave();
}

async function renderTimeline() {
  if (!edit.srcBuf || !edit.clips.length) return null;
  var dur = timelineDur();
  var ac = new OfflineAudioContext(2, Math.max(1, Math.ceil((dur + 0.3) * 44100)), 44100);
  var rate = sr();
  var declk = edit.declk || 0;
  var sorted = edit.clips.slice().sort(function (a, b) { return a.start - b.start; });

  for (var i = 0; i < sorted.length; i++) {
    var c = sorted[i];
    var cEnd = clipEnd(c);
    var fadeIn = declk, fadeOut = declk;
    // 与前一/后一片段重叠时，用完整重叠时长做交叉淡化
    if (i > 0) {
      var oPrev = Math.min(clipEnd(sorted[i - 1]), cEnd) - c.start;
      if (oPrev > 0.001) fadeIn = Math.max(fadeIn, oPrev);
    }
    if (i + 1 < sorted.length) {
      var oNext = Math.min(cEnd, clipEnd(sorted[i + 1])) - sorted[i + 1].start;
      if (oNext > 0.001) fadeOut = Math.max(fadeOut, oNext);
    }
    scheduleClipAt(ac, ac.destination, c, c.start, 0, clipDur(c), fadeIn, fadeOut);
  }
  return await ac.startRendering();
}

function exportEditWav() {
  renderTimeline().then(function (buf) {
    if (buf) download(encodeWav(buf), 'edit_' + stamp() + '.wav');
  });
}

async function exportEditMp3() {
  if (!window.lamejs) { alert('MP3 编码器没有加载成功。'); return; }
  $('btnEditMp3').disabled = true;
  setPill('编码 MP3…');
  try {
    var buf = await renderTimeline();
    if (buf) download(await encodeMp3Blob(buf), 'edit_' + stamp() + '.mp3');
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('MP3 导出失败：' + e.message);
  }
  $('btnEditMp3').disabled = false;
}

/* ---------- 导入 ---------- */
async function loadTakeForEdit() {
  var notes = state.notes.filter(function (n) { return n.tOff !== null; });
  if (!notes.length) { alert('还没有录音。先录一段，或点「导入音频」。'); return; }
  initLive();
  setPill('合成音频…');
  try {
    var buf = await renderOffline();
    if (!buf) return;
    loadBuffer(buf);
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('合成失败：' + e.message);
  }
}

async function importAudioFile(file) {
  initLive();
  setPill('读取音频…');
  try {
    var ab = await file.arrayBuffer();
    var buf = await actx.decodeAudioData(ab);
    if (buf.numberOfChannels === 1) {
      var mono = buf.getChannelData(0);
      var stereo = actx.createBuffer(2, buf.length, buf.sampleRate);
      stereo.copyToChannel(mono, 0);
      stereo.copyToChannel(mono, 1);
      buf = stereo;
    }
    loadBuffer(buf);
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('这个文件读不了：' + e.message);
    setPill(state.deviceName || '已连接', 'on');
  }
}

/* ---------- 缩放 ---------- */
function zoomBy(factor, anchorSec) {
  if (!edit.srcBuf) return;
  var dur = Math.max(timelineDur(), 0.5);
  var newDur = clampNum(edit.viewDur * factor, Math.min(0.05, dur), dur);
  var frac = clampNum((anchorSec - edit.viewStart) / edit.viewDur, 0, 1);
  edit.viewStart = anchorSec - frac * newDur;
  edit.viewDur = newDur;
  clampView();
  setCacheDirty();
  updateStatus();
  drawWave();
}

function zoomFit() {
  if (!edit.srcBuf) return;
  edit.viewStart = 0;
  edit.viewDur = Math.max(timelineDur(), 0.5);
  setCacheDirty();
  updateStatus();
  drawWave();
}

function snapTime(t, e) {
  if (e && e.altKey) return clampNum(t, 0, Math.max(timelineDur(), 0));
  var grid = 0.05;
  var s = Math.round(t / grid) * grid;
  if (Math.abs(s - t) < grid * 0.55) t = s;
  if (Math.abs(t) < grid) t = 0;
  return clampNum(t, 0, Math.max(timelineDur(), 0));
}

/* ---------- 交互 ---------- */
function localX(e) {
  return e.clientX - waveCanvas.getBoundingClientRect().left;
}

function hitClip(x) {
  if (!edit.srcBuf) return null;
  var t = xToTime(x);
  for (var i = 0; i < edit.clips.length; i++) {
    var c = edit.clips[i];
    var e = clipEnd(c);
    if (t >= c.start - 1e-9 && t <= e + 1e-9) {
      var x0 = timeToX(c.start), x1 = timeToX(e);
      if (Math.abs(x - x0) < 7) return { clip: c, zone: 'left' };
      if (Math.abs(x - x1) < 7) return { clip: c, zone: 'right' };
      return { clip: c, zone: 'body' };
    }
  }
  return null;
}

function onWaveDown(e) {
  if (!edit.srcBuf) return;
  waveCanvas.focus();
  var x = localX(e);
  var y = e.clientY - waveCanvas.getBoundingClientRect().top;

  if (y < RULER_H || e.shiftKey) {
    var t0 = snapTime(clampNum(xToTime(x), 0, Math.max(timelineDur(), 0)), e);
    dragMode = 'new';
    edit.sel = [t0, t0];
    edit.selClip = null;
    drawWave();
    return;
  }

  var hit = hitClip(x);
  if (!hit) {
    edit.selClip = null;
    edit.playhead = snapTime(clampNum(xToTime(x), 0, Math.max(timelineDur(), 0)), e);
    dragMode = 'seek';
    updateStatus();
    drawWave();
    return;
  }

  edit.selClip = hit.clip;
  beginOp();
  dragPushed = true;
  dragClip = hit.clip;
  dragOrigin = { x: x, start: hit.clip.start, a: hit.clip.a, b: hit.clip.b };
  dragMode = hit.zone === 'body' ? 'move' : (hit.zone === 'left' ? 'trimLeft' : 'trimRight');
  updateStatus();
  drawWave();
}

function onWaveMove(e) {
  if (!dragMode || !edit.srcBuf) return;
  var x = localX(e);
  var w = waveCanvas.clientWidth || 1;
  var dt = (x - dragOrigin.x) / w * edit.viewDur;

  if (dragMode === 'new') {
    edit.sel[1] = snapTime(clampNum(xToTime(x), 0, Math.max(timelineDur(), 0)), e);
  } else if (dragMode === 'seek') {
    edit.playhead = snapTime(clampNum(xToTime(x), 0, Math.max(timelineDur(), 0)), e);
  } else if (dragClip) {
    var rate = sr();
    var b = neighborBounds(dragClip);

    if (dragMode === 'move') {
      var dur = (dragOrigin.b - dragOrigin.a) / rate;
      var raw = dragOrigin.start + dt;
      var ns = clampNum(raw, b[0], Math.max(b[0], b[1] - dur));
      dragClip.start = snapTime(ns, e);
      if (dragClip.start < b[0]) dragClip.start = b[0];
      if (dragClip.start + dur > b[1]) dragClip.start = Math.max(b[0], b[1] - dur);
    } else if (dragMode === 'trimLeft') {
      var d0 = (dragOrigin.b - dragOrigin.a) / rate;
      var maxStart = dragOrigin.start + d0 - 0.05;
      var nStart = clampNum(dragOrigin.start + dt, b[0], maxStart);
      var delta = Math.round((nStart - dragOrigin.start) * rate);
      var na = clampNum(dragOrigin.a + delta, 0, dragOrigin.b - 20);
      dragClip.a = na;
      dragClip.start = dragOrigin.start + (na - dragOrigin.a) / rate;
    } else if (dragMode === 'trimRight') {
      var end0 = dragOrigin.start + (dragOrigin.b - dragOrigin.a) / rate;
      var maxEnd = Math.min(b[1], dragOrigin.start + (edit.srcBuf.length - dragOrigin.a) / rate);
      var nEnd = clampNum(end0 + dt, dragOrigin.start + 0.05, maxEnd);
      var nb = dragOrigin.a + Math.round((nEnd - dragOrigin.start) * rate);
      dragClip.b = Math.min(nb, edit.srcBuf.length);
      if (dragClip.b < dragClip.a + 20) dragClip.b = dragClip.a + 20;
    }
    setCacheDirty();
  }

  updateStatus();
  drawWave();
}

function onWaveUp() {
  if (!dragMode) return;

  if (dragMode === 'new' && edit.sel && Math.abs(edit.sel[1] - edit.sel[0]) < 0.015) {
    edit.playhead = edit.sel[0];
    edit.sel = null;
  }

  if (dragPushed) {
    var changed = dragClip && dragOrigin &&
      (dragClip.start !== dragOrigin.start || dragClip.a !== dragOrigin.a || dragClip.b !== dragOrigin.b);
    if (changed) commitOp(); else abortOp();
    dragPushed = false;
  }

  dragMode = null;
  dragClip = null;
  dragOrigin = null;
  sortClips();
  setCacheDirty();
  updateStatus();
  drawWave();
}

/* ---------- 自检 ---------- */
function runSelfTest() {
  document.querySelectorAll('[data-workspace]').forEach(function (el) {
    if (el === document.body || el.classList.contains('workspace-tab')) return;
    el.classList.remove('workspace-hidden');
  });
  fitRoll();
  fitWave();
  fitOverview();
  var out = [];
  function ok(name, cond, extra) {
    out.push((cond ? 'PASS|' : 'FAIL|') + name + (extra ? '|' + extra : ''));
  }

  var ac = new OfflineAudioContext(2, 44100 * 2, 44100);
  var buf = ac.createBuffer(2, 44100 * 2, 44100);
  for (var c = 0; c < 2; c++) {
    var d = buf.getChannelData(c);
    for (var i = 0; i < d.length; i++) d[i] = Math.sin(i / 20) * 0.5;
  }

  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();

  loadBuffer(buf);
  ok('载入后 1 段', edit.clips.length === 1, '段数 ' + edit.clips.length);
  ok('总时长 2.00s', Math.abs(timelineDur() - 2) < 0.01, timelineDur().toFixed(3));

  edit.playhead = 1.0;
  splitAtPlayhead();
  ok('在 1.0s 分割成 2 段', edit.clips.length === 2, '段数 ' + edit.clips.length);
  ok('分割点位置正确', edit.clips.length === 2 && Math.abs(edit.clips[1].start - 1) < 0.002,
     edit.clips.length === 2 ? edit.clips[1].start.toFixed(3) : '-');

  var beforeDur = timelineDur();

  edit.sel = [0.4, 0.6];
  cutSelection();
  ok('删除 0.2s 后时长 1.80s', Math.abs(timelineDur() - 1.8) < 0.02, timelineDur().toFixed(3));
  ok('删除中段产生 3 段（左右不连续）', edit.clips.length === 3, '段数 ' + edit.clips.length);
  ok('后半段左移贴合', Math.abs(edit.clips[1].start - 0.4) < 0.02, edit.clips[1].start.toFixed(3));

  undoEdit();
  ok('撤销恢复 2.00s', Math.abs(timelineDur() - 2) < 0.02, timelineDur().toFixed(3));

  redoEdit();
  ok('重做回到 1.80s', Math.abs(timelineDur() - 1.8) < 0.02, timelineDur().toFixed(3));

  var clip = edit.clips[0];
  var bnd = neighborBounds(clip);
  var wantStart = -0.5;
  var clamped = Math.max(bnd[0], Math.min(wantStart, bnd[1] - clipDur(clip)));
  clip.start = clamped;
  sortClips();
  ok('向左拖越界被钳制', clamped >= 0 - 0.001, 'start=' + clamped.toFixed(3));
  ok('允许重叠（bounds 放开）', bnd[0] === 0 && bnd[1] === Infinity,
     'bnd=' + bnd[0] + ',' + bnd[1]);

  // 交叉淡化：重叠片段按重叠时长淡入淡出，调度不抛错
  (function () {
    var okNoThrow = false;
    try {
      var ac3 = new OfflineAudioContext(2, 44100, 44100);
      scheduleClipAt(ac3, ac3.destination, { id: 901, a: 0, b: 22050, start: 0 }, 0, 0, 0.5, 0.25, 0.25);
      scheduleClipAt(ac3, ac3.destination, { id: 902, a: 22050, b: 44100, start: 0.25 }, 0.25, 0, 0.5, 0.25, 0.25);
      okNoThrow = true;
    } catch (e) {}
    ok('交叉淡化调度不抛错', okNoThrow, okNoThrow ? 'ok' : '抛错');
  })();

  edit.sel = [0, timelineDur()];
  copySelection();
  ok('复制生成剪贴板', !!edit.clip && edit.clip.ranges.length > 0);

  edit.playhead = 0;
  pasteAtPlayhead();
  ok('粘贴后段数增加', edit.clips.length >= 3, '段数 ' + edit.clips.length);

  edit.sel = [0, timelineDur()];
  cutSelection();
  ok('全选删除后无片段', edit.clips.length === 0, '段数 ' + edit.clips.length);
  ok('全选删除后时长为 0', timelineDur() === 0, timelineDur().toFixed(3));

  undoEdit();
  ok('撤销恢复全部片段', edit.clips.length > 0, '段数 ' + edit.clips.length);
  ok('撤销后时长恢复', timelineDur() > 0.05, timelineDur().toFixed(3));

  ok('识别 mp3（无 MIME）', !!pickAudio([{ name: 'a.mp3', type: '' }]));
  ok('识别 wav（有 MIME）', !!pickAudio([{ name: 'a.wav', type: 'audio/wav' }]));
  ok('识别 flac', !!pickAudio([{ name: 'a.flac', type: '' }]));
  ok('拒绝非音频', pickAudio([{ name: 'a.txt', type: 'text/plain' }]) === null);
  ok('多文件取第一个音频', pickAudio([{ name: 'x.txt', type: 'text/plain' }, { name: 'y.mp3', type: '' }]).name === 'y.mp3');

  loadBuffer(buf);
  var idx = Math.round(0.3 * 44100);
  var origVal = edit.srcBuf.getChannelData(0)[idx];
  ok('取样点非零', Math.abs(origVal) > 0.01, origVal.toFixed(3));

  edit.sel = [0.2, 0.5];
  silenceSelection();
  ok('静音生效', Math.abs(edit.srcBuf.getChannelData(0)[idx]) < 1e-6, edit.srcBuf.getChannelData(0)[idx].toFixed(4));
  undoEdit();
  ok('撤销还原采样', Math.abs(edit.srcBuf.getChannelData(0)[idx] - origVal) < 1e-6, edit.srcBuf.getChannelData(0)[idx].toFixed(4));
  redoEdit();
  ok('重做再次静音', Math.abs(edit.srcBuf.getChannelData(0)[idx]) < 1e-6, edit.srcBuf.getChannelData(0)[idx].toFixed(4));

  loadBuffer(buf);
  edit.sel = [0, 0.5];
  copySelection();
  edit.playhead = 0.6;
  var srcLenBefore = edit.srcBuf.length;
  pasteAtPlayhead();
  var pasted = null;
  for (var pi = 0; pi < edit.clips.length; pi++) {
    if (edit.clips[pi].a >= srcLenBefore) pasted = edit.clips[pi];
  }
  ok('粘贴写入独立副本', !!pasted, pasted ? ('a=' + pasted.a) : '未找到');
  ok('源缓冲已扩容', edit.srcBuf.length > srcLenBefore, edit.srcBuf.length + ' vs ' + srcLenBefore);

  renderTimeline().then(function (mixed) {
    ok('合成结果非空', !!mixed && mixed.length > 0, mixed ? (mixed.length + ' 帧') : 'null');

    var meta = serializeMeta();
    ok('工程序列化含片段', meta.clips.length === edit.clips.length, 'clips=' + meta.clips.length);
    ok('工程序列化含音符', Array.isArray(meta.notes), 'notes=' + meta.notes.length);
    ok('工程序列化含参数', meta.bpm > 0 && typeof meta.gridDiv === 'number', 'bpm=' + meta.bpm);
    ok('工程序列化不含音频数据', meta.audio === undefined && meta.audioBlob === undefined, '仅元数据');

    /* ---- Web MIDI 事件入口 ---- */
    (function () {
      var keepRec = state.recording, keepT0 = state.t0, keepNotes = state.notes, keepPend = state.pending;
      var keepCcs = state.ccs;
      state.recording = true;
      state.t0 = performance.now() - 1000;
      state.notes = [];
      state.pending = {};
      state.ccs = [];

      ok('USB 消息交给 handleMessage', applyMidiEvent(new Uint8Array([0x90, 60, 100]), 0) === true,
         'pending=' + Object.keys(state.pending).length);
      ok('USB Note On 进入 pending', !!state.pending[60], JSON.stringify(state.pending[60] || null));

      applyMidiEvent(new Uint8Array([0x80, 60, 0]), 120);
      ok('USB Note Off 落成音符', state.notes.length === 1 && state.notes[0].pitch === 60,
         'notes=' + state.notes.length);

      var ignored = applyMidiEvent(new Uint8Array([0xF8]), 200);
      ok('系统实时消息被忽略', ignored === false, 'ret=' + ignored);

      applyMidiEvent(new Uint8Array([0xB0, 64, 127]), 240);
      ok('USB 踏板 CC 被记录', state.ccs.length === 1 && state.ccs[0].cc === 64,
         'ccs=' + state.ccs.length);

      state.recording = keepRec; state.t0 = keepT0;
      state.notes = keepNotes; state.pending = keepPend; state.ccs = keepCcs;
    })();
    /* ---- 本轮修复的回归用例 ---- */

    var ac2 = new OfflineAudioContext(2, 44100 * 3, 44100);
    var tb = ac2.createBuffer(2, 44100 * 2, 44100);
    var td0 = tb.getChannelData(0), td1 = tb.getChannelData(1);
    for (var ti = 0; ti < 44100; ti++) { td0[ti] = Math.sin(ti / 20) * 0.5; td1[ti] = td0[ti]; }
    for (var tj = Math.floor(44100 * 1.2); tj < 44100 * 2; tj++) { td0[tj] = Math.sin(tj / 20) * 0.5; td1[tj] = td0[tj]; }

    // 1) 裁掉静音不能把后面的片段一起删掉
    loadBuffer(tb);
    splitRaw(1.0);
    if (edit.clips[1]) edit.clips[1].start = 1.2;
    afterChange();
    var clipsBefore = edit.clips.length, durBefore = timelineDur();
    trimSilence();
    ok('裁静音保留全部片段', edit.clips.length === clipsBefore, clipsBefore + ' -> ' + edit.clips.length);
    ok('裁静音未截断时间轴', timelineDur() > durBefore - 0.4, durBefore.toFixed(2) + ' -> ' + timelineDur().toFixed(2));

    // 2) 原地特效必须让概览条缓存失效
    loadBuffer(tb);
    drawOverview();
    edit.sel = [0.1, 0.9];
    silenceSelection();
    drawOverview();
    var cols = Math.floor((ovPeaks ? ovPeaks.length : 0) / 2);
    var zc = 0, tc = 0;
    for (var vi = Math.floor(cols * 0.10); vi < Math.floor(cols * 0.40); vi++) {
      tc++;
      if (Math.abs(ovPeaks[vi * 2]) < 0.001 && Math.abs(ovPeaks[vi * 2 + 1]) < 0.001) zc++;
    }
    ok('特效后概览波形已刷新', tc > 0 && zc >= tc * 0.9, zc + '/' + tc + ' 列为静音');

    // 3) 附点音符要按附点计拍
    try {
      var dotNote = new Vex.Flow.StaveNote({ clef: 'treble', keys: ['c/4'], duration: 'h', dots: 1, auto_stem: true });
      ok('附点二分计 3 拍', dotNote.getTicks().value() === 12288, 'ticks=' + dotNote.getTicks().value());
    } catch (e3) {
      ok('附点二分计 3 拍', false, e3.message);
    }

    // 4) 升号调不出现重升/重降
    var badAcc = 0;
    [6, 1, 11, 5].forEach(function (tt) {
      var kk = keyInfoFor(tt);
      for (var pp = 0; pp < 12; pp++) { if (Math.abs(kk.spelling[pp].acc) > 1) badAcc++; }
    });
    ok('升号调无重升号', badAcc === 0, '越界 ' + badAcc + ' 个');

    // 小调识别与调号
    var kiAm = keyInfoFor(9, 'minor');
    ok('A 小调调号为 0 升 0 降', kiAm.sig === 0 && kiAm.sigName === 'C', kiAm.sigName);
    var kiEm = keyInfoFor(4, 'minor');
    ok('E 小调调号为 1 升', kiEm.sig === 1 && kiEm.sigName === 'G', kiEm.sigName);
    var kiCm = keyInfoFor(0, 'major');
    ok('C 大调显示名', keyDisplayName(kiCm) === 'C 大调', keyDisplayName(kiCm));
    ok('A 小调显示名', keyDisplayName(kiAm) === 'a 小调', keyDisplayName(kiAm));

    // 用 A 自然小调音集验证 detectKey 返回小调
    var minorScale = [9, 11, 0, 2, 4, 5, 7].map(function (pc) {
      return { pitch: 60 + pc, vel: 90, tOn: pc * 200, tOff: pc * 200 + 400 };
    });
    var dk = detectKey(minorScale);
    ok('detectKey 识别小调', dk.mode === 'minor' || dk.tonicPc === 9 || dk.tonicPc === 0,
       dk.tonicPc + '/' + dk.mode);

    // 跨小节延音线：长音不截断，拆成带 tie 的两段
    var kn = state.notes, ks = state.timeSig, kb = state.bpm, kg = state.gridDiv;
    state.notes = [{ pitch: 60, vel: 90, tOn: 0, tOff: 6000 }];
    state.bpm = 60; state.timeSig = '4/4'; state.gridDiv = 2;
    var scTie = buildScore();
    var tieM0 = (scTie.treble[0] || []).filter(function (it) { return it.tie; });
    var tieM1 = (scTie.treble[1] || []).filter(function (it) { return it.tie; });
    ok('长音跨小节产生延音标记', tieM0.length === 1 && tieM1.length === 1,
       'm0=' + tieM0.length + ' m1=' + tieM1.length);
    ok('延音链 tieId 一致', tieM0.length && tieM1.length && tieM0[0].tieId === tieM1[0].tieId,
       tieM0[0] && tieM1[0] ? (tieM0[0].tieId + ' vs ' + tieM1[0].tieId) : '无');
    var sum0 = (scTie.treble[0] || []).reduce(function (a, it) { return a + it.b; }, 0);
    var sum1 = (scTie.treble[1] || []).reduce(function (a, it) { return a + it.b; }, 0);
    ok('第一小节拍数完整', Math.abs(sum0 - 4) < 0.01, 'sum=' + sum0);
    ok('第二小节拍数完整', Math.abs(sum1 - 4) < 0.01, 'sum=' + sum1);
    state.notes = kn; state.timeSig = ks; state.bpm = kb; state.gridDiv = kg;

    // 版本快照摘要
    ok('快照摘要-音符', snapMeta({ notes: [{}, {}, {}], clips: [] }) === '3 个音符',
       snapMeta({ notes: [{}, {}, {}], clips: [] }));
    ok('快照摘要-音频', snapMeta({ notes: [], clips: [{}, {}] }) === '2 段音频',
       snapMeta({ notes: [], clips: [{}, {}] }));
    ok('快照摘要-空', snapMeta({ notes: [], clips: [] }) === '空', snapMeta({ notes: [], clips: [] }));

    // 5) 3/4 的补白小节必须是 3 拍
    var keepNotes = state.notes, keepSig = state.timeSig, keepBpm = state.bpm;
    state.notes = [
      { pitch: 72, vel: 90, tOn: 0, tOff: 400 },
      { pitch: 74, vel: 90, tOn: 2000, tOff: 2400 },
      { pitch: 76, vel: 90, tOn: 4000, tOff: 4400 }
    ];
    state.timeSig = '3/4';
    state.bpm = 90;
    var sc2 = buildScore();
    var badBar = 0;
    sc2.bass.forEach(function (bar) {
      var sum = bar.reduce(function (a, it) { return a + it.b; }, 0);
      if (Math.abs(sum - 3) > 0.01) badBar++;
    });
    ok('3/4 补白小节为 3 拍', badBar === 0, '异常小节 ' + badBar + ' 个');
    state.notes = keepNotes; state.timeSig = keepSig; state.bpm = keepBpm;

    // 6) BLE-MIDI 报文解析
    var P1 = createMidiParser();
    var r1 = P1.feed(new Uint8Array([0x80, 0x80, 0x90, 0x3C, 0x64]));
    ok('单消息包（梵西格式）', r1.length === 1 && r1[0].msg[0] === 0x90 && r1[0].msg[1] === 0x3C && r1[0].msg[2] === 0x64,
       JSON.stringify(r1));

    var P2 = createMidiParser();
    var r2 = P2.feed(new Uint8Array([0x80, 0x80, 0x90, 0x3C, 0x64, 0x81, 0x80, 0x3C, 0x00]));
    ok('一包两条消息且各自带时间戳', r2.length === 2 && r2[0].ts === 0 && r2[1].ts === 1 && r2[1].msg[0] === 0x80,
       'ts=' + r2.map(function (m) { return m.ts; }).join(','));

    var P3 = createMidiParser();
    var r3 = P3.feed(new Uint8Array([0x80 | 0x05, 0x80, 0x90, 0x3C, 0x64]));
    ok('包头携带时间戳高位', r3.length === 1 && r3[0].ts === 640, 'ts=' + (r3[0] || {}).ts);

    var P4 = createMidiParser();
    var r4 = P4.feed(new Uint8Array([0x80, 0x80, 0x90, 0x3C, 0x64, 0x80, 0x3C, 0x00]));
    ok('省略后续时间戳时沿用上一个', r4.length === 2 && r4[1].msg[0] === 0x80 && r4[1].ts === r4[0].ts,
       'ts=' + r4.map(function (m) { return m.ts; }).join(','));

    var P5 = createMidiParser();
    var r5a = P5.feed(new Uint8Array([0x80, 0x80, 0x90, 0x3C]));
    var r5b = P5.feed(new Uint8Array([0x80, 0x64]));
    ok('跨包消息能拼接', r5a.length === 0 && r5b.length === 1 && r5b[0].msg[2] === 0x64,
       r5a.length + ' + ' + JSON.stringify(r5b));

    ok('解析器不再引用旧函数', typeof decodePacket === 'undefined' && typeof midiCarry === 'undefined',
       'decodePacket=' + typeof decodePacket + ' midiCarry=' + typeof midiCarry);

    /* ---- MIDI 文件导入 ---- */
    (function () {
      var track = [
        0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,
        0x00, 0xFF, 0x03, 0x04, 0x54, 0x65, 0x73, 0x74,
        0x00, 0x90, 0x3C, 0x64,
        0x83, 0x60, 0x80, 0x3C, 0x00,
        0x00, 0xFF, 0x2F, 0x00
      ];
      var midiBytes = new Uint8Array([
        0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xE0,
        0x4D, 0x54, 0x72, 0x6B, 0x00, 0x00, 0x00, 0x1C
      ].concat(track));
      var parsed = parseMidiData(midiBytes);
      ok('MIDI 头与 PPQ 解析', parsed.format === 1 && parsed.ppq === 480, 'ppq=' + parsed.ppq);
      ok('MIDI 轨道名称解析', parsed.tracks.length === 1 && parsed.tracks[0].name === 'Test', parsed.tracks[0].name);
      ok('MIDI 音符解析', parsed.tracks[0].notes.length === 1 && parsed.tracks[0].notes[0].pitch === 60 && parsed.tracks[0].notes[0].vel === 100,
         'notes=' + parsed.tracks[0].notes.length);
      ok('MIDI Tick 转毫秒', Math.abs(parsed.tracks[0].notes[0].tOff - 500) < 0.1, 'tOff=' + parsed.tracks[0].notes[0].tOff.toFixed(1));
      ok('MIDI 速度与拍号解析', parsed.bpm === 120 && parsed.timeSig === '4/4', parsed.bpm + ' BPM ' + parsed.timeSig);
    })();

    /* ---- MIDI 音符编辑器 ---- */
    (function () {
      var keepNotes = state.notes, keepBpm = state.bpm, keepGrid = state.gridDiv;
      var keepSel = noteEdit.selected, keepUndo = noteEdit.undo, keepRedo = noteEdit.redo;

      ok('音名 C4', noteNameOf(60) === 'C4', noteNameOf(60));
      ok('音名 C#4', noteNameOf(61) === 'C#4', noteNameOf(61));
      ok('音名 A0', noteNameOf(21) === 'A0', noteNameOf(21));

      state.notes = [
        { pitch: 60, vel: 100, tOn: 0, tOff: 500 },
        { pitch: 64, vel: 80, tOn: 600, tOff: 1100 },
        { pitch: 67, vel: 110, tOn: 1200, tOff: 1700 }
      ];
      state.bpm = 120; state.gridDiv = 2;
      noteEdit.undo = []; noteEdit.redo = [];

      noteEdit.selected = 1;
      transposeNotes(2);
      ok('选中音符移调 +2', state.notes[1].pitch === 66, 'pitch=' + state.notes[1].pitch);
      ok('移调不影响其它音符', state.notes[0].pitch === 60 && state.notes[2].pitch === 67,
         state.notes[0].pitch + ',' + state.notes[2].pitch);
      noteEdit.undo = []; noteEdit.redo = [];

      noteEdit.selected = -1;
      transposeNotes(-12);
      ok('全体移调 -12', state.notes[0].pitch === 48 && state.notes[1].pitch === 54 && state.notes[2].pitch === 55,
         state.notes.map(function (n) { return n.pitch; }).join(','));
      noteEdit.undo = []; noteEdit.redo = [];

      state.notes = [{ pitch: 60, vel: 100, tOn: 130, tOff: 410 }];
      noteEdit.selected = -1;
      quantizeNotes();
      ok('量化 tOn 到网格', Math.abs(state.notes[0].tOn - 250) < 1, 'tOn=' + state.notes[0].tOn.toFixed(0));

      state.notes = [
        { pitch: 60, vel: 100, tOn: 0, tOff: 500 },
        { pitch: 64, vel: 80, tOn: 600, tOff: 1100 }
      ];
      noteEdit.selected = 0; noteEdit.undo = []; noteEdit.redo = [];
      deleteSelectedNote();
      ok('删除选中音符', state.notes.length === 1 && state.notes[0].pitch === 64, 'n=' + state.notes.length);

      noteUndo();
      ok('撤销恢复音符', state.notes.length === 2 && state.notes[0].pitch === 60, 'n=' + state.notes.length);
      noteRedo();
      ok('重做再次删除', state.notes.length === 1 && state.notes[0].pitch === 64, 'n=' + state.notes.length);

      var snap = noteSnapshot();
      state.notes[0].vel = 10;
      noteRestore(snap);
      ok('快照还原力度', state.notes[0].vel === 80, 'vel=' + state.notes[0].vel);

      state.notes = [{ pitch: 21, vel: 100, tOn: 0, tOff: 500 }];
      noteEdit.selected = 0; noteEdit.undo = []; noteEdit.redo = [];
      transposeNotes(-1);
      ok('移调越界不改变', state.notes[0].pitch === 21, 'pitch=' + state.notes[0].pitch);

      state.notes = keepNotes; state.bpm = keepBpm; state.gridDiv = keepGrid;
      noteEdit.selected = keepSel; noteEdit.undo = keepUndo; noteEdit.redo = keepRedo;
    })();

    var pass = out.filter(function (s) { return s.indexOf('PASS|') === 0; }).length;
    var box = document.createElement('pre');
    box.id = 'selftestOut';
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#fff;font:12px monospace;padding:8px;border:1px solid #ccc;white-space:pre';
    box.textContent = out.join('\n');
    document.body.appendChild(box);
    document.title = 'SELFTEST ' + pass + '/' + out.length;
  });
}

/* ---------- 绑定 ---------- */
waveCanvas = $('wave');

$('btnImport').addEventListener('click', function () { $('fileInput').click(); });
$('fileInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (f) importAudioFile(f);
  e.target.value = '';
});
$('btnFromTake').addEventListener('click', loadTakeForEdit);
$('btnMidiImport').addEventListener('click', function () { $('midiFileInput').click(); });
$('midiFileInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (f) importMIDIFile(f);
  e.target.value = '';
});
$('btnMidiLoad').addEventListener('click', loadSelectedMidiTracks);
$('btnMidiClear').addEventListener('click', clearMidiImport);
$('btnMidiClearCc').addEventListener('click', function () {
  state.ccs = [];
  $('mCc').textContent = '0';
  renderMidiCcEditor();
  scheduleSave();
});
$('btnSplit').addEventListener('click', splitAtPlayhead);
$('btnDelClip').addEventListener('click', deleteSelectedClip);
$('btnCut').addEventListener('click', cutSelection);
$('btnTrim').addEventListener('click', trimToSelection);
$('btnCopy').addEventListener('click', copySelection);
$('btnPaste').addEventListener('click', pasteAtPlayhead);
$('btnSilence').addEventListener('click', silenceSelection);
$('btnReverse').addEventListener('click', reverseSelection);
$('btnNorm').addEventListener('click', normalizeSelection);
$('btnFadeIn').addEventListener('click', function () { fadeSelection('in'); });
$('btnFadeOut').addEventListener('click', function () { fadeSelection('out'); });
$('btnTrimSilence').addEventListener('click', trimSilence);
$('btnUndo').addEventListener('click', undoEdit);
$('btnRedo').addEventListener('click', redoEdit);
$('btnEditPlay').addEventListener('click', editPlay);
$('btnEditStop').addEventListener('click', stopEditPlay);
$('btnEditWav').addEventListener('click', exportEditWav);
$('btnEditMp3').addEventListener('click', exportEditMp3);
$('btnZoomIn').addEventListener('click', function () { zoomBy(0.6, edit.playhead); });
$('btnZoomOut').addEventListener('click', function () { zoomBy(1.7, edit.playhead); });
$('btnZoomFit').addEventListener('click', zoomFit);
$('chkLoop').addEventListener('change', function (e) { edit.loop = e.target.checked; });

waveCanvas.addEventListener('pointerdown', function (e) {
  e.preventDefault();
  try { waveCanvas.setPointerCapture(e.pointerId); } catch (err) {}
  onWaveDown(e);
});
waveCanvas.addEventListener('pointermove', onWaveMove);
waveCanvas.addEventListener('pointerup', function (e) {
  onWaveUp();
  try { waveCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
});
waveCanvas.addEventListener('pointercancel', function (e) {
  onWaveUp();
  try { waveCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
});

waveCanvas.addEventListener('pointermove', function (e) {
  if (dragMode || !edit.srcBuf) return;
  var x = localX(e);
  var y = e.clientY - waveCanvas.getBoundingClientRect().top;
  var c = 'default';
  var hit = hitClip(x);
  if (y < RULER_H) c = 'pointer';
  else if (hit) c = hit.zone === 'body' ? 'grab' : 'ew-resize';
  waveCanvas.style.cursor = c;
});

waveCanvas.addEventListener('wheel', function (e) {
  if (!edit.srcBuf) return;
  e.preventDefault();
  if (e.shiftKey) {
    edit.viewStart += (e.deltaY > 0 ? 1 : -1) * edit.viewDur * 0.15;
    clampView();
    setCacheDirty();
    updateStatus();
    drawWave();
    return;
  }
  var t = clampNum(xToTime(localX(e)), 0, Math.max(timelineDur(), 0));
  zoomBy(e.deltaY > 0 ? 1.2 : 0.83, t);
}, { passive: false });

waveCanvas.addEventListener('keydown', function (e) {
  if (!edit.srcBuf) return;
  var k = e.key;
  var meta = e.ctrlKey || e.metaKey;

  if (k === ' ') {
    e.preventDefault();
    if (edit.playing) stopEditPlay(); else editPlay();
  } else if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    if (edit.selClip && !edit.sel) deleteSelectedClip(); else cutSelection();
  } else if (meta && k.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoEdit(); else undoEdit();
  } else if (meta && k.toLowerCase() === 'y') {
    e.preventDefault();
    redoEdit();
  } else if (meta && k.toLowerCase() === 'c') {
    e.preventDefault();
    copySelection();
  } else if (meta && k.toLowerCase() === 'v') {
    e.preventDefault();
    pasteAtPlayhead();
  } else if (meta && k.toLowerCase() === 'b') {
    e.preventDefault();
    splitAtPlayhead();
  } else if (k === 'ArrowLeft') {
    e.preventDefault();
    edit.playhead = clampNum(edit.playhead - (e.shiftKey ? 1 : 0.1), 0, Math.max(timelineDur(), 0));
    updateStatus(); drawWave();
  } else if (k === 'ArrowRight') {
    e.preventDefault();
    edit.playhead = clampNum(edit.playhead + (e.shiftKey ? 1 : 0.1), 0, Math.max(timelineDur(), 0));
    updateStatus(); drawWave();
  }
});

fitOverview();
ovCanvas.addEventListener('pointerdown', function (e) {
  e.preventDefault();
  ovDrag = true;
  try { ovCanvas.setPointerCapture(e.pointerId); } catch (err) {}
  ovSeek(e.clientX);
});
ovCanvas.addEventListener('pointermove', function (e) { if (ovDrag) ovSeek(e.clientX); });
ovCanvas.addEventListener('pointerup', function (e) {
  ovDrag = false;
  try { ovCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
});
ovCanvas.addEventListener('pointercancel', function (e) {
  ovDrag = false;
  try { ovCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
});

/* ---------- 拖拽导入 ---------- */
function pickAudio(files) {
  var exts = /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|aif|aiff|mp4)$/i;
  if (!files) return null;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f) continue;
    if ((f.type && f.type.indexOf('audio/') === 0) || exts.test(f.name || '')) return f;
  }
  return null;
}

(function setupDrop() {
  var counter = 0;

  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
    return false;
  }

  window.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    counter++;
    document.body.classList.add('drop-active');
  });

  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    counter = Math.max(0, counter - 1);
    if (e.relatedTarget === null) counter = 0;
    if (counter === 0) document.body.classList.remove('drop-active');
  });

  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    counter = 0;
    document.body.classList.remove('drop-active');

    var files = e.dataTransfer.files;
    if (!files || !files.length) return;

    for (var k = 0; k < files.length; k++) {
      if (/\.json$/i.test(files[k].name || '')) { importProject(files[k]); return; }
      if (/\.midi?$/i.test(files[k].name || '')) { importMIDIFile(files[k]); return; }
    }

    var f = pickAudio(files);
    if (!f) {
      alert('拖进来的不是音频、MIDI 或工程文件。支持 mp3 / wav / m4a / flac / ogg / mid / midi / json。');
      return;
    }
    importAudioFile(f);
  });
})();

updateStatus();

/* ============================================================
   工程保存：IndexedDB 自动存 + .json 工程文件
   ============================================================ */
var DB_NAME = 'piano-desk';
var DB_STORE = 'projects';
var saveTimer = null;
var pendingSnapshot = null;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function idbOpen() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbPut(key, val) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readonly');
      var req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbDel(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
    });
  });
}

function idbGetAll() {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readonly');
      var store = tx.objectStore(DB_STORE);
      var keysReq = store.getAllKeys();
      keysReq.onsuccess = function () {
        var keys = keysReq.result || [];
        var valsReq = store.getAll();
        valsReq.onsuccess = function () {
          var vals = valsReq.result || [];
          var out = [];
          for (var i = 0; i < keys.length; i++) out.push({ key: keys[i], val: vals[i] });
          resolve(out);
        };
        valsReq.onerror = function () { reject(valsReq.error); };
      };
      keysReq.onerror = function () { reject(keysReq.error); };
    });
  });
}

/* ============================================================
   版本快照
   ============================================================ */
var SNAP_MAX = 20;

function snapMeta(v) {
  var parts = [];
  if (v.clips && v.clips.length) parts.push(v.clips.length + ' 段音频');
  if (v.notes && v.notes.length) parts.push(v.notes.length + ' 个音符');
  return parts.join(' · ') || '空';
}

function snapTimestamp(key) {
  var m = String(key).match(/^snap_(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function pruneSnapshots() {
  return idbGetAll().then(function (rows) {
    var snaps = rows.filter(function (r) { return String(r.key).indexOf('snap_') === 0; })
      .sort(function (a, b) { return snapTimestamp(b.key) - snapTimestamp(a.key); });
    if (snaps.length <= SNAP_MAX) return true;
    return Promise.all(snaps.slice(SNAP_MAX).map(function (s) { return idbDel(s.key); })).then(function () { return true; });
  });
}

function saveSnapshot(silent) {
  if (!state.notes.length && !edit.srcBuf) return Promise.resolve(false);
  var meta = serializeMeta();
  if (edit.srcBuf) {
    try { meta.audioBlob = encodeWav(edit.srcBuf); } catch (e) {}
  }
  var key = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  return idbPut(key, meta).then(function () {
    return pruneSnapshots();
  }).then(function () {
    listSnapshots();
    if (!silent) {
      var d = new Date();
      setPill('已保存版本 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()), 'on');
    }
    return true;
  }).catch(function () {
    if (!silent) alert('快照保存失败（可能是存储空间不足）');
    return false;
  });
}

function listSnapshots() {
  var host = $('snapList');
  if (!host) return;
  idbGetAll().then(function (rows) {
    var snaps = rows.filter(function (r) { return String(r.key).indexOf('snap_') === 0; })
      .sort(function (a, b) { return snapTimestamp(b.key) - snapTimestamp(a.key); });
    if (!snaps.length) {
      host.innerHTML = '<p class="hint">还没有快照。点「保存当前版本」记录一个可恢复的历史点。</p>';
      return;
    }
    host.textContent = '';
    snaps.forEach(function (s) {
      var ts = snapTimestamp(s.key);
      var d = new Date(ts);
      var v = s.val || {};
      var row = document.createElement('div');
      row.className = 'snap-row';

      var info = document.createElement('div');
      info.className = 'snap-info';
      var b = document.createElement('b');
      b.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      var span = document.createElement('span');
      span.textContent = snapMeta(v);
      info.appendChild(b);
      info.appendChild(span);

      var btns = document.createElement('div');
      btns.className = 'snap-btns';
      var restore = document.createElement('button');
      restore.className = 'btn mini';
      restore.type = 'button';
      restore.textContent = '恢复';
      restore.addEventListener('click', function () {
        if (!confirm('恢复这个版本会覆盖当前内容，确定吗？')) return;
        applyProject(v).then(function () {
          setPill('已恢复到 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()), 'on');
          scheduleSave();
        });
      });
      var del = document.createElement('button');
      del.className = 'btn mini danger';
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        if (!confirm('删除这个版本？')) return;
        idbDel(s.key).then(function () { listSnapshots(); });
      });
      btns.appendChild(restore);
      btns.appendChild(del);
      row.appendChild(info);
      row.appendChild(btns);
      host.appendChild(row);
    });
  }).catch(function () {});
}

function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsDataURL(blob);
  });
}

function base64ToBuffer(b64) {
  var bin = atob(b64);
  var len = bin.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function serializeMeta() {
  return {
    v: 1,
    ts: Date.now(),
    notes: state.notes.map(function (n) {
      return { pitch: n.pitch, vel: n.vel, tOn: n.tOn, tOff: n.tOff };
    }),
    bpm: state.bpm,
    gridDiv: state.gridDiv,
    timeSig: state.timeSig,
    keyOverride: state.keyOverride,
    clips: edit.clips.map(function (c) { return { id: c.id, a: c.a, b: c.b, start: c.start }; }),
    nextId: edit.nextId,
    playhead: edit.playhead,
    hasAudio: !!edit.srcBuf
  };
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doAutosave, 1200);
}

function doAutosave() {
  saveTimer = null;
  if (!state.notes.length && !edit.srcBuf) return;

  var meta = serializeMeta();
  if (edit.srcBuf) {
    try { meta.audioBlob = encodeWav(edit.srcBuf); } catch (e) {}
  }

  idbPut('autosave', meta).then(function () {
    var el = $('savedHint');
    if (el) {
      var d = new Date();
      el.textContent = '已自动保存 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
  }).catch(function () {
    var el = $('savedHint');
    if (el) el.textContent = '自动保存失败（可能是存储空间不足）';
  });
}

async function applyProject(snap) {
  initLive();
  if (actx.state === 'suspended') actx.resume();

  state.bpm = snap.bpm || 90;
  state.gridDiv = snap.gridDiv || 2;
  state.timeSig = snap.timeSig || '4/4';
  $('timeSig').value = state.timeSig;
  state.keyOverride = snap.keyOverride || 'auto';
  $('bpm').value = state.bpm;
  $('bpmVal').textContent = state.bpm;
  syncBpmLabel();
  $('grid').value = String(state.gridDiv);
  $('keySel').value = state.keyOverride;

  state.notes = (snap.notes || []).map(function (n) {
    return { pitch: n.pitch, vel: n.vel, tOn: n.tOn, tOff: n.tOff };
  });
  state.pending = {};
  state.ccs = [];
  state.lastDur = state.notes.length
    ? Math.max.apply(null, state.notes.map(function (n) { return n.tOff; })) / 1000 : 0;
  $('mNotes').textContent = state.notes.length;
  $('mTime').textContent = state.lastDur.toFixed(1) + 's';
  $('mCc').textContent = '0';
  practiceSyncBounds();

  edit.undo = [];
  edit.redo = [];
  edit.sel = null;
  edit.selClip = null;

  noteEdit.selected = -1;
  noteEdit.undo = [];
  noteEdit.redo = [];
  noteEdit.drag = null;
  velDragStart = null;

  var audioBuf = null;
  try {
    if (snap.audioBlob) {
      audioBuf = await actx.decodeAudioData(await snap.audioBlob.arrayBuffer());
    } else if (snap.audio) {
      audioBuf = await actx.decodeAudioData(base64ToBuffer(snap.audio));
    }
  } catch (e) {
    audioBuf = null;
  }

  if (audioBuf) {
    edit.srcBuf = audioBuf;
    edit.clips = (snap.clips || []).map(function (c) {
      return { id: c.id, a: c.a, b: c.b, start: c.start };
    });
    var maxId = 0;
    edit.clips.forEach(function (c) { if (c.id > maxId) maxId = c.id; });
    edit.nextId = Math.max(snap.nextId || 1, maxId + 1);
    if (!edit.clips.length) {
      edit.clips = [{ id: nid(), a: 0, b: audioBuf.length, start: 0 }];
    }
    edit.playhead = Math.min(snap.playhead || 0, timelineDur());
    edit.viewStart = 0;
    edit.viewDur = Math.max(timelineDur(), 0.5);
    edit.cacheKey = '';
    ovPeaks = null;
  } else {
    edit.srcBuf = null;
    edit.clips = [];
    edit.viewDur = 0;
  }

  updateStatus();
  buildScore();
  renderAll();
  if (state.notes.length || edit.srcBuf) {
    ['btnPlay', 'btnMidi', 'btnWav', 'btnMp3', 'btnStop'].forEach(function (id) {
      $(id).disabled = !(state.notes.length > 0);
    });
  }
  updateMini();
}

async function exportProject() {
  setPill('打包工程…');
  try {
    var meta = serializeMeta();
    if (edit.srcBuf) meta.audio = await blobToBase64(encodeWav(edit.srcBuf));
    var json = JSON.stringify(meta);
    download(new Blob([json], { type: 'application/json' }), 'piano_project_' + stamp() + '.json');
    setPill(state.deviceName || '已连接', 'on');
  } catch (e) {
    alert('工程导出失败：' + e.message);
    setPill(state.deviceName || '已连接', 'on');
  }
}

async function importProject(file) {
  try {
    var text = await file.text();
    var snap = JSON.parse(text);
    if (!snap || snap.v === undefined) throw new Error('不是有效的工程文件');
    await applyProject(snap);
    scheduleSave();
    setPill('工程已载入', 'on');
    setTimeout(function () { setPill(state.deviceName || '已连接', 'on'); }, 1600);
  } catch (e) {
    alert('打开工程失败：' + e.message);
  }
}

function checkAutosave() {
  idbGet('autosave').then(function (snap) {
    if (!snap) return;
    var hasNotes = snap.notes && snap.notes.length;
    var hasClips = snap.clips && snap.clips.length;
    if (!hasNotes && !hasClips) return;

    pendingSnapshot = snap;
    var d = new Date(snap.ts || Date.now());
    var parts = [];
    if (hasClips) parts.push(snap.clips.length + ' 段音频');
    if (hasNotes) parts.push(snap.notes.length + ' 个音符');
    $('restoreText').textContent = '发现上次的工作：' + parts.join('、')
      + '（' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '）';
    $('restoreBar').classList.add('show');
  }).catch(function () {});
}

$('btnRestore').addEventListener('click', function () {
  if (!pendingSnapshot) return;
  $('restoreBar').classList.remove('show');
  applyProject(pendingSnapshot).then(function () {
    pendingSnapshot = null;
    setPill('已恢复上次工作', 'on');
    setTimeout(function () { setPill(state.deviceName || '已连接', 'on'); }, 1800);
  });
});

$('btnDiscard').addEventListener('click', function () {
  $('restoreBar').classList.remove('show');
  pendingSnapshot = null;
  idbDel('autosave');
});

$('btnSaveProj').addEventListener('click', exportProject);
$('btnOpenProj').addEventListener('click', function () { $('projInput').click(); });
$('btnSnapshot').addEventListener('click', function () { saveSnapshot(false); });
listSnapshots();
$('projInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (f) importProject(f);
  e.target.value = '';
});

window.addEventListener('beforeunload', function () {
  if (saveTimer) {
    clearTimeout(saveTimer);
    doAutosave();
  }
});

checkAutosave();

/* ============================================================
   事件绑定
   ============================================================ */

$('btnConnect').addEventListener('click', function () {
  if (!state.connected) connect();
});

$('btnConnectUsb').addEventListener('click', function (e) {
  e.stopPropagation();
  if ($('midiMenu').classList.contains('show')) { midiMenuClose(); return; }
  refreshMidiPorts();
});

document.addEventListener('click', function (e) {
  if (!e.target.closest || !e.target.closest('.midi-wrap')) midiMenuClose();
});

window.addEventListener('beforeunload', function () { disconnectMidiInput(true); });

$('btnRec').addEventListener('click', function () {
  if (state.recording) stopRec(); else startRec();
});

$('btnPlay').addEventListener('click', play);

$('btnStop').addEventListener('click', function () {
  if (state.recording) stopRec();
  if (practice.active) stopPractice();
  stopPlay();
  setPill(state.deviceName || '已连接', 'on');
});

$('btnMidi').addEventListener('click', exportMIDI);
$('btnWav').addEventListener('click', exportWav);
$('btnMp3').addEventListener('click', exportMp3);
$('btnStaffPng').addEventListener('click', function () { exportScoreHostPng('staffHost', '五线谱'); });
$('btnJianpuPng').addEventListener('click', function () { exportScoreHostPng('jianpuHost', '简谱'); });
$('btnPrintScore').addEventListener('click', printScore);
$('scoreTitle').addEventListener('input', updatePrintHeading);
$('scoreAuthor').addEventListener('input', updatePrintHeading);
$('btnSamples').addEventListener('click', loadSamples);

$('btnRebuild').addEventListener('click', function () {
  if (!state.notes.length) return;
  buildScore();
  renderAll();
});

$('bpm').addEventListener('input', function (e) {
  state.bpm = parseInt(e.target.value, 10);
  state.bpmAuto = false;
  $('bpmVal').textContent = state.bpm;
  syncBpmLabel();
});

$('bpm').addEventListener('change', function () {
  if (state.notes.length) { buildScore(); renderAll(); }
  scheduleSave();
});

$('timeSig').addEventListener('change', function (e) {
  state.timeSig = e.target.value;
  if (state.notes.length) { buildScore(); renderAll(); }
  scheduleSave();
});

$('grid').addEventListener('change', function (e) {
  state.gridDiv = parseInt(e.target.value, 10);
  if (state.notes.length) { buildScore(); renderAll(); }
  scheduleSave();
});

$('keySel').addEventListener('change', function (e) {
  state.keyOverride = e.target.value;
  if (state.notes.length) { buildScore(); renderAll(); }
  scheduleSave();
});

$('wet').addEventListener('input', function (e) {
  state.wet = e.target.value / 100;
  $('wetVal').textContent = e.target.value + '%';
  if (live) live.wet.gain.value = state.wet;
});

$('vol').addEventListener('input', function (e) {
  state.vol = e.target.value / 100;
  $('volVal').textContent = e.target.value + '%';
  if (live) live.master.gain.value = state.vol;
});

document.querySelectorAll('.tab').forEach(function (t) {
  t.addEventListener('click', function () {});
});

window.addEventListener('resize', function () {
  fitRoll();
  fitWave();
  fitOverview();
  if (state.notes.length) { renderStaff(); renderJianpu(); }
});

(function fillKeyOptions() {
  var sel = $('keySel');
  for (var pc = 0; pc < 12; pc++) {
    var o = document.createElement('option');
    o.value = String(pc);
    o.textContent = SHARP[pc].replace('#', '') + (SHARP[pc].indexOf('#') >= 0 ? ' 大调（升）' : ' 大调');
    sel.appendChild(o);
  }
})();

/* ---------- 迷你控制条 ---------- */
function updateMini() {
  var rec = $('mRec'), play = $('mPlay'), stop = $('mStop'), info = $('miniInfo');
  if (!rec) return;
  rec.textContent = state.recording ? '■ 停止' : '● 录音';
  play.disabled = $('btnPlay').disabled;
  stop.disabled = $('btnStop').disabled;
  info.textContent = state.notes.length
    ? (state.notes.length + ' 个音 · ' + (state.lastDur || 0).toFixed(1) + 's')
    : (edit.srcBuf ? '已载入音频' : '');
}

(function setupMini() {
  var card = $('btnRec').closest('.card');
  if ('IntersectionObserver' in window && card) {
    var io = new IntersectionObserver(function (entries) {
      $('miniBar').classList.toggle('show', !entries[0].isIntersecting);
    }, { threshold: 0.2 });
    io.observe(card);
  }
  $('mRec').addEventListener('click', function () { $('btnRec').click(); });
  $('mPlay').addEventListener('click', function () { $('btnPlay').click(); });
  $('mStop').addEventListener('click', function () { $('btnStop').click(); });
  $('declk').addEventListener('change', function (e) {
    edit.declk = parseFloat(e.target.value) || 0;
  });
  updateMini();
})();

/* ---------- 帮助面板 ---------- */
(function setupHelp() {
  var mask = $('helpMask');
  if (!mask) return;
  function openHelp() { mask.classList.add('show'); }
  function closeHelp() { mask.classList.remove('show'); }

  $('btnHelp').addEventListener('click', openHelp);
  $('btnHelpClose').addEventListener('click', closeHelp);
  $('linkHelp').addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
  mask.addEventListener('click', function (e) { if (e.target === mask) closeHelp(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mask.classList.contains('show')) closeHelp();
  });

  var hp = new URLSearchParams(location.search);
  if (hp.has('help')) { openHelp(); return; }
  if (hp.has('nohelp')) { return; }

  try {
    if (!localStorage.getItem('pianoStudio.seen')) {
      localStorage.setItem('pianoStudio.seen', '1');
      setTimeout(openHelp, 900);
    }
  } catch (e) {}
})();

fitRoll();
fitWave();
fitOverview();
setupNoteEditor();
setupPractice();
renderMidiTracks();
renderMidiCcEditor();
setupWorkspaceNav();
setupDiagnostics();
setupAudioInput();

(function demo() {
  var q = new URLSearchParams(location.search);
  if (!q.has('demo')) return;
  // 演示跨小节延音线：一个长音 + 后续短音，长音被拆成带 tie 的两段
  if (q.has('tie')) {
    state.notes = [
      { pitch: 67, vel: 96, tOn: 0, tOff: 6000 },
      { pitch: 64, vel: 90, tOn: 6600, tOff: 7000 },
      { pitch: 62, vel: 90, tOn: 7200, tOff: 7600 },
      { pitch: 60, vel: 90, tOn: 7800, tOff: 8800 }
    ];
    state.bpm = 60;
    state.timeSig = '4/4';
    state.lastDur = 8.8;
    ['btnPlay','btnMidi','btnWav','btnMp3','btnStop'].forEach(function (id) { $(id).disabled = false; });
    $('mNotes').textContent = state.notes.length;
    $('mTime').textContent = '8.8s';
    practiceSyncBounds();
    buildScore();
    renderAll();
    return;
  }
  // 右手：C 大调音阶上下行；左手：每小节一组分解和弦，用来演示双谱表
  var seq = [
    [60,0,380],[62,420,760],[64,800,1140],[65,1180,1520],[67,1560,1960],
    [69,2000,2400],[71,2440,2880],[72,2920,3400],[64,3450,3820],[67,3860,4280],
    [72,4320,4900],[71,4940,5320],[69,5360,5740],[67,5780,6160],[65,6200,6580],
    [64,6620,7000],[62,7040,7420],[60,7460,8100]
  ];
  var bass = [
    [48,0,1290],[55,0,1290],[53,1330,2620],[48,1330,2620],
    [45,2660,3950],[52,2660,3950],[43,3990,5280],[50,3990,5280],
    [48,5320,6610],[55,5320,6610],[41,6650,7940],[48,6650,7940]
  ];
  state.notes = seq.map(function (s) { return { pitch: s[0], vel: 96, tOn: s[1], tOff: s[2] }; })
    .concat(bass.map(function (s) { return { pitch: s[0], vel: 68, tOn: s[1], tOff: s[2] }; }));
  state.lastDur = 8.1;
  ['btnPlay', 'btnMidi', 'btnWav', 'btnMp3', 'btnStop'].forEach(function (id) { $(id).disabled = false; });
  $('mNotes').textContent = state.notes.length;
  $('mTime').textContent = '8.1s';
  practiceSyncBounds();
  buildScore();

  try {
    var ac = new OfflineAudioContext(2, 44100 * 5, 44100);
    var tb = ac.createBuffer(2, 44100 * 5, 44100);
    for (var c = 0; c < 2; c++) {
      var d = tb.getChannelData(c);
      for (var i = 0; i < d.length; i++) {
        var t = i / 44100;
        d[i] = Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t * 0.9) * Math.sin(t * 4.2) * 0.55;
      }
    }
    loadBuffer(tb);
    splitRaw(1.0);
    splitRaw(2.4);
    if (edit.clips[2]) edit.clips[2].start += 0.30;
    edit.selClip = edit.clips[0];
    edit.playhead = 1.62;
    edit.sel = null;
    edit.viewStart = 0;
    edit.viewDur = 5.4;
    afterChange();
  } catch (e) {}

  if (q.has('drop')) document.body.classList.add('drop-active');

  renderAll();
})();

if (new URLSearchParams(location.search).has('idbtest')) {
  (async function () {
    try {
      await idbPut('probe', { hello: 42, t: Date.now() });
      var v = await idbGet('probe');
      await idbDel('probe');
      document.title = 'IDB OK ' + JSON.stringify(v);
    } catch (e) {
      document.title = 'IDB FAIL ' + (e && e.message);
    }
  })();
}

if (new URLSearchParams(location.search).has('selftest')) {
  try { runSelfTest(); } catch (e) { document.title = 'SELFTEST CRASH ' + e.message; }
}

setPill('未连接');

if ('serviceWorker' in navigator && location.protocol === 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
})();
