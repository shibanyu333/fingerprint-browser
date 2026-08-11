# 复用来源记录

按「先复用、再动手」的原则，本项目**没有从零手搓浏览器内核**，只自研了管理层。

## 采用的开源项目

### fingerprint-chromium —— 浏览器内核（核心复用）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/adryfish/fingerprint-chromium |
| 版本 | 148.0.7778.215（macOS arm64 原生） |
| 许可证 | **BSD-3-Clause** ✅ 宽松，可闭源商用 |
| 星数 | ~2.9k（2026-08 查） |
| 复用方式 | **直接使用官方编译好的二进制**，不改源码 |
| 安装位置 | `browsers/FingerprintChromium-148.app` |

选它的理由：基于 ungoogled-chromium，在 **C++ 源码层**改写 canvas / WebGL / 音频 / 字体 /
clientRects / UA / 时区，由 `--fingerprint=<种子>` 一个参数统一驱动。比浏览器插件那种 JS 层
补丁难检测得多 —— JS 补丁改过的函数，`toString()` 一看就露馅。

它开放的命令行参数（本项目全部接进了 UI）：

```
--fingerprint=<32位整数>            指纹种子，决定所有噪声
--fingerprint-platform             windows | macos | linux
--fingerprint-platform-version     系统版本号
--fingerprint-brand                Chrome | Edge | Opera | Vivaldi
--fingerprint-brand-version        品牌版本（本项目默认不传，见下方"踩过的坑"）
--fingerprint-hardware-concurrency CPU 核心数
--disable-spoofing=font,audio,canvas,clientrects,gpu   选择性关闭伪装
--disable-non-proxied-udp          禁止非代理 UDP（防 WebRTC 泄露真实 IP）
--lang / --accept-lang / --timezone
--proxy-server                     ⚠️ 官方明确不支持带密码认证
```

## 评估过但没用的项目

| 项目 | 许可证 | 不用的原因 |
|---|---|---|
| CloakHQ/CloakBrowser（★29.5k） | MIT（仅外壳） | 二进制不在仓库里，要 GitHub 登录 + Pro 付费解锁，运行时依赖它家服务器 |
| zhom/donutbrowser（★3.5k） | **AGPL-3.0** | 功能最接近成品，但 AGPL 有传染性，且是 Rust/Tauri 栈；未参考其代码 |
| daijro/camoufox（★10.7k） | MPL-2.0 | Firefox 内核、有 mac arm64 包，质量很高；但电商平台上 Chrome 内核更不显眼。备选 |
| Virtual-Browser/VirtualBrowser | BSD-3 | 主要面向 Windows |
| itbrowser-net/undetectable-fingerprint-browser | **无许可证** | 没有 LICENSE 文件 = 默认保留全部版权，法律上不可复制 |

## 自研部分（不是抄来的）

内核只提供「一个能改指纹的浏览器」，下面这些是这个项目自己写的：

1. **`server/proxy-relay.js` —— 带认证的代理中继（最关键）**
   内核的 `--proxy-server` 不支持用户名密码，而电商用的住宅 IP 几乎都要认证。
   解决办法：每个环境起一个只监听 `127.0.0.1` 的本地 HTTP 代理，浏览器连它（免认证），
   由它转发到上游 SOCKS5/HTTP 并完成认证握手。顺带解决 DNS 泄露 —— 浏览器发的是
   `CONNECT 域名:443`，域名在代理出口才解析。

2. **`server/launcher.js` —— 启动编排 + 失败关闭保护**
   打开环境前强制检测代理，**代理不通就拒绝启动**（除非显式强制）。
   代理挂了还硬开 = 用真实 IP 登店铺，这是防关联里最致命的事故。

3. **`server/fingerprint.js` —— 指纹参数生成**
   种子派生、平台/品牌/语言/时区的合理搭配、按代理出口国家自动校正语言时区。

4. **`server/cdp-stealth.js` —— 系统 Chrome 的降级补丁层**
   没装内核时用系统 Chrome + CDP 注入先跑起来。明确标注为「弱指纹」。

5. **`web/` —— 整个管理界面**，以及环境/分组/代理池/批量操作/备份/自动化 API。

## 实测检测站发现的问题（都已修）

拿真实检测站跑过之后才发现的，光看代码看不出来：

### 1. Intl 泄露系统真实语言（严重，已修）

