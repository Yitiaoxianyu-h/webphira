//! 浏览器端（wasm）的 phira-mp 客户端。
//!
//! 与原生实现（`phira-mp-client`）的差别只在**传输层**：浏览器不能开原始
//! TCP，所以字节流交给页面里的 HTTP 隧道（`web/host.js` 的 `host_mp_*`），
//! 协议的编解码（`phira-mp-common` 的 bin / command）与原生完全一致。
//!
//! wasm 是单线程，这里不用 tokio 的异步原语：
//!
//! * 状态用 `std::sync::Mutex` 保存（同帧内读写，不会跨线程）；
//! * 起一个常驻 `prpr::task::Task`，每帧被 `poll_all` 驱动一次 —— 从隧道
//!   拉字节、解析 `ServerCommand`、按需发心跳；
//! * 需要等应答的调用（认证 / 建房 / 入房 …）挂在这个任务上轮询等待，
//!   超时用 `host_now()`（performance.now）判定。

use anyhow::{anyhow, bail, Result};
use phira_mp_common::{
    decode_packet, encode_packet, ClientCommand, ClientRoomState, JoinRoomResponse, JudgeEvent,
    Message, RoomId, RoomState, ServerCommand, TouchFrame, UserInfo, Varchar,
};
use prpr::task::Task;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    task::Poll,
};

/// 等待应答的超时（秒），与原生 `phira-mp-client::TIMEOUT` 一致。
const TIMEOUT: f64 = 7.;
/// 心跳间隔（秒），与 `phira_mp_common::HEARTBEAT_INTERVAL` 一致。
const PING_INTERVAL: f64 = 3.;
/// 隧道建立的最长等待（秒）。
const CONNECT_TIMEOUT: f64 = 10.;

/// 观战数据：某个玩家的实时触摸帧与判定事件。
///
/// 主程序只负责**发送**这些数据（`song.rs` 的 update_fn），接收方是
/// `phira-monitor`，所以这里只保留与原生一致的容器形态。
pub struct LivePlayer {
    pub touch_frames: Mutex<Vec<TouchFrame>>,
    pub judge_events: Mutex<Vec<JudgeEvent>>,
}

impl Default for LivePlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl LivePlayer {
    pub fn new() -> Self {
        Self {
            touch_frames: Mutex::default(),
            judge_events: Mutex::default(),
        }
    }
}

type Slot<T> = Arc<Mutex<Option<Result<T, String>>>>;

fn slot<T>() -> Slot<T> {
    Arc::new(Mutex::new(None))
}

struct State {
    me: Mutex<Option<UserInfo>>,
    room: Mutex<Option<ClientRoomState>>,
    messages: Mutex<Vec<Message>>,
    live_players: Mutex<HashMap<i32, Arc<LivePlayer>>>,
    rx: Mutex<Vec<u8>>,
    last_ping: Mutex<f64>,

    cb_authenticate: Slot<(UserInfo, Option<ClientRoomState>)>,
    cb_chat: Slot<()>,
    cb_create_room: Slot<()>,
    cb_join_room: Slot<JoinRoomResponse>,
    cb_leave_room: Slot<()>,
    cb_lock_room: Slot<()>,
    cb_cycle_room: Slot<()>,
    cb_select_chart: Slot<()>,
    cb_request_start: Slot<()>,
    cb_ready: Slot<()>,
    cb_cancel_ready: Slot<()>,
    cb_played: Slot<()>,
    cb_abort: Slot<()>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            me: Mutex::default(),
            room: Mutex::default(),
            messages: Mutex::default(),
            live_players: Mutex::default(),
            rx: Mutex::default(),
            last_ping: Mutex::new(0.),
            cb_authenticate: slot(),
            cb_chat: slot(),
            cb_create_room: slot(),
            cb_join_room: slot(),
            cb_leave_room: slot(),
            cb_lock_room: slot(),
            cb_cycle_room: slot(),
            cb_select_chart: slot(),
            cb_request_start: slot(),
            cb_ready: slot(),
            cb_cancel_ready: slot(),
            cb_played: slot(),
            cb_abort: slot(),
        }
    }
}

pub struct Client {
    state: Arc<State>,
    // 常驻网络任务：持有 Weak，Client 释放后自动退出。
    _net_task: Task<()>,
}

/// 让出一次调度（下一次 `poll_all` 再继续）。
async fn yield_now() {
    let mut yielded = false;
    std::future::poll_fn(move |_cx| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            Poll::Pending
        }
    })
    .await
}

