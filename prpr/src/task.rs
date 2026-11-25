//! Time consuming task management.

use std::{
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
};

#[cfg(not(target_arch = "wasm32"))]
pub trait TaskBound: Send + 'static {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + 'static> TaskBound for T {}

#[cfg(target_arch = "wasm32")]
pub trait TaskBound: 'static {}
#[cfg(target_arch = "wasm32")]
impl<T: 'static> TaskBound for T {}

#[cfg(target_arch = "wasm32")]
mod wasm_exec {
    use std::{
        cell::RefCell,
        future::Future,
        pin::Pin,
        task::{Context, RawWaker, RawWakerVTable, Waker},
    };

    thread_local! {
        static TASKS: RefCell<Vec<Pin<Box<dyn Future<Output = ()>>>>> = const { RefCell::new(Vec::new()) };
    }

    pub fn spawn(future: impl Future<Output = ()> + 'static) {
        TASKS.with(|it| it.borrow_mut().push(Box::pin(future)));
    }

    fn waker() -> Waker {
        unsafe fn clone(data: *const ()) -> RawWaker {
            RawWaker::new(data, &VTABLE)
        }
        unsafe fn wake(_data: *const ()) {}
        unsafe fn wake_by_ref(data: *const ()) {
            wake(data)
        }
        unsafe fn drop(_data: *const ()) {}
        const VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop);
        unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
    }

    /// Drives all pending wasm tasks. Must be called once per frame.
    pub fn poll_all() {
        TASKS.with(|it| {
            let mut tasks = std::mem::take(&mut *it.borrow_mut());
            let waker = waker();
            let mut cx = Context::from_waker(&waker);
            tasks.retain_mut(|task| task.as_mut().poll(&mut cx).is_pending());
            it.borrow_mut().extend(tasks);
        });
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm_exec::poll_all;

pub struct Task<T: TaskBound>(Arc<Mutex<Option<T>>>);

impl<T: TaskBound> Clone for Task<T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<T: TaskBound> Task<T> {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(future: impl Future<Output = T> + Send + 'static) -> Self {
        let arc = Arc::new(Mutex::new(None));
        {
            let arc = Arc::clone(&arc);
            tokio::spawn(async move {
                let result = future.await;
                *arc.lock().unwrap() = Some(result);
            });
        }
        Self(arc)
    }

    #[cfg(target_arch = "wasm32")]
    pub fn new(future: impl Future<Output = T> + 'static) -> Self {
        let arc = Arc::new(Mutex::new(None));
        {
            let arc = Arc::clone(&arc);
            wasm_exec::spawn(async move {
                let result = future.await;
                *arc.lock().unwrap() = Some(result);
            });
        }
        Self(arc)
    }

    pub fn pending() -> Self {
        Self::new(std::future::pending())
    }

    pub fn ok(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    pub fn take(&mut self) -> Option<T> {
        self.0.lock().unwrap().take()
    }

    pub fn get(&self) -> MutexGuard<'_, Option<T>> {
        self.0.lock().unwrap()
    }
}

impl<T: TaskBound + Clone> Task<T> {
    pub fn clone_result(&self) -> Option<T> {
        self.0.lock().unwrap().clone()
    }
}
