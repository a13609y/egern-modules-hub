# BiliBili Redirect

原样镜像 [Biliverse/Redirect](https://github.com/Biliverse/Redirect) 发布的 Egern 原生模块，重定向哔哩哔哩相关 CDN；**不从 `.sgmodule` 转换，不改写上游 `url_rewrites`、脚本或 MITM 配置**。

- 上游版本：`v0.2.25`（由 GitHub Actions 每日查询 Releases latest 并在内容变化时同步）
- 上游原始文件：[BiliBili.Redirect.yaml](https://github.com/Biliverse/Redirect/releases/download/v0.2.25/BiliBili.Redirect.yaml)
- 上游归属：[Biliverse/Redirect](https://github.com/Biliverse/Redirect)
- 许可：上游仓库采用 [Apache License 2.0](https://github.com/Biliverse/Redirect/blob/main/LICENSE)，本目录仅作保留原始内容的镜像；使用、再发布须遵守该许可。
- 订阅：`https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/bilibili-redirect/bilibili-redirect.yaml`

## 使用与影响

Egern → 工具 → 模块 → `+`，粘贴上述订阅地址。模块包含上游的 `mitm.hostnames`，启用后会对列出的哔哩哔哩主机进行 HTTPS 解密；请只在理解并接受该影响后启用，并按 Egern 要求安装/信任证书。

## 检查限度

已进行 YAML 解析、关键 Egern 字段和上游 tag/脚本 URL 一致性静态检查。未在真实 Egern 设备运行时验证；CDN 可用性、重定向结果和 MITM 行为会随网络、账户、地区及上游变更而变化。
