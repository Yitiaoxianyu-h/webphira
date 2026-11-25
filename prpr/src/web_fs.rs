//! 文件系统抽象。
//!
//! native 平台直接转发到 `std::fs`；wasm32 没有文件系统，因此用一个内存
//! 哈希表作为虚拟文件系统（VFS），并通过 `host_storage_*` 导入把文件持久化
//! 到页面的 `localStorage`（JS 端会尽力而为，容量不足时忽略错误）。
//!
//! 目录是隐式的：只要存在以 `path + '/'` 开头的文件，`path` 就被视为目录。

use std::{
    ffi::OsString,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[cfg(not(target_arch = "wasm32"))]
pub use native::*;

#[cfg(target_arch = "wasm32")]
pub use web::*;

// ---------------------------------------------------------------------------
// native：全部转发到 std::fs
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;

    /// 文件元数据，包装 `std::fs::Metadata`。
    pub struct Metadata(std::fs::Metadata);

    impl Metadata {
        pub fn is_dir(&self) -> bool {
            self.0.is_dir()
        }

        pub fn is_file(&self) -> bool {
            self.0.is_file()
        }
    }

    /// 文件类型，包装 `std::fs::FileType`。
    pub struct FileType(std::fs::FileType);

    impl FileType {
        pub fn is_dir(&self) -> bool {
            self.0.is_dir()
        }

        pub fn is_file(&self) -> bool {
            self.0.is_file()
        }
    }

    /// 目录项，保存路径、文件名与文件类型。
    pub struct DirEntry {
        name: OsString,
        path: PathBuf,
        file_type: std::fs::FileType,
    }

    impl DirEntry {
        pub fn file_name(&self) -> OsString {
            self.name.clone()
        }

        pub fn path(&self) -> PathBuf {
            self.path.clone()
        }

        pub fn file_type(&self) -> io::Result<FileType> {
            Ok(FileType(self.file_type.clone()))
        }
    }

    /// 目录迭代器。native 端先一次性收集所有目录项。
    pub struct ReadDir {
        items: Vec<io::Result<DirEntry>>,
        index: usize,
    }

    impl Iterator for ReadDir {
        type Item = io::Result<DirEntry>;

        fn next(&mut self) -> Option<Self::Item> {
            if self.index >= self.items.len() {
                return None;
            }
            let index = self.index;
            self.index += 1;
            match &self.items[index] {
                Ok(entry) => Some(Ok(DirEntry {
                    name: entry.name.clone(),
                    path: entry.path.clone(),
                    file_type: entry.file_type.clone(),
                })),
                // io::Error 不可 Clone，这里重新构造一个同类型的错误
                Err(err) => Some(Err(io::Error::new(err.kind(), err.to_string()))),
            }
        }
    }

    pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
        std::fs::read_to_string(path)
    }

    pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
        std::fs::write(path, contents)
    }

    pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
        std::fs::create_dir(path)
    }

    pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        std::fs::create_dir_all(path)
    }

    pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    pub fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        std::fs::remove_dir_all(path)
    }

    pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    pub fn exists(path: impl AsRef<Path>) -> bool {
        path.as_ref().exists()
    }

    pub fn is_dir(path: impl AsRef<Path>) -> bool {
        path.as_ref().is_dir()
    }

    pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
        std::fs::metadata(path).map(Metadata)
    }

    pub fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
        let items = std::fs::read_dir(path)?
            .map(|item| {
                let entry = item?;
                let file_type = entry.file_type()?;
                Ok(DirEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    file_type,
                })
            })
            .collect();
        Ok(ReadDir { items, index: 0 })
    }

    /// 文件句柄，直接包装 `std::fs::File`。
    pub struct File(std::fs::File);

    impl File {
        pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
            std::fs::File::open(path).map(Self)
        }

        pub fn create(path: impl AsRef<Path>) -> io::Result<Self> {
            std::fs::File::create(path).map(Self)
        }
    }

    impl From<std::fs::File> for File {
        fn from(file: std::fs::File) -> Self {
            Self(file)
        }
    }

    impl Read for File {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for File {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    impl Seek for File {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.0.seek(pos)
        }
    }
}

// ---------------------------------------------------------------------------
// wasm32：内存 VFS + localStorage 持久化
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
mod web {
    use super::*;
    use std::{
        cell::RefCell,
        collections::{BTreeSet, HashMap, HashSet},
        io::Cursor,
    };

