/// Simple And Stupid Audio for Rust, optimized for low latency.
pub mod backend;
pub use backend::Backend;

mod clip;
pub use clip::AudioClip;

mod mixer;

mod renderer;
pub use renderer::{Music, MusicParams, PlaySfxParams, Renderer, Sfx};

use crate::{backend::BackendSetup, mixer::MixerCommand};
use anyhow::{anyhow, Context, Result};
#[cfg(target_arch = "wasm32")]
use std::cell::RefCell;
use std::{
    ops::{Add, Mul},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc,
    },
};

/// Commands that carry a whole renderer are sent in bursts (a chart may bring
/// dozens of custom hitsounds at once), so the channel has to be roomy enough
/// that a burst never overflows before the mixer gets a chance to drain it.
const MIXER_COMMAND_CAPACITY: usize = 1024;

// 浏览器里音频输出节点只有一个，因此应当只有一个 Mixer：所有 AudioManager
// 必须往同一个 mixer 里添加 renderer。否则后创建的 manager 会替换掉
// thread-local 的 mixer 状态，把先前 manager 的 mixer 连同命令接收端一起
// 丢弃 —— 表现为全局 UI 音效永久静音，且它的 add_renderer 报 "buffer is full"。
#[cfg(target_arch = "wasm32")]
thread_local! {
    static SHARED: RefCell<Option<(mpsc::SyncSender<MixerCommand>, Arc<AtomicU32>)>> = const { RefCell::new(None) };
}

fn buffer_is_full<E>(_: E) -> anyhow::Error {
    anyhow!("buffer is full")
}

#[derive(Clone, Copy, Default)]
pub struct Frame(pub f32, pub f32);
impl Frame {
    pub fn avg(&self) -> f32 {
        (self.0 + self.1) / 2.
    }

    pub fn interpolate(&self, other: &Self, f: f32) -> Self {
        Self(
            self.0 + (other.0 - self.0) * f,
            self.1 + (other.1 - self.1) * f,
        )
    }
}
impl Add for Frame {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self(self.0 + rhs.0, self.1 + rhs.1)
    }
}
impl Mul<f32> for Frame {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        Self(self.0 * rhs, self.1 * rhs)
    }
}

const LATENCY_RECORD_NUM: usize = 64;

pub struct LatencyRecorder {
    records: [f32; LATENCY_RECORD_NUM],
    head: usize,
    sum: f32,
    full: bool,
    result: Arc<AtomicU32>,
}

impl LatencyRecorder {
    pub fn new(result: Arc<AtomicU32>) -> Self {
        Self {
            records: [0.; LATENCY_RECORD_NUM],
            head: 0,
            sum: 0.,
            full: false,
            result,
        }
    }

    pub fn push(&mut self, record: f32) {
        let place = &mut self.records[self.head];
        self.sum += record - *place;
        *place = record;
        self.head += 1;
        if self.head == LATENCY_RECORD_NUM {
            self.full = true;
            self.head = 0;
        }
        self.result.store(
            (self.sum
                / (if self.full {
                    LATENCY_RECORD_NUM
                } else {
                    self.head.max(1)
                }) as f32)
                .to_bits(),
            Ordering::Relaxed,
        );
    }
}

pub struct AudioManager {
    backend: Box<dyn Backend>,
    latency: Arc<AtomicU32>,
    tx: mpsc::SyncSender<MixerCommand>,
}

impl AudioManager {
    pub fn new(backend: impl Backend + 'static) -> Result<Self> {
        Self::new_box(Box::new(backend))
    }

    pub fn new_box(mut backend: Box<dyn Backend>) -> Result<Self> {
        // 浏览器里音频输出节点只有一个：后续创建的 manager 必须复用第一个
        // manager 的 mixer，否则会把先前的 mixer（连同其命令接收端）丢掉。
        #[cfg(target_arch = "wasm32")]
        if let Some((tx, latency)) = SHARED.with(|it| it.borrow().clone()) {
            backend.start()?;
            return Ok(Self {
                backend,
                latency,
                tx,
            });
        }

        let (tx, rx) = mpsc::sync_channel(MIXER_COMMAND_CAPACITY);
        let latency = Arc::default();
        let latency_rec = LatencyRecorder::new(Arc::clone(&latency));
        backend.setup(BackendSetup {
            mixer_rx: rx,
            latency_rec,
        })?;
        backend.start()?;

        #[cfg(target_arch = "wasm32")]
        SHARED.with(|it| *it.borrow_mut() = Some((tx.clone(), Arc::clone(&latency))));

        Ok(Self {
            backend,
            latency,
            tx,
        })
    }

    pub fn create_sfx(&mut self, clip: AudioClip, buffer_size: Option<usize>) -> Result<Sfx> {
        let (sfx, sfx_renderer) = Sfx::new(clip, buffer_size);
        self.add_renderer(sfx_renderer)?;
        Ok(sfx)
    }

    pub fn create_music(&mut self, clip: AudioClip, settings: MusicParams) -> Result<Music> {
        let (music, music_renderer) = Music::new(clip, settings);
        self.add_renderer(music_renderer)?;
        Ok(music)
    }

    pub fn add_renderer(&mut self, renderer: impl Renderer + 'static) -> Result<()> {
        self.tx
            .send(MixerCommand::AddRenderer(Box::new(renderer)))
            .map_err(buffer_is_full)
            .context("add renderer")?;
        Ok(())
    }

    pub fn estimate_latency(&self) -> f32 {
        f32::from_bits(self.latency.load(Ordering::Relaxed))
    }

    #[inline(always)]
    pub fn consume_broken(&self) -> bool {
        self.backend.consume_broken()
    }

    #[inline(always)]
    pub fn start(&mut self) -> Result<()> {
        self.backend.start()
    }

    pub fn recover_if_needed(&mut self) -> Result<()> {
        if self.consume_broken() {
            self.start()
        } else {
            Ok(())
        }
    }
}
