pub mod bin;
pub mod config;
pub mod core;
pub mod dir;
pub mod ext;
pub mod fs;
pub mod info;
pub mod input;
pub mod judge;
pub mod parse;
pub mod particle;
pub mod scene;
pub mod task;
pub mod time;
pub mod ui;
pub mod web_fs;
pub mod web_host;

#[cfg(feature = "log")]
pub mod log;

#[rustfmt::skip]
#[cfg(closed)]
pub mod inner;

pub use scene::Main;

pub fn build_conf() -> macroquad::window::Conf {
    macroquad::window::Conf {
        window_title: "Phira".to_string(),
        window_width: 973,
        window_height: 608,
        // 浏览器里必须开启，否则高 DPI（DPR > 1）的屏幕只按 1x 物理像素渲染，
        // 画面会发糊；开启后 canvas 尺寸按设备真实像素密度计算。
        #[cfg(target_arch = "wasm32")]
        high_dpi: true,
        ..Default::default()
    }
}
