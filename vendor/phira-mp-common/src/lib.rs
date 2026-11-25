mod bin;
pub use bin::*;

mod command;
pub use command::*;

use anyhow::Result;
use std::time::Duration;

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(2);
pub const HEARTBEAT_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn encode_packet(payload: &impl BinaryData, vec: &mut Vec<u8>) {
    BinaryWriter::new(vec).write(payload).unwrap();
}

pub fn decode_packet<T>(data: &[u8]) -> Result<T>
where
    T: BinaryData,
{
    BinaryReader::new(data).read()
}

/// 原生（桌面 / 移动端）的 TCP 长连接流。
///
/// wasm32 下没有可用的 TCP，浏览器走页面里的 WebSocket 隧道（前端自带实现），
/// 所以这一段只在非 wasm 目标编译；`bin` / `command` 两个模块（纯编解码）
/// 则原生与 wasm 共用。
#[cfg(not(target_arch = "wasm32"))]
mod native_stream {
    use super::*;
    use anyhow::{Error, bail};
    use std::{future::Future, marker::PhantomData, sync::Arc};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        sync::mpsc,
        task::JoinHandle,
    };
    use tracing::{error, trace, warn};

    pub struct Stream<S, R> {
        version: u8,

        send_tx: Arc<mpsc::Sender<S>>,

        send_task_handle: JoinHandle<()>,
        recv_task_handle: JoinHandle<Result<()>>,

        _marker: PhantomData<(S, R)>,
    }

    impl<S, R> Stream<S, R>
    where
        S: BinaryData + std::fmt::Debug + Send + Sync + 'static,
        R: BinaryData + std::fmt::Debug + Send + 'static,
    {
        pub async fn new<F>(
            version: Option<u8>,
            stream: TcpStream,
            mut handler: Box<dyn FnMut(Arc<mpsc::Sender<S>>, R) -> F + Send + Sync>,
        ) -> Result<Self>
        where
            F: Future<Output = ()> + Send + 'static,
        {
            stream.set_nodelay(true)?;
            let (mut read, mut write) = stream.into_split();
            let version = if let Some(version) = version {
                write.write_u8(version).await?;
                version
            } else {
                read.read_u8().await?
            };

            let (send_tx, mut send_rx) = mpsc::channel(1024);
            let send_tx = Arc::new(send_tx);
            let send_task_handle = tokio::spawn({
                async move {
                    let mut buffer = Vec::new();
                    let mut len_buf = [0u8; 5];
                    while let Some(payload) = send_rx.recv().await {
                        buffer.clear();
                        encode_packet(&payload, &mut buffer);
                        trace!("sending {} bytes ({payload:?}): {buffer:?}", buffer.len());

                        let mut x = buffer.len() as u32;
                        let mut n = 0;
                        loop {
                            len_buf[n] = (x & 0x7f) as u8;
                            n += 1;
                            x >>= 7;
                            if x == 0 {
                                break;
                            } else {
                                len_buf[n - 1] |= 0x80;
                            }
                        }

                        if let Err(err) = async {
                            write.write_all(&len_buf[..n]).await?;
                            write.write_all(&buffer).await?;
                            Ok::<_, Error>(())
                        }
                        .await
                        {
                            error!("failed to send: {err:?}");
                        }
                    }
                }
            });

            let recv_task_handle = tokio::spawn({
                let send_tx = Arc::clone(&send_tx);
                #[allow(clippy::read_zero_byte_vec)]
                async move {
                    let mut buffer = Vec::new();
                    loop {
                        let mut len = 0u32;
                        let mut pos = 0;
                        loop {
                            let byte = read.read_u8().await?;
                            len |= ((byte & 0x7f) as u32) << pos;
                            pos += 7;
                            if byte & 0x80 == 0 {
                                break;
                            }
                            if pos > 32 {
                                bail!("invalid length");
                            }
                        }
                        if len > 2 * 1024 * 1024 {
                            bail!("data packet too large");
                        }
                        let len = len as usize;

                        buffer.resize(len, 0);
                        read.read_exact(&mut buffer).await?;
                        trace!("received {} bytes: {buffer:?}", buffer.len());

                        let payload: R = match decode_packet(&buffer) {
                            Ok(val) => val,
                            Err(err) => {
                                warn!("invalid packet: {err:?} {buffer:?}");
                                break;
                            }
                        };
                        trace!("decodes to {payload:?}");
                        handler(Arc::clone(&send_tx), payload).await;
                    }
                    Ok(())
                }
            });

            Ok(Self {
                version,

                send_tx,

                send_task_handle,
                recv_task_handle,

                _marker: PhantomData,
            })
        }

        pub fn version(&self) -> u8 {
            self.version
        }

        pub async fn send(&self, payload: S) -> Result<()> {
            self.send_tx.send(payload).await?;
            Ok(())
        }

        pub fn blocking_send(&self, payload: S) -> Result<()> {
            self.send_tx.blocking_send(payload)?;
            Ok(())
        }
    }

    impl<S, R> Drop for Stream<S, R> {
        fn drop(&mut self) {
            self.send_task_handle.abort();
            self.recv_task_handle.abort();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native_stream::Stream;
