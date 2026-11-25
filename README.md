# Phira Web

Phira 的**浏览器（WebAssembly）移植版**。基于原版 Phira v0.8.2 源码，用 Rust + macroquad/miniquad 编译到 `wasm32-unknown-unknown`，在普通浏览器里直接游玩，无需安装客户端。

简体中文 | [English](./README-en.md)

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)

## 特性

- 纯浏览器运行：无需安装客户端，打开网页即可游玩
- 桌面版功能基本齐全：选曲、谱面预览、判定、成绩与本地记录、皮肤（respack）、mod、多语言
- 内存 VFS + IndexedDB 持久化，谱面与设置刷新后不丢失
- WebAudio 音频后端，支持 UI 音效与音乐全局混音
- 键盘 / 多点触控输入
- 多人联机：通过后端 HTTP 隧道承载 phira-mp 的字节流（浏览器无法直接开 TCP）
- 内置无扩展名资源出口 `/__res` 与同源代理 `/__proxy`，绕过下载管理器拦截与浏览器 CORS 限制

## 目录结构

```
phira/             游戏本体（Rust）
prpr/              引擎
prpr-avc/          AVC 视频解码
prpr-l10n/         本地化
prpr-pbc/          pbc 谱面格式
prpr-auto-offset/  自动偏移
phira-monitor/     监控工具
phira-main/        桌面版入口（非 Web 必需）
vendor/            随仓库提供的补丁依赖（sasa、getrandom、phira-mp-common）
web/               网页外壳与构建/运行脚本
  index.html         页面骨架 + 首屏加载进度条
  index.php          PHP 后端（静态文件 / __res / __proxy）
  .htaccess          Apache 规则（MIME、响应头、rewrite）
  gl.js              miniquad 的 WebGL / 事件层
  gl_extra.js        WebGL 额外绑定
  host.js            宿主绑定（存储、剪贴板、输入框、键盘转发）
  sasa_web.js        WebAudio 音频后端
  build.ps1          构建脚本
  start.bat          一键启动（本地服务器 + 打开浏览器）
  serve.py           本地静态服务器
  assets/ mod/ rank/ respack/  游戏资源
  pkg/               构建产物（不随仓库提供，由构建脚本生成）
tools/             构建辅助脚本（patch_glue.py）
```

## 环境要求

| 依赖 | 说明 |
|---|---|
| Rust stable | Windows 上推荐 GNU 工具链 `stable-x86_64-pc-windows-gnu` |
| wasm 目标 | `rustup target add wasm32-unknown-unknown` |
| wasm-bindgen-cli | 需要 0.2.114，且可被脚本找到（见下文） |
| Python 3 | 用于 `patch_glue.py` 与本地静态服务器 |
| PHP 7.4+（可选） | 仅在部署到 PHP 主机时需要 |

## 构建

### 1. 准备 Rust 与 wasm 目标

```powershell
rustup target add wasm32-unknown-unknown
```

### 2. 准备 wasm-bindgen

三选一：

- 把预编译的 `wasm-bindgen-<版本>` 目录放到仓库根目录的 `tools/` 下（脚本会自动把其中的 `wasm-bindgen.exe` 加入 `PATH`）；
- 或安装到全局：`cargo install wasm-bindgen-cli --version 0.2.114`；
- 或自行下载官方 release 后把目录加入 `PATH`。

> 版本必须与 `Cargo.lock` 中 `wasm-bindgen` 的版本一致，否则运行时会报版本不匹配。

### 3. 执行构建

在仓库根目录执行：

```powershell
pwsh web/build.ps1
```

脚本依次完成：

1. `cargo build -p phira --target wasm32-unknown-unknown --release --no-default-features --features chat`
2. `wasm-bindgen --target web` 生成 `web/pkg/phira.js` 与 `web/pkg/phira_bg.wasm`
3. 调用 `tools/patch_glue.py` 把 miniquad 的 `env` 导入合并进 wasm-bindgen 胶水代码，并生成空的 `web/pkg/env.js`
4. 把根目录 `assets/` 复制到 `web/assets/`

