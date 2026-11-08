# Windows 代码签名政策

当前状态：正在申请 SignPath Foundation 的免费开源代码签名。

> Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## 项目与发布范围

- 项目：PIANO STUDIO
- 源码仓库：https://github.com/SYH-y/piano-studio
- 发布页：https://github.com/SYH-y/piano-studio/releases
- 许可：MIT（第三方资源的许可见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)）
- 签名文件：由本仓库 GitHub Actions 构建的 Windows NSIS 安装包和 Portable 便携版 EXE
- 发布版本：以 GitHub Release Tag 对应的版本号为准

只签名由本项目源代码和构建脚本生成的文件。第三方依赖、采样和系统组件保留其原始签名或许可，不使用本项目的签名策略替它们背书。

## 构建与来源验证

所有正式 Windows 构建都通过公开的 GitHub Actions 工作流完成：

- 工作流：[.github/workflows/build-desktop.yml](../.github/workflows/build-desktop.yml)
- 发布触发：推送 `v*` Tag
- 构建环境：GitHub 托管的 Windows Runner
- 签名前会保留构建产物，并由 SignPath 对构建来源进行验证
- 每个正式签名请求需要经过 SignPath 的发布审批流程

在签名服务接入完成前，GitHub Release 中的 Windows 文件可能仍为未签名文件。

## 团队角色

当前项目由 GitHub 仓库维护者负责：

- Committers / Reviewers：拥有本仓库写入权限并参与代码审查的维护者
- Approver：仓库所有者 `SYH-y`
- GitHub 仓库权限和 Pull Request 审查记录作为团队角色和来源验证的依据

所有参与签名和仓库维护的成员都应启用 GitHub 和 SignPath 的多因素认证。

## 隐私说明

PIANO STUDIO 默认在本机运行，录音、MIDI、工程和导出数据不会自动上传到云端。软件只有在用户主动使用联网功能（例如检查更新、打开 GitHub 发布页或连接用户指定的设备/服务）时才会访问对应网络服务。

## 联系与申诉

如果发现签名文件与本仓库来源不一致，请在 [GitHub Issues](https://github.com/SYH-y/piano-studio/issues) 提交问题，并附上文件名、版本号和签名信息。
