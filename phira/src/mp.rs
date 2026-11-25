prpr_l10n::tl_file!("multiplayer" mtl);

/// 联机客户端。
///
/// 原生（桌面 / 移动端）直接用 `phira-mp-client` 的 TCP 实现；
/// 浏览器（wasm32）用本仓库内的 `client_web`：协议编解码完全一致，
/// 只是把 TCP 换成页面里的 HTTP 隧道（见 `web/host.js` 与 `webphiracdn/mp.php`）。
#[cfg(not(target_arch = "wasm32"))]
pub use phira_mp_client::{Client as MpClient, LivePlayer};
#[cfg(target_arch = "wasm32")]
pub use client_web::{Client as MpClient, LivePlayer};

#[cfg(target_arch = "wasm32")]
mod client_web;

mod panel;
pub use panel::MPPanel;
