//! Directory helper

use anyhow::{bail, Result};
use std::path::{Component, Path, PathBuf};

use crate::web_fs::ReadDir;

pub struct Dir(PathBuf);

impl Dir {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if !crate::web_fs::is_dir(&path) {
            bail!("not dir")
        }
        Ok(Self(path))
    }

    pub fn join(&self, path: impl AsRef<Path>) -> Result<PathBuf> {
        let path = path.as_ref();
        let mut res = self.0.clone();
        let mut depth = 0;
        for comp in path.components() {
            match comp {
                Component::Prefix(_) => {
                    bail!("prefix inside dir");
                }
                Component::ParentDir => {
                    if depth == 0 {
                        bail!("path traversal");
                    }
                    res.pop();
                    depth -= 1;
                }
                Component::Normal(name) => {
                    res.push(name);
                    depth += 1;
                }
                Component::RootDir | Component::CurDir => {}
            }
        }
        Ok(res)
    }

    #[inline]
    pub fn create_dir_all(&self, p: impl AsRef<Path>) -> Result<()> {
        crate::web_fs::create_dir_all(self.join(p)?)?;
        Ok(())
    }

    #[inline]
    pub fn remove_dir_all(&self, p: impl AsRef<Path>) -> Result<()> {
        crate::web_fs::remove_dir_all(self.join(p)?)?;
        Ok(())
    }

    #[inline]
    pub fn open_dir(&self, p: impl AsRef<Path>) -> Result<Self> {
        Self::new(self.join(p)?)
    }

    #[inline]
    pub fn create(&self, p: impl AsRef<Path>) -> Result<crate::web_fs::File> {
        Ok(crate::web_fs::File::create(self.join(p)?)?)
    }

    #[inline]
    pub fn open(&self, p: impl AsRef<Path>) -> Result<crate::web_fs::File> {
        Ok(crate::web_fs::File::open(self.join(p)?)?)
    }

    #[inline]
    pub fn exists(&self, p: impl AsRef<Path>) -> Result<bool> {
        Ok(crate::web_fs::exists(self.join(p)?))
    }

    #[inline]
    pub fn read(&self, p: impl AsRef<Path>) -> Result<Vec<u8>> {
        Ok(crate::web_fs::read(self.join(p)?)?)
    }

    #[inline]
    pub fn read_dir(&self, p: impl AsRef<Path>) -> Result<ReadDir> {
        Ok(crate::web_fs::read_dir(self.join(p)?)?)
    }
}
