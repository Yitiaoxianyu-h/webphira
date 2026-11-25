//! WebAudio backend (wasm32).
//!
//! Integration with the browser is done through plain `extern "C"` imports
//! provided by the page's JS glue (see `web/sasa_web.js`). We deliberately do
//! not use `wasm-bindgen` here: miniquad/miniquad-fork instantiates the wasm
//! module itself from `gl.js` and only provides `env` imports.

use crate::Backend;
use anyhow::{anyhow, Result};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use super::{BackendSetup, State};

#[derive(Debug, Clone, Default)]
pub struct WebAudioSettings {
    pub preferred_sample_rate: Option<u32>,
    /// Requested `ScriptProcessorNode` buffer size (power of two, 256..=16384).
    pub buffer_size: Option<u32>,
}

extern "C" {
    /// Creates the AudioContext and the ScriptProcessorNode.
    /// Returns the actual sample rate, or 0 on failure.
    fn sasa_web_start(preferred_sample_rate: u32, buffer_size: u32) -> u32;

    /// Resumes a suspended AudioContext (must be called from a user gesture).
    fn sasa_web_resume();

    /// Number of stereo frames the JS side will ask for in `sasa_web_render`.
    fn sasa_web_buffer_size() -> u32;

    /// Retrieves the latency estimate in seconds.
    fn sasa_web_latency() -> f32;
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static SCRATCH: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

pub struct WebAudioBackend {
    settings: WebAudioSettings,
    started: bool,
    broken: Arc<AtomicBool>,
}

impl WebAudioBackend {
    pub fn new(settings: WebAudioSettings) -> Self {
        Self {
            settings,
            started: false,
            broken: Arc::default(),
        }
    }

    pub fn resume(&self) {
        unsafe { sasa_web_resume() }
    }
}

impl Backend for WebAudioBackend {
    fn setup(&mut self, setup: BackendSetup) -> Result<()> {
        // 全局只能有一个 mixer：覆盖会丢弃先前 manager 的 mixer 与命令接收端，
        // 使它的音效永久静音，并让它的 add_renderer 报 "buffer is full"。
        STATE.with(|it| {
            let mut state = it.borrow_mut();
            if state.is_none() {
                *state = Some(setup.into());
            }
        });
        Ok(())
    }

    fn start(&mut self) -> Result<()> {
        if self.started {
            unsafe { sasa_web_resume() };
            return Ok(());
        }

        let preferred = self.settings.preferred_sample_rate.unwrap_or(0);
        let buffer_size = self
            .settings
            .buffer_size
            .filter(|it| it.is_power_of_two() && (256..=16384).contains(it))
            .unwrap_or(2048);
        let sample_rate = unsafe { sasa_web_start(preferred, buffer_size) };
        if sample_rate == 0 {
            return Err(anyhow!("failed to initialize WebAudio"));
        }

        STATE.with(|it| {
            if let Some(state) = it.borrow_mut().as_mut() {
                state.mixer.sample_rate = sample_rate;
            }
        });
        self.started = true;
        Ok(())
    }

    fn consume_broken(&self) -> bool {
        self.broken.fetch_and(false, Ordering::Relaxed)
    }
}

/// Called from JS from the `ScriptProcessorNode` callback.
///
/// Renders `frames` stereo frames into a thread-local buffer and returns a
/// pointer to it. The caller copies `frames * 2` floats out of the wasm memory
/// immediately, before calling this function again.
#[no_mangle]
pub extern "C" fn sasa_web_render(frames: u32) -> *const f32 {
    let frames = frames.max(1) as usize;
    SCRATCH.with(|scratch| {
        let mut buffer = scratch.borrow_mut();
        buffer.clear();
        buffer.resize(frames * 2, 0.);
        let latency = unsafe { sasa_web_latency() };
        STATE.with(|it| {
            if let Some(state) = it.borrow_mut().as_mut() {
                state.mixer.render_stereo(&mut buffer);
                state.recorder.push(latency);
            }
        });
        buffer.as_ptr()
    })
}

/// Called from JS once the AudioContext has been resumed by a user gesture.
#[no_mangle]
pub extern "C" fn sasa_web_on_resumed() {
    // Nothing to do for now; kept as a stable hook for future use.
}
