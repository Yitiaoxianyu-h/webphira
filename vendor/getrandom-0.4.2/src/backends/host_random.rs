//! Implementation for wasm32-unknown-unknown backed by the host page.
//!
//! `host_random` is defined by the page's JS glue and fills the given range of
//! wasm memory with cryptographically secure random bytes.

use crate::Error;
use core::mem::MaybeUninit;

pub use crate::util::{inner_u32, inner_u64};

unsafe extern "C" {
    fn host_random(ptr: *mut u8, len: usize);
}

#[inline]
pub fn fill_inner(dest: &mut [MaybeUninit<u8>]) -> Result<(), Error> {
    unsafe { host_random(dest.as_mut_ptr() as *mut u8, dest.len()) };
    Ok(())
}