`--lang=en-US` 只改界面语言和 `navigator.language`，**管不到 ICU 的默认 locale**。
中文系统上 `Intl.DateTimeFormat().resolvedOptions().locale` 依然返回 `zh-CN`，
月份名渲染成"七月"、货币名"美元"、时区名"北美东部夏令时间"。
`navigator.language` 说 en-US、`Intl` 说 zh-CN，自相矛盾 —— BrowserScan 因此扣 10 分
（"Language mismatch"），CreepJS 的 Intl 区块也一眼看得出来。

试过三种办法：

| 办法 | 结果 |
|---|---|
| `LANG` / `LC_ALL` 环境变量 | ❌ macOS 上完全无效 |
| 命令行传 `-AppleLanguages "(en-US)"` | ⚠️ 有效，但 Chromium 把值当成网址，会多开一个 `http://(en-us,%20en)/` 标签页 |
| **启动前 `defaults write <bundleId> AppleLanguages`** | ✅ 有效且干净，采用 |

偏好域按 bundle id 全局共享、每个进程启动瞬间读一次，所以「写入 → 启动 → 等 700ms」
必须串行化（`launcher.js` 里的 `withAppleLanguages`），否则并发打开两个不同语言的环境会串味。
只对自己打包的内核这么做，绝不碰用户真实 Chrome 的偏好域。

### 2. WebGPU 暴露真实 GPU（严重，已修）

内核改了 WebGL 却没管 WebGPU：WebGL 报 `ANGLE (NVIDIA, RTX 4060 ... Direct3D11)`，
`navigator.gpu.requestAdapter()` 却老实返回 `{vendor:"apple", architecture:"metal-3"}`。
一个自称 Windows 的浏览器同时报 NVIDIA 和 Apple Metal，是硬伤。

没有参数能改 WebGPU 的适配器信息。试了 `--disable-blink-features=WebGPU`、
`--disable-webgpu`、`--disable-features=Dawn` 都无效，**只有 `--disable-features=WebGPUService` 管用**
（requestAdapter 返回 null）。伪装成 macOS 时不加这个参数 —— 那时报 apple 才是对的。

### 3. 屏幕分辨率暴露 Mac（已修）

内核没有屏幕分辨率参数，`screen.width/height` 直接报这台 Mac 的 `1470x956` ——
Windows 机器不可能是这个数。用 CDP 的 `Emulation.setDeviceMetricsOverride` 解决：
**宽高传 0 表示不覆盖视口，只改 `screen.*`**，页面布局和窗口尺寸完全不受影响，
而且是 Blink 层原生覆盖，不是 JS 补丁，没有 `toString` 破绽。

代价是每个环境都要开调试端口。实测这不会被识破：BrowserScan 判 `Bot Detection: No`，
CreepJS 报 `0% stealth / 0% headless`，Pixelscan 报 `No automated behavior detected`。

### 4. IP 地理库互相打架（已加警告）

同一个 IP，ip-api 说 `America/New_York`（Albany），ipwho.is 和 BrowserScan 都说
`America/Los_Angeles`。按哪家配时区都可能被另一家判定"时区与 IP 不符"。
现在 `ipcheck.js` 同时查两家，不一致就在界面上警告，让用户换条定位明确的 IP。

### 还没解决的

- **`screen.colorDepth = 30`**：macOS 广色域特征，Windows 通常是 24。
  `--force-color-profile=srgb` 无效，CDP 也没有对应能力。
  只能靠 JS 补丁改，但那会引入新的可检测破绽，权衡下来不做。
  好在开了 HDR 的 Windows 也会报 30，属于"少见但不是不可能"。
- **`devicePixelRatio = 2`**：Retina 特征。但 4K 屏 200% 缩放的 Windows 同样报
  `screen 1920x1080 + dpr 2`，是自洽的组合，不改。
- **Pixelscan 判 "Masking detected"**：见 README 的实测章节。

## 踩过的坑

- **`--fingerprint-brand-version` 会造成自相矛盾**：指定后 `navigator.userAgentData` 变成
  指定版本，但 `navigator.userAgent` 字符串仍是内核真实版本，两者对不上反而成了破绽。
  实测 UA 报 `Chrome/148` 而 userAgentData 报 `146`。**因此默认不传这个参数。**

- **macOS 隔离标记**：从网上下载的 .app 带 `com.apple.quarantine`，不清掉 Gatekeeper 直接拦。
  安装流程里已自动 `xattr -dr com.apple.quarantine`。

- **钥匙串弹窗**：Chromium 在 macOS 上每次启动都会弹钥匙串授权，加 `--use-mock-keychain` 解决。

- **该内核的 headless 模式不稳**：`--headless=new --screenshot` 会挂住，改用 CDP 截图正常。
  日常有头使用不受影响。