说明：

- 脚本会优先使用 `D:\Rust`、`D:\python`（作者本机路径）作为工具链与 Python 目录，这两个目录不存在时自动回退到系统 `PATH`。如果你把自己的 Rust / Python 装在别处，直接改 `web/build.ps1` 顶部对应变量即可。
- 建议串行构建（`-j 1`），并行度过高可能因磁盘空间不足报 `os error 112`。
- `phira-main`（桌面版）不在 Web 构建范围内，可忽略；`cargo build -p phira-main` 可单独构建桌面版。

### 4. 本地运行

```powershell
python web/serve.py
```

然后打开 <http://localhost:8000/>，或直接双击 `web/start.bat`（会启动服务器并自动打开浏览器）。

首次进入页面会显示加载进度条（下载进度、速度与预计剩余时间）。

## 部署到 Web 服务器

Web 版是「静态站点 + 两个极小的服务端端点」，任何支持 PHP 的主机都能跑。

**前置条件**：前端把 `/__res` 与 `/__proxy` 硬编码成站点绝对路径，因此必须部署在**域名根目录**（`https://你的域名/`），不要放子目录。

**上传 `web/` 目录中的内容**：

| 项目 | 作用 |
|---|---|
| `index.html` | 页面骨架、加载遮罩、全屏按钮 |
| `index.php` | PHP 后端：静态文件、`/__res`、`/__proxy` |
| `.htaccess` | Apache 规则（MIME、响应头、rewrite）；nginx 不识别 |
| `gl.js`、`gl_extra.js`、`host.js`、`sasa_web.js` | miniquad / 宿主 JS 胶水 |
| `pkg/` | `phira.js`、`phira_bg.wasm`、`env.js`（构建产物） |
| `assets/` | 内置 respack（背景、字体、音效、图标） |
| `mod/`、`rank/`、`respack/` | mod 图标、评级图标、打击特效 |
| 散落的 `*.png` / `*.jpg` / `*.ogg` / `*.ttf` | 游戏直接加载的资源（`background.jpg`、`button.ogg`、`font.ttf` 等） |

即：除 `build.ps1`、`serve.py`、`serve.ps1`、`start.bat` 之外的全部文件（约 55 MB）。

`.htaccess` 是点文件，很多 FTP 客户端默认隐藏点文件，务必确认它真的被上传，否则 `/__res` 与 `/__proxy` 会 404。

使用 nginx 时（`nginx` 不识别 `.htaccess`，下面的规则要写进站点配置或主机面板的「伪静态 / URL Rewrite」）：

```nginx
location / {
    try_files $uri $uri/ /index.php?$args;
}
```

另外需要保证 `wasm` 映射为 `application/wasm`（Apache 由 `.htaccess` 中的 `AddType` 完成；nginx：`types { application/wasm wasm; }`），否则浏览器不会流式编译模块。

也可以用 PHP 内置服务器做本地验证（Windows 下 `PHP_CLI_SERVER_WORKERS` 不生效）：

```powershell
$env:PHP_CLI_SERVER_WORKERS=8; php -S 0.0.0.0:8000 index.php
```

## 与桌面版的差异

- **文件系统**：wasm 下没有真实文件系统，改为内存 VFS + IndexedDB 持久化，谱面可跨刷新保留
- **音频**：使用 sasa 的 WebAudio 后端（`ScriptProcessorNode` 拉取样本），并保证全局只有一个 Mixer
- **资源加载**：所有游戏资源走无扩展名的 `/__res` 端点（`text/plain` + `inline`），避免下载管理器（IDM 等）拦截
- **输入**：键盘事件在 document 级捕获后转发给 canvas；登录等文本输入使用页内 HTML 覆盖层，不使用 `window.prompt`
- **网络**：同源 `/__proxy` 代理绕过浏览器 CORS
- **多人联机**：浏览器不能开原始 TCP，所以把 phira-mp 的字节流交给后端「HTTP 隧道」
  （`POST /__mp/open`、`/__mp/send`、`/__mp/tunnel`），协议编解码（`vendor/phira-mp-common`）
  与桌面版完全共用。隧道地址取页面里的 `window.__phiraMpBase`