/// 把命令编码成「LEB128 长度前缀 + payload」的完整帧（隧道传输用的就是 TCP 上的字节）。
fn frame_of(cmd: &ClientCommand) -> Vec<u8> {
    let mut payload = Vec::new();
    encode_packet(cmd, &mut payload);

    let mut out = Vec::with_capacity(payload.len() + 5);
    let mut x = payload.len() as u64;
    loop {
        let mut byte = (x & 0x7f) as u8;
        x >>= 7;
        if x != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if x == 0 {
            break;
        }
    }
    out.extend_from_slice(&payload);
    out
}

fn send_command(cmd: &ClientCommand) -> Result<()> {
    if prpr::web_host::mp_send(&frame_of(cmd)) < 0 {
        bail!("联机隧道未连接");
    }
    Ok(())
}

enum Decoded {
    Cmd(ServerCommand),
    /// 帧损坏，已丢弃。
    Skip,
    /// 数据还不够一个完整帧。
    NeedMore,
}

fn decode_frame(buf: &mut Vec<u8>) -> Decoded {
    let mut len: u64 = 0;
    let mut shift = 0u32;
    let mut i = 0usize;
    loop {
        if i >= buf.len() {
            return Decoded::NeedMore;
        }
        let b = buf[i];
        len |= ((b & 0x7f) as u64) << shift;
        i += 1;
        shift += 7;
        if b & 0x80 == 0 {
            break;
        }
        if shift > 32 {
            buf.drain(..i);
            return Decoded::Skip;
        }
    }

    let len = len as usize;
    if buf.len() < i + len {
        return Decoded::NeedMore;
    }
    let payload = buf[i..i + len].to_vec();
    buf.drain(..i + len);
    match decode_packet::<ServerCommand>(&payload) {
        Ok(cmd) => Decoded::Cmd(cmd),
        Err(_) => Decoded::Skip,
    }
}

fn live_player_of(state: &Arc<State>, id: i32) -> Arc<LivePlayer> {
    let mut guard = state.live_players.lock().unwrap();
    Arc::clone(
        guard
            .entry(id)
            .or_insert_with(|| Arc::new(LivePlayer::new())),
    )
}

fn handle_command(state: &Arc<State>, cmd: ServerCommand) {
    match cmd {
        ServerCommand::Pong => {}
        ServerCommand::Authenticate(res) => {
            *state.cb_authenticate.lock().unwrap() = Some(res);
        }
        ServerCommand::Chat(res) => {
            *state.cb_chat.lock().unwrap() = Some(res);
        }
        ServerCommand::Touches { player, frames } => {
            live_player_of(state, player)
                .touch_frames
                .lock()
                .unwrap()
                .extend(frames.iter().cloned());
        }
        ServerCommand::Judges { player, judges } => {
            live_player_of(state, player)
                .judge_events
                .lock()
                .unwrap()
                .extend(judges.iter().cloned());
        }
        ServerCommand::Message(msg) => {
            if let Some(room) = state.room.lock().unwrap().as_mut() {
                match &msg {
                    Message::LockRoom { lock } => room.locked = *lock,
                    Message::CycleRoom { cycle } => room.cycle = *cycle,
                    Message::LeaveRoom { user, .. } => {
                        room.users.remove(user);
                    }
                    _ => {}
                }
            }
            state.messages.lock().unwrap().push(msg);
        }
        ServerCommand::ChangeState(room_state) => {
            state.live_players.lock().unwrap().clear();
            if let Some(room) = state.room.lock().unwrap().as_mut() {
                room.state = room_state;
                room.is_ready = room.is_host;
            }
        }
        ServerCommand::ChangeHost(me_is_host) => {
            if let Some(room) = state.room.lock().unwrap().as_mut() {
                room.is_host = me_is_host;
            }
        }
        ServerCommand::CreateRoom(res) => {
            *state.cb_create_room.lock().unwrap() = Some(res);
        }
        ServerCommand::JoinRoom(res) => {
            *state.cb_join_room.lock().unwrap() = Some(res);
        }
        ServerCommand::OnJoinRoom(user) => {
            if let Some(room) = state.room.lock().unwrap().as_mut() {
                room.live |= user.monitor;
                room.users.insert(user.id, user);
            }
        }
        ServerCommand::LeaveRoom(res) => {
            *state.cb_leave_room.lock().unwrap() = Some(res);
        }
        ServerCommand::LockRoom(res) => {
            *state.cb_lock_room.lock().unwrap() = Some(res);
        }
        ServerCommand::CycleRoom(res) => {
            *state.cb_cycle_room.lock().unwrap() = Some(res);
        }
        ServerCommand::SelectChart(res) => {
            *state.cb_select_chart.lock().unwrap() = Some(res);
        }
        ServerCommand::RequestStart(res) => {
            *state.cb_request_start.lock().unwrap() = Some(res);
        }
        ServerCommand::Ready(res) => {
            *state.cb_ready.lock().unwrap() = Some(res);
        }
        ServerCommand::CancelReady(res) => {
            *state.cb_cancel_ready.lock().unwrap() = Some(res);
        }
        ServerCommand::Played(res) => {
            *state.cb_played.lock().unwrap() = Some(res);
        }
        ServerCommand::Abort(res) => {
            *state.cb_abort.lock().unwrap() = Some(res);
        }
    }
}

