# 发布检查清单

## 代码与测试

- [ ] `node --check app.js`
- [ ] `node --check desktop/main.js`
- [ ] `node --check .github/smoke.spec.cjs`
- [ ] `git diff --check`
- [ ] Electron 冒烟测试通过，包含工作区导航检查
- [ ] 至少三台真实电钢琴或 MIDI 键盘验证
- [ ] 至少一台麦克风或 USB 声卡验证音频输入

## Windows 发布

- [ ] `PianoStudio-Setup-x.y.z.exe` 构建成功
- [ ] `PianoStudio-Portable-x.y.z.exe` 构建成功
- [ ] `latest.yml` 和 `.blockmap` 已挂到 Release
- [ ] 安装包完成代码签名，减少 SmartScreen 警告
- [ ] 安装版自动更新可检查、下载和重启安装
- [ ] 断网启动和工程恢复正常

## 签名环境变量

electron-builder 使用以下环境变量签名 Windows 安装包：

```text
CSC_LINK        # 证书文件路径或安全存储 URL
CSC_KEY_PASSWORD # 证书密码
```

证书和密码只放在 GitHub Actions Secrets，不要提交到仓库。