## 已知限制

- **导出谱面 / respack 相关功能不可用**：这些路径依赖 `std::thread::spawn`，wasm 单线程下会 panic
- 音画同步与帧率仍在持续验证中
- 首次加载需下载约 9 MB 的 wasm 与游戏资源，网络较慢时黑屏等待属正常现象

## 使用的开源项目

本项目是 **Phira** 的衍生作品，绝大部分代码来自上游，另有浏览器移植层的修改。

| 项目 | 用途 | 许可证 |
|---|---|---|
| [TeamFlos/phira](https://github.com/TeamFlos/phira) | 上游项目：游戏本体、引擎 `prpr`、本地化、谱面格式、自动偏移等 | GPL-3.0 |
| [TeamFlos/phira-mp](https://github.com/TeamFlos/phira-mp) | 多人联机协议（`phira-mp-common` / `phira-mp-client`） | GPL-3.0 |
| [Mivik/prpr-macroquad](https://github.com/Mivik/prpr-macroquad) | macroquad 分支（Phira 使用的图形框架） | MIT / Apache-2.0 |
| [Mivik/prpr-miniquad](https://github.com/Mivik/prpr-miniquad) | miniquad 分支（底层窗口 / WebGL 抽象） | MIT / Apache-2.0 |
| [Mivik/sasa](https://github.com/Mivik/sasa) | 音频库（仓库内 `vendor/sasa` 增加 WebAudio 后端） | MIT / Apache-2.0 |
| [rustwasm/wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) | Rust ↔ JS 绑定与 wasm 加载胶水 | MIT / Apache-2.0 |
| [tokio](https://github.com/tokio-rs/tokio) | 异步运行时 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | HTTP 客户端 | MIT / Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) / serde_json / serde_yaml | 序列化 | MIT / Apache-2.0 |
| [image](https://github.com/image-rs/image) | 图像解码与处理 | MIT / Apache-2.0 |
| [lyon](https://github.com/nical/lyon) | 2D 路径三角化 | MIT / Apache-2.0 |
| [nalgebra](https://github.com/dimforge/nalgebra) | 线性代数 | Apache-2.0 |
| [symphonia](https://github.com/pdeljanov/Symphonia) | 音频解码 | MPL-2.0 |
| [fluent](https://github.com/projectfluent/fluent-rs) | 本地化 | Apache-2.0 / MIT |
| [zip-rs](https://github.com/zip-rs/zip2) | zip 谱面包解析 | MIT |
| [rust-random/getrandom](https://github.com/rust-random/getrandom) | 随机数（仓库内 `vendor/` 版本改为调用页面 `host_random`） | MIT / Apache-2.0 |
| [rust-lang/regex](https://github.com/rust-lang/regex) | 正则 | MIT / Apache-2.0 |
| [rayon](https://github.com/rayon-rs/rayon) | 并行迭代（部分依赖启用） | MIT / Apache-2.0 |

游戏内美术、字体、音效与示例谱面资源来自上游 Phira 仓库。移植层的 JS（`web/gl.js`、`web/host.js`、`web/sasa_web.js`、`web/index.html`、`web/index.php`）与本仓库新增的 Rust 代码同样以 GPL-3.0 发布。

## 许可证

本项目以 **GNU General Public License v3.0（GPL-3.0）** 开源，完整协议文本见 [LICENSE](./LICENSE)。

由于它是 [Phira](https://github.com/TeamFlos/phira)（GPL-3.0）的衍生作品，分发本项目的修改版或二进制时，必须同样以 GPL-3.0 提供完整对应源码。