/// 每帧执行一次：拉字节 → 解析 → 心跳。
fn poll_network(state: &Arc<State>) {
    let mut buf = [0u8; 16384];
    loop {
        let n = prpr::web_host::mp_recv(&mut buf);
        if n == 0 {
            break;
        }
        state.rx.lock().unwrap().extend_from_slice(&buf[..n]);
    }

    loop {
        let item = {
            let mut rx = state.rx.lock().unwrap();
            decode_frame(&mut rx)
        };
        match item {
            Decoded::NeedMore => break,
            Decoded::Skip => continue,
            Decoded::Cmd(cmd) => handle_command(state, cmd),
        }
    }

    let now = prpr::web_host::now();
    let should_ping = {
        let mut last = state.last_ping.lock().unwrap();
        if *last == 0. || now - *last >= PING_INTERVAL {
            *last = now;
            true
        } else {
            false
        }
    };
    if should_ping {
        let _ = send_command(&ClientCommand::Ping);
    }
}

async fn await_slot<T: Clone>(slot: &Slot<T>) -> Result<T> {
    let deadline = prpr::web_host::now() + TIMEOUT;
    let outcome = std::future::poll_fn(|_cx| {
        let v = slot.lock().unwrap().clone();
        if let Some(v) = v {
            Poll::Ready(v)
        } else if prpr::web_host::now() > deadline {
            Poll::Ready(Err("response timeout".to_owned()))
        } else {
            Poll::Pending
        }
    })
    .await;
    outcome.map_err(anyhow::Error::msg)
}

impl Client {
    /// 连接联机服务器（建立隧道，尚未认证）。
    pub async fn from_address(addr: &str) -> Result<Self> {
        // 初始帧留空：真正的认证帧在 `authenticate` 里通过 mp_set_init 补上。
        prpr::web_host::mp_open(addr, &[]);

        let deadline = prpr::web_host::now() + CONNECT_TIMEOUT;
        loop {
            let s = prpr::web_host::mp_status();
            if s == 2 {
                break;
            }
            if s < 0 {
                let err = prpr::web_host::mp_error();
                bail!(if err.is_empty() {
                    "连接联机网关失败".to_owned()
                } else {
                    format!("连接联机网关失败：{err}")
                });
            }
            if prpr::web_host::now() > deadline {
                bail!("连接联机网关超时");
            }
            yield_now().await;
        }

        let state = Arc::new(State::default());
        let weak: Weak<State> = Arc::downgrade(&state);
        let net_task = Task::new(async move {
            loop {
                let Some(state) = weak.upgrade() else {
                    break;
                };
                poll_network(&state);
                drop(state);
                yield_now().await;
            }
        });

        Ok(Self {
            state,
            _net_task: net_task,
        })
    }

    async fn call<T: Clone>(&self, cmd: ClientCommand, slot: &Slot<T>) -> Result<T> {
        *slot.lock().unwrap() = None;
        send_command(&cmd)?;
        await_slot(slot).await
    }

    pub async fn authenticate(&self, token: impl Into<String>) -> Result<()> {
        let token: Varchar<32> = token.into().try_into()?;
        let cmd = ClientCommand::Authenticate { token };
        // 隧道每次（重）连都会先把这个认证帧写进 TCP，所以周期性重连不会掉线。
        prpr::web_host::mp_set_init(&frame_of(&cmd));
        let (me, room) = self.call(cmd, &self.state.cb_authenticate).await?;
        *self.state.me.lock().unwrap() = Some(me);
        *self.state.room.lock().unwrap() = room;
        Ok(())
    }

    pub async fn chat(&self, message: String) -> Result<()> {
        let message: Varchar<200> = message.try_into()?;
        self.call(ClientCommand::Chat { message }, &self.state.cb_chat)
            .await
    }