    // 由页面 JS 提供（见 web/host.js），这里只声明不实现。
    // 返回值约定：>= 0 为字节数，-1 表示不存在/失败，-2 表示缓冲区太小。
    unsafe extern "C" {
        fn host_storage_size(path_ptr: *const u8, path_len: usize) -> i32;
        fn host_storage_read(path_ptr: *const u8, path_len: usize, out: *mut u8, cap: usize) -> i32;
        fn host_storage_write(path_ptr: *const u8, path_len: usize, data: *const u8, data_len: usize) -> i32;
        fn host_storage_remove(path_ptr: *const u8, path_len: usize) -> i32;
        fn host_storage_keys(out: *mut u8, cap: usize) -> i32;
    }

    /// 路径规范化：
    /// - `\` 统一成 `/`
    /// - 去掉 Windows 盘符（`D:/foo` -> `foo`）
    /// - 去掉开头的 `./` 与 `/`，合并连续斜杠
    /// - 根目录表示为空字符串
    fn normalize(path: impl AsRef<Path>) -> String {
        let mut s = path.as_ref().to_string_lossy().replace('\\', "/");
        if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
            s.replace_range(..2, "");
        }
        let mut parts = Vec::new();
        for part in s.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            parts.push(part);
        }
        parts.join("/")
    }

    /// 从 localStorage 读取整个文件；不存在时返回 `None`。
    fn host_get(path: &str) -> Option<Vec<u8>> {
        let size = unsafe { host_storage_size(path.as_ptr(), path.len()) };
        if size < 0 {
            return None;
        }
        if size == 0 {
            return Some(Vec::new());
        }
        let mut buffer = vec![0u8; size as usize];
        let read = unsafe { host_storage_read(path.as_ptr(), path.len(), buffer.as_mut_ptr(), buffer.len()) };
        if read < 0 {
            return None;
        }
        buffer.truncate(read as usize);
        Some(buffer)
    }

    /// 尽力写入 localStorage；返回是否成功（容量不足时可能失败）。
    fn host_set(path: &str, data: &[u8]) -> bool {
        unsafe { host_storage_write(path.as_ptr(), path.len(), data.as_ptr(), data.len()) >= 0 }
    }

    fn host_remove(path: &str) {
        unsafe {
            host_storage_remove(path.as_ptr(), path.len());
        }
    }

    /// 读取所有已持久化的路径（换行分隔）。
    /// 缓冲区不够（-2）时逐步扩大后重试，避免一次性分配过大。
    fn host_keys() -> Vec<String> {
        let mut capacity = 64 * 1024;
        loop {
            let mut buffer = vec![0u8; capacity];
            let read = unsafe { host_storage_keys(buffer.as_mut_ptr(), buffer.len()) };
            if read >= 0 {
                buffer.truncate(read as usize);
                return String::from_utf8_lossy(&buffer)
                    .lines()
                    .map(normalize)
                    .filter(|key| !key.is_empty())
                    .collect();
            }
            if read != -2 || capacity >= 16 * 1024 * 1024 {
                return Vec::new();
            }
            capacity *= 2;
        }
    }

    struct Vfs {
        /// 已载入内存的文件内容
        files: HashMap<String, Vec<u8>>,
        /// 显式创建过的目录（vfs 的目录本身是隐式的，但空目录需要单独记录）
        dirs: HashSet<String>,
        /// 是否已经从 localStorage 拉取过键列表
        keys_loaded: bool,
        /// localStorage 中确实存在的路径（可能还没读入 `files`）
        persisted: HashSet<String>,
    }

    impl Vfs {
        fn new() -> Self {
            Self {
                files: HashMap::new(),
                dirs: HashSet::new(),
                keys_loaded: false,
                persisted: HashSet::new(),
            }
        }

        /// 首次需要列目录 / 查询持久化文件时，惰性拉取全部键。
        fn ensure_keys_loaded(&mut self) {
            if self.keys_loaded {
                return;
            }
            self.keys_loaded = true;
            for key in host_keys() {
                self.persisted.insert(key);
            }
        }

        fn contains(&self, path: &str) -> bool {
            self.files.contains_key(path) || self.persisted.contains(path)
        }

        /// 目录是隐式的：存在以 `path/` 开头的文件即视为目录。
        fn is_dir(&self, path: &str) -> bool {
            if path.is_empty() {
                return true;
            }
            if self.dirs.contains(path) {
                return true;
            }
            let prefix = format!("{path}/");
            self.files.keys().any(|key| key.starts_with(&prefix))
                || self.persisted.iter().any(|key| key.starts_with(&prefix))
        }

        /// 内存中与 localStorage 中的键的并集（已排序，便于稳定输出）。
        fn all_keys(&self) -> BTreeSet<String> {
            let mut keys: BTreeSet<String> = self.persisted.iter().cloned().collect();
            for key in self.files.keys() {
                keys.insert(key.clone());
            }
            keys
        }
    }

    thread_local! {
        static VFS: RefCell<Vfs> = RefCell::new(Vfs::new());
    }

    fn not_found(path: &str) -> io::Error {
        io::Error::new(io::ErrorKind::NotFound, format!("no such file or directory: {path}"))
    }

    pub struct Metadata {
        is_dir: bool,
    }

    impl Metadata {
        pub fn is_dir(&self) -> bool {
            self.is_dir
        }

        pub fn is_file(&self) -> bool {
            !self.is_dir
        }
    }

    pub struct FileType {
        is_dir: bool,
    }

    impl FileType {
        pub fn is_dir(&self) -> bool {
            self.is_dir
        }

        pub fn is_file(&self) -> bool {
            !self.is_dir
        }
    }

    pub struct DirEntry {
        name: OsString,
        path: PathBuf,
        is_dir: bool,
    }

    impl DirEntry {
        pub fn file_name(&self) -> OsString {
            self.name.clone()
        }

        pub fn path(&self) -> PathBuf {
            self.path.clone()
        }

        pub fn file_type(&self) -> io::Result<FileType> {
            Ok(FileType { is_dir: self.is_dir })
        }
    }

    pub struct ReadDir {
        items: Vec<io::Result<DirEntry>>,
        index: usize,
    }

    impl Iterator for ReadDir {
        type Item = io::Result<DirEntry>;

        fn next(&mut self) -> Option<Self::Item> {
            if self.index >= self.items.len() {
                return None;
            }
            let index = self.index;
            self.index += 1;
            match &self.items[index] {
                Ok(entry) => Some(Ok(DirEntry {
                    name: entry.name.clone(),
                    path: entry.path.clone(),
                    is_dir: entry.is_dir,
                })),
                Err(err) => Some(Err(io::Error::new(err.kind(), err.to_string()))),
            }
        }
    }

    pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
        let path = normalize(path);

        // 先查内存缓存
        let cached = VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            vfs.files.get(&path).cloned()
        });
        if let Some(data) = cached {
            return Ok(data);
        }

        // 缓存未命中，再尝试从 localStorage 读取
        if let Some(data) = host_get(&path) {
            VFS.with(|cell| {
                cell.borrow_mut().files.insert(path.clone(), data.clone());
            });
            return Ok(data);
        }

        Err(not_found(&path))
    }

    pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
        let path = normalize(path);
        String::from_utf8(read(&path)?).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
    }

    pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
        let path = normalize(path);
        let data = contents.as_ref().to_vec();

        // localStorage 写入失败（例如超出配额）不影响本次会话的内存读取
        let persisted = host_set(&path, &data);

        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            vfs.files.insert(path.clone(), data);
            if persisted {
                vfs.persisted.insert(path.clone());
            }
        });
        Ok(())
    }

    /// 目录是隐式的，但空目录需要显式记录，否则 `Dir::new` 会判定失败。
    fn mark_dir(vfs: &mut Vfs, path: &str) {
        vfs.dirs.insert(String::new());
        let mut current = path.to_owned();
        loop {
            vfs.dirs.insert(current.clone());
            match current.rsplit_once('/') {
                Some((parent, _)) => current = parent.to_owned(),
                None => break,
            }
        }
    }

    pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normalize(path);
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            mark_dir(&mut vfs, &path);
        });
        Ok(())
    }

    pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        create_dir(path)
    }

    pub fn is_dir(path: impl AsRef<Path>) -> bool {
        let path = normalize(path);
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            vfs.is_dir(&path)
        })
    }

    pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normalize(path);
        let existed = VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            let existed = vfs.contains(&path);
            vfs.files.remove(&path);
            vfs.persisted.remove(&path);
            existed
        });
        if !existed {
            return Err(not_found(&path));
        }
        host_remove(&path);
        Ok(())
    }

    pub fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
        let path = normalize(path);
        let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
        let removed: Vec<String> = VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            let keys: Vec<String> = vfs
                .all_keys()
                .into_iter()
                .filter(|key| key.starts_with(&prefix))
                .collect();
            for key in &keys {
                vfs.files.remove(key);
                vfs.persisted.remove(key);
            }
            keys
        });
        for key in removed {
            host_remove(&key);
        }
        Ok(())
    }

    /// 重命名文件或目录。
    ///
    /// 下载谱面时会把临时目录整体 rename 到正式路径，所以必须支持目录：
    /// 把所有以 `from/` 开头的键移动到 `to/` 前缀下。
    pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
        let from = normalize(from);
        let to = normalize(to);

        let is_file = VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            vfs.contains(&from)
        });
        if is_file {
            let data = read(&from)?;
            write(&to, &data)?;
            remove_file(&from)?;
            return Ok(());
        }

        let prefix = format!("{from}/");
        let mut keys: Vec<String> = Vec::new();
        let mut is_dir = false;
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            keys = vfs.all_keys().into_iter().filter(|key| key.starts_with(&prefix)).collect();
            is_dir = vfs.is_dir(&from);
        });
        if keys.is_empty() && !is_dir {
            return Err(not_found(&from));
        }

        for key in keys {
            let data = read(&key)?;
            let rel = &key[prefix.len()..];
            let target = if to.is_empty() { rel.to_owned() } else { format!("{to}/{rel}") };
            write(&target, &data)?;
            remove_file(&key)?;
        }

        // 目录本身也要跟着移动（空目录只有标记）。
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.dirs.remove(&from);
            let stale: Vec<String> = vfs.dirs.iter().filter(|dir| dir.starts_with(&prefix)).cloned().collect();
            for dir in stale {
                vfs.dirs.remove(&dir);
            }
            mark_dir(&mut vfs, &to);
        });

        Ok(())
    }

    pub fn exists(path: impl AsRef<Path>) -> bool {
        let path = normalize(path);
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            vfs.contains(&path) || vfs.is_dir(&path)
        })
    }

    pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
        let path = normalize(path);
        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            if vfs.contains(&path) {
                Ok(Metadata { is_dir: false })
            } else if vfs.is_dir(&path) {
                Ok(Metadata { is_dir: true })
            } else {
                Err(not_found(&path))
            }
        })
    }

    /// 对不存在的目录返回空迭代器：初始化阶段经常读取可能不存在的目录。
    pub fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
        let path = normalize(path);
        let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
        let mut seen = BTreeSet::new();
        let mut items = Vec::new();

        VFS.with(|cell| {
            let mut vfs = cell.borrow_mut();
            vfs.ensure_keys_loaded();
            for key in vfs.all_keys() {
                let Some(rest) = key.strip_prefix(&prefix) else {
                    continue;
                };
                if rest.is_empty() {
                    continue;
                }
                // 只取第一层名字
                let name = rest.split('/').next().unwrap_or(rest);
                if !seen.insert(name.to_owned()) {
                    continue;
                }
                let is_dir = rest.contains('/');
                let entry_path = if path.is_empty() {
                    PathBuf::from(name)
                } else {
                    Path::new(&path).join(name)
                };
                items.push(Ok(DirEntry {
                    name: OsString::from(name),
                    path: entry_path,
                    is_dir,
                }));
            }
        });

        Ok(ReadDir { items, index: 0 })
    }

    /// 内存文件句柄：数据放在 `Cursor<Vec<u8>>` 中，写入后 flush 落盘。
    pub struct File {
        path: String,
        cursor: Cursor<Vec<u8>>,
        dirty: bool,
    }

    impl File {
        pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
            let path = normalize(path);
            let data = read(&path)?;
            Ok(Self {
                path,
                cursor: Cursor::new(data),
                dirty: false,
            })
        }

        pub fn create(path: impl AsRef<Path>) -> io::Result<Self> {
            let path = normalize(path);
            // 与 std::fs::File::create 一致，立即截断
            write(&path, &[])?;
            Ok(Self {
                path,
                cursor: Cursor::new(Vec::new()),
                dirty: false,
            })
        }
    }

    impl Read for File {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.cursor.read(buf)
        }
    }

    impl Write for File {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.dirty = true;
            self.cursor.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.dirty {
                write(&self.path, self.cursor.get_ref())?;
                self.dirty = false;
            }
            Ok(())
        }
    }

    impl Seek for File {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.cursor.seek(pos)
        }
    }

    impl Drop for File {
        fn drop(&mut self) {
            // 未显式 flush 的写入在句柄销毁时落盘
            let _ = self.flush();
        }
    }
}
