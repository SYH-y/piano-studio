# 第三方资源与许可

本项目的**源代码**采用 MIT 许可（见 LICENSE）。
`lib/` 与 `samples/` 中的资源由第三方提供，各自遵循其原始许可，说明如下。

---

## VexFlow 4.2.3

- 文件：`lib/vexflow.js`、`lib/vexflow-bravura.js`
- 用途：五线谱排版与音乐符号绘制
- 许可：**MIT**
- 版权：Copyright (c) 2010 Mohit Muthanna Cheppudira
- 上游：<https://github.com/0xfe/vexflow>

```
Vex Flow - A JavaScript library for rendering music notation.
Copyright (c) 2010 Mohit Muthanna Cheppudira

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

`lib/vexflow-bravura.js` 内含 Bravura 音乐字体的字形数据，字体本身采用
SIL Open Font License 1.1，版权归 Steinberg Media Technologies GmbH 所有。

---

## lamejs 1.2.1

- 文件：`lib/lame.min.js`
- 用途：在浏览器里把 PCM 编码成 MP3（导出 MP3 时才会用到）
- 许可：**LGPL-3.0**
- 作者：Alex Zhukov
- 上游：<https://github.com/zhuker/lamejs>
- 说明：lamejs 是 jump3r-code 的重写，后者又是 libmp3lame 的重写。

本项目**以未修改的官方发行文件形式**引用该库，未做任何源码改动，
也不把它静态链接进本项目自有代码。若你需要替换或重新编译它，直接替换
`lib/lame.min.js` 即可，其余代码通过全局变量 `lamejs` 调用。
LGPL-3.0 全文见 <https://www.gnu.org/licenses/lgpl-3.0.html>。

---

## FluidR3_GM 钢琴采样

- 目录：`samples/`（44 个 mp3，覆盖 A0–C8，隔半音取样）
- 用途：网页里的真实钢琴音色
- 许可：**Creative Commons Attribution 3.0 (CC BY 3.0)**
- 原始音源：FluidR3_GM.sf2，作者 Frank Wen
- MP3 版本来自：<https://github.com/gleitz/midi-js-soundfonts>
  （FluidR3_GM / acoustic_grand_piano-mp3）

按 CC BY 3.0 的要求，使用这些采样时须保留上述署名。
许可证全文：<https://creativecommons.org/licenses/by/3.0/>

---

## 字体

页面 UI 使用系统字体栈（`system-ui` / 苹方 / 微软雅黑等），不打包任何字体文件。

---

如有遗漏或署名不当，欢迎提 issue 指正。