    pub async fn create_room(&self, id: RoomId) -> Result<()> {
        self.call(
            ClientCommand::CreateRoom { id: id.clone() },
            &self.state.cb_create_room,
        )
        .await?;
        let me = self
            .state
            .me
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow!("还没有认证"))?;
        *self.state.room.lock().unwrap() = Some(ClientRoomState {
            id,
            state: RoomState::default(),
            live: false,
            locked: false,
            cycle: false,
            is_host: true,
            is_ready: false,
            users: std::iter::once((me.id, me)).collect(),
        });
        Ok(())
    }

    pub async fn join_room(&self, id: RoomId, monitor: bool) -> Result<()> {
        let resp = self
            .call(
                ClientCommand::JoinRoom {
                    id: id.clone(),
                    monitor,
                },
                &self.state.cb_join_room,
            )
            .await?;
        *self.state.room.lock().unwrap() = Some(ClientRoomState {
            id,
            state: resp.state,
            live: resp.live,
            locked: false,
            cycle: false,
            is_host: false,
            is_ready: false,
            users: resp.users.into_iter().map(|it| (it.id, it)).collect(),
        });
        Ok(())
    }

    pub async fn leave_room(&self) -> Result<()> {
        self.call(ClientCommand::LeaveRoom, &self.state.cb_leave_room)
            .await?;
        *self.state.room.lock().unwrap() = None;
        Ok(())
    }

    pub async fn lock_room(&self, lock: bool) -> Result<()> {
        self.call(ClientCommand::LockRoom { lock }, &self.state.cb_lock_room)
            .await
    }

    pub async fn cycle_room(&self, cycle: bool) -> Result<()> {
        self.call(ClientCommand::CycleRoom { cycle }, &self.state.cb_cycle_room)
            .await
    }

    pub async fn select_chart(&self, id: i32) -> Result<()> {
        self.call(
            ClientCommand::SelectChart { id },
            &self.state.cb_select_chart,
        )
        .await
    }

    pub async fn request_start(&self) -> Result<()> {
        self.call(ClientCommand::RequestStart, &self.state.cb_request_start)
            .await?;
        if let Some(room) = self.state.room.lock().unwrap().as_mut() {
            room.is_ready = true;
        }
        Ok(())
    }

    pub async fn ready(&self) -> Result<()> {
        self.call(ClientCommand::Ready, &self.state.cb_ready).await?;
        if let Some(room) = self.state.room.lock().unwrap().as_mut() {
            room.is_ready = true;
        }
        Ok(())
    }

    pub async fn cancel_ready(&self) -> Result<()> {
        self.call(ClientCommand::CancelReady, &self.state.cb_cancel_ready)
            .await?;
        if let Some(room) = self.state.room.lock().unwrap().as_mut() {
            room.is_ready = false;
        }
        Ok(())
    }

    pub async fn played(&self, id: i32) -> Result<()> {
        self.call(ClientCommand::Played { id }, &self.state.cb_played)
            .await
    }

    pub async fn abort(&self) -> Result<()> {
        self.call(ClientCommand::Abort, &self.state.cb_abort).await
    }

    pub async fn room_state(&self) -> Option<RoomState> {
        self.state.room.lock().unwrap().as_ref().map(|it| it.state)
    }

    pub fn blocking_state(&self) -> Option<ClientRoomState> {
        self.state.room.lock().unwrap().clone()
    }

    pub fn blocking_room_id(&self) -> Option<RoomId> {
        self.state
            .room
            .lock()
            .unwrap()
            .as_ref()
            .map(|it| it.id.clone())
    }

    pub fn blocking_room_state(&self) -> Option<RoomState> {
        self.state.room.lock().unwrap().as_ref().map(|it| it.state)
    }

    pub fn blocking_is_host(&self) -> Option<bool> {
        self.state.room.lock().unwrap().as_ref().map(|it| it.is_host)
    }

    pub fn blocking_is_ready(&self) -> Option<bool> {
        self.state
            .room
            .lock()
            .unwrap()
            .as_ref()
            .map(|it| it.is_ready)
    }

    pub fn blocking_take_messages(&self) -> Vec<Message> {
        std::mem::take(&mut *self.state.messages.lock().unwrap())
    }

    pub fn user_name(&self, id: i32) -> String {
        self.user_name_opt(id).unwrap_or_else(|| "?".to_owned())
    }

    pub fn user_name_opt(&self, id: i32) -> Option<String> {
        self.state
            .room
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|it| it.users.get(&id).map(|it| it.name.clone()))
    }

    pub fn blocking_send(&self, payload: ClientCommand) -> Result<()> {
        send_command(&payload)
    }

    pub fn live_player(&self, player: i32) -> Arc<LivePlayer> {
        live_player_of(&self.state, player)
    }

    /// 隧道断开时返回 2，触发面板 / 对局里的自动重连逻辑。
    pub fn ping_fail_count(&self) -> u8 {
        if prpr::web_host::mp_status() < 0 {
            2
        } else {
            0
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        if Arc::strong_count(&self.state) <= 1 {
            prpr::web_host::mp_close();
        }
    }
}
