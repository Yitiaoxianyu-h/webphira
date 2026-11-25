//! Implementation for wasm32-unknown-unknown backed by the host page.
//!
//! The page defines `host_random(ptr, len)` in its JS glue and fills the given
//! range of wasm memory with cryptographically secure random bytes (usually
//! via `crypto.getRandomValues`).

use crate::Error;
use core::mem::MaybeUninit;

extern "C" {
    fn host_random(ptr: *mut u8, len: usize);
}

pub(crate) fn getrandom_inner(dest: &mut [MaybeUninit<u8>]) -> Result<(), Error> {
    unsafe { host_random(dest.as_mut_ptr() as *mut u8, dest.len()) };
    Ok(())
}
