//! Browser host bindings (wasm32).
//!
//! All functions here are implemented by `web/host.js` in the page glue and
//! imported through plain `extern "C"` symbols, so the wasm module keeps using
//! miniquad's own JS loader instead of wasm-bindgen.

#[cfg(target_arch = "wasm32")]
mod imp {
    extern "C" {
        fn host_log(ptr: *const u8, len: usize);
        fn host_now() -> f64;
        fn host_prompt_start(text_ptr: *const u8, text_len: usize) -> i32;
        fn host_prompt_poll(out: *mut u8, cap: usize) -> i32;
        fn host_pick_file(id_ptr: *const u8, id_len: usize) -> i32;
        fn host_take_file_meta(out: *mut u8, cap: usize) -> i32;
        fn host_take_file_data(out: *mut u8, cap: usize) -> i32;
        fn host_open_url(ptr: *const u8, len: usize);
        fn host_set_fullscreen_btn(visible: i32);
        fn host_mp_open(addr_ptr: *const u8, addr_len: usize, init_ptr: *const u8, init_len: usize);
        fn host_mp_set_init(ptr: *const u8, len: usize);
        fn host_mp_status() -> i32;
        fn host_mp_send(ptr: *const u8, len: usize) -> i32;
        fn host_mp_recv(out: *mut u8, cap: usize) -> i32;
        fn host_mp_close();
        fn host_mp_error(out: *mut u8, cap: usize) -> i32;
    }

    pub fn log(message: &str) {
        unsafe { host_log(message.as_ptr(), message.len()) }
    }

    pub fn now() -> f64 {
        unsafe { host_now() }
    }

    pub fn open_url(url: &str) {
        unsafe { host_open_url(url.as_ptr(), url.len()) }
    }

    /// 发起一个异步 prompt（不阻塞事件循环）。
    pub fn prompt_async(default: &str) {
        unsafe { host_prompt_start(default.as_ptr(), default.len()) };
    }

    /// 轮询 prompt 结果：None = 等待中，Some(None) = 取消，Some(Some(text)) = 完成。
    pub fn poll_prompt() -> Option<Option<String>> {
        let mut buffer = vec![0u8; 4096];
        let len = unsafe { host_prompt_poll(buffer.as_mut_ptr(), buffer.len()) };
        if len < 0 {
            return None;
        }
        if len == 0 {
            return Some(None);
        }
        buffer.truncate(len as usize);
        Some(Some(String::from_utf8_lossy(&buffer).into_owned()))
    }

    /// 通知页面是否显示「切换全屏」按钮（仅游戏大厅显示）。
    ///
    /// 按钮本身是页面里的 HTML 元素，不走游戏自绘 UI：全屏 API 要求调用发生
    /// 在真实的用户手势里，而鼠标/触摸事件经 wasm 转一手之后，浏览器未必再
    /// 认这个手势。直接由 HTML 按钮响应点击最稳。
    pub fn set_fullscreen_btn(visible: bool) {
        unsafe { host_set_fullscreen_btn(visible as i32) }
    }

    /// Asks the browser to open a file picker for the given request id.
    pub fn pick_file(id: &str) {
        unsafe { host_pick_file(id.as_ptr(), id.len()) };
    }

    /// Takes the file chosen by the user, if any: `(request id, file name, bytes)`.
    pub fn take_picked_file() -> Option<(String, String, Vec<u8>)> {
        let mut meta = vec![0u8; 1024];
        let len = unsafe { host_take_file_meta(meta.as_mut_ptr(), meta.len()) };
        if len <= 0 {
            return None;
        }
        let meta = String::from_utf8_lossy(&meta[..len as usize]).into_owned();
        let mut parts = meta.splitn(3, '\n');
        let id = parts.next()?.to_owned();
        let name = parts.next().unwrap_or("file").to_owned();
        let size: usize = parts.next()?.parse().ok()?;

        let mut data = vec![0u8; size];
        let got = unsafe { host_take_file_data(data.as_mut_ptr(), data.len()) };
        if got < 0 {
            return None;
        }
        data.truncate(got as usize);
        Some((id, name, data))
    }

    // ---- 多人联机（HTTP 隧道，见 web/host.js）----

    /// 建立 MP 隧道会话。`init` 是隧道每次（重）连时先写进 TCP 的初始帧。
    pub fn mp_open(addr: &str, init: &[u8]) {
        unsafe { host_mp_open(addr.as_ptr(), addr.len(), init.as_ptr(), init.len()) }
    }

    /// 更新隧道重连时重放的初始帧（认证成功后填认证帧）。
    pub fn mp_set_init(init: &[u8]) {
        unsafe { host_mp_set_init(init.as_ptr(), init.len()) }
    }

    /// 0 空闲 / 1 建立中 / 2 已连接 / -1 失败或已断开。
    pub fn mp_status() -> i32 {
        unsafe { host_mp_status() }
    }

    /// 发送一段字节（已含协议长度前缀）。返回 0 表示已入队。
    pub fn mp_send(data: &[u8]) -> i32 {
        unsafe { host_mp_send(data.as_ptr(), data.len()) }
    }

    /// 拉取已收到的字节，返回实际写入 `out` 的长度。
    pub fn mp_recv(out: &mut [u8]) -> usize {
        let n = unsafe { host_mp_recv(out.as_mut_ptr(), out.len()) };
        if n <= 0 { 0 } else { n as usize }
    }

    pub fn mp_close() {
        unsafe { host_mp_close() }
    }

    pub fn mp_error() -> String {
        let mut buffer = vec![0u8; 1024];
        let n = unsafe { host_mp_error(buffer.as_mut_ptr(), buffer.len()) };
        if n <= 0 {
            return String::new();
        }
        buffer.truncate(n as usize);
        String::from_utf8_lossy(&buffer).into_owned()
    }
}

#[cfg(target_arch = "wasm32")]
pub use imp::{
    log, mp_close, mp_error, mp_open, mp_recv, mp_send, mp_set_init, mp_status, now, open_url,
    pick_file, poll_prompt, prompt_async, set_fullscreen_btn, take_picked_file,
};

#[cfg(not(target_arch = "wasm32"))]
pub fn log(_message: &str) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn now() -> f64 {
    0.
}

#[cfg(not(target_arch = "wasm32"))]
pub fn open_url(_url: &str) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn prompt_async(_default: &str) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn set_fullscreen_btn(_visible: bool) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn poll_prompt() -> Option<Option<String>> {
    None
}

#[cfg(not(target_arch = "wasm32"))]
pub fn pick_file(_id: &str) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn take_picked_file() -> Option<(String, String, Vec<u8>)> {
    None
}

// 非 wasm 目标不使用 HTTP 隧道（原生直接用 TCP），这里只提供空实现占位。
#[cfg(not(target_arch = "wasm32"))]
pub fn mp_open(_addr: &str, _init: &[u8]) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_set_init(_init: &[u8]) {}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_status() -> i32 {
    -1
}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_send(_data: &[u8]) -> i32 {
    -1
}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_recv(_out: &mut [u8]) -> usize {
    0
}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_close() {}

#[cfg(not(target_arch = "wasm32"))]
pub fn mp_error() -> String {
    String::new()
}
