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

## Windows 代码签名

electron-builder 使用以下环境变量签名 Windows 安装包：

```text
CSC_LINK         # PFX 文件路径，或 PFX 的 Base64 内容
CSC_KEY_PASSWORD # PFX 证书密码
```

仓库工作流把它们映射到两个 GitHub Actions Secrets：

- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

### 没有证书时

可以通过 GitHub Actions 的 `workflow_dispatch` 生成未签名测试包。它适合内部测试，但 Windows 仍会显示“未知发布者”，不能消除 SmartScreen 警告。自签名证书也是免费测试方案，但公开分发时同样不会被 Windows 默认信任。

### 开源项目的免费公开签名

如果项目保持公开源代码并符合基金会条件，可以申请 [SignPath Foundation](https://signpath.org/) 的免费开源代码签名。它不要求你把 PFX 私钥放进 GitHub；获批后需要在 SignPath 创建项目和签名策略，再把 GitHub Actions 生成的构建产物提交到 SignPath 签名。申请和审核完成前，仍然只能发布未签名测试包。签名后的发布者名称可能显示为 SignPath Foundation。

### 准备正式发布证书

1. 从支持 Windows Authenticode 的 CA 购买 OV 或 EV 代码签名证书，并导出带私钥的 `.pfx` 文件。
2. 在本机 PowerShell 中把 PFX 转成 Base64，整个过程不要把证书内容粘贴到聊天或代码仓库：

```powershell
$certPath = "C:\path\to\piano-studio.pfx"
[Convert]::ToBase64String([IO.File]::ReadAllBytes($certPath)) | Set-Clipboard
```

3. 打开 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret**，新增：

   - Name: `WINDOWS_CERTIFICATE_BASE64`，Value: 剪贴板中的 Base64 文本
   - Name: `WINDOWS_CERTIFICATE_PASSWORD`，Value: 导出 PFX 时设置的密码

4. 推送版本 Tag（例如 `v1.12.4`）。在证书或 SignPath 接入完成前，Tag 仍可正常发布，但 Windows 文件会明确保持未签名状态。签名配置完成后，再在仓库 **Settings → Secrets and variables → Actions → Variables** 中把 `REQUIRE_SIGNING` 设为 `true`，之后缺少签名证书或签名校验失败会阻止发布。
5. 下载 Release 中的 EXE，在 PowerShell 验证：

```powershell
Get-AuthenticodeSignature .\PianoStudio-Setup-1.12.4.exe |
  Format-List Status,SignerCertificate
```

应看到 `Status : Valid`，并能看到你的发布者名称。

证书和密码只放在 GitHub Actions Secrets，不要提交到仓库。