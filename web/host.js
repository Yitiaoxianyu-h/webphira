// Phira Web 宿主环境绑定（普通 script，必须在 gl.js 之后加载）。
//
// 这里实现 Rust 侧所有 `host_*` / `on_game_start` 的 extern "C" 导入。
// miniquad 的 gl.js 会创建全局 `importObject`，我们把函数合并进它的 `env`；
// 同时挂到 `window.__miniquad_env`，供 wasm-bindgen 生成的模块在实例化前取用。

(function () {
    "use strict";

    var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var B64_LOOKUP = (function () {
        var table = new Int16Array(128);
        for (var i = 0; i < table.length; i++) table[i] = -1;
        for (var j = 0; j < B64_CHARS.length; j++) table[B64_CHARS.charCodeAt(j)] = j;
        return table;
    })();

    var STORAGE_PREFIX = "phira:";

    // 最近一次 prompt 的 UTF-8 结果；以及最近一次由 Rust 请求的文件。
    var lastPromptBytes = null;
    var pendingFile = null;

    var textEncoder = new TextEncoder();
    var textDecoder = new TextDecoder("utf-8");

    // gl.js 里 `var wasm_memory`，我们的加载流程会在实例化后设置同一个全局变量。
    function memory() {
        var mem = (typeof wasm_memory !== "undefined" && wasm_memory) ? wasm_memory : window.wasm_memory;
        if (!mem) throw new Error("wasm memory is not available yet");
        return mem;
    }

    function readUtf8(ptr, len) {
        if (!len) return "";
        var mem = memory();
        return textDecoder.decode(new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0));
    }

    function utf8Bytes(text) {
        return textEncoder.encode(text);
    }

    function writeBytes(out, cap, bytes) {
        var n = Math.min(cap >>> 0, bytes.length);
        if (n > 0) {
            var mem = memory();
            new Uint8Array(mem.buffer, out >>> 0, n).set(bytes.subarray(0, n));
        }
        return n;
    }

    // ---------------------------------------------------------------------
    // 时间 / 日志 / 随机数 / 浏览器交互
    // ---------------------------------------------------------------------

    function host_now() {
        return performance.now() / 1000;
    }

    function host_log(ptr, len) {
        console.log(readUtf8(ptr >>> 0, len >>> 0));
    }

    function host_random(ptr, len) {
        var mem = memory();
        var view = new Uint8Array(mem.buffer, ptr >>> 0, len >>> 0);
        // getRandomValues 单次最多 65536 字节，分块填充。
        var chunkSize = 65536;
        for (var offset = 0; offset < view.length; offset += chunkSize) {
            var size = Math.min(chunkSize, view.length - offset);
            crypto.getRandomValues(view.subarray(offset, offset + size));
        }
    }

    function host_open_url(ptr, len) {
        window.open(readUtf8(ptr >>> 0, len >>> 0), "_blank");
    }

    // wasm 侧通知页面：是否显示「切换全屏」按钮（只在游戏大厅显示）。
    // 按钮是 index.html 里的 HTML 元素，这里只负责记状态并让页面刷新显隐。
    function host_set_fullscreen_btn(visible) {
        window.__phiraFullscreenBtn = visible !== 0;
        if (typeof window.__phiraSyncFullscreenBtn === "function") {
            window.__phiraSyncFullscreenBtn();
        }
    }

    // 异步输入框：用页面内的 HTML 覆盖层代替 window.prompt。
    // 注意：部分浏览器/环境不支持 window.prompt（会抛 "prompt() is not supported"），
    // 而且同步 prompt 会在 miniquad 事件回调里重入 wasm，导致 RefCell 重复借用 panic。
    var promptState = -1; // -1: 空闲/等待中, 0: 已取消, 1: 已完成
    var promptOverlay = null;

    function closePromptOverlay() {
        if (promptOverlay && promptOverlay.parentNode) {
            promptOverlay.parentNode.removeChild(promptOverlay);
        }
        promptOverlay = null;
        // 把焦点还给游戏 canvas，保证关闭输入框后键盘游玩恢复正常。
        var canvas = document.getElementById("glcanvas");
        if (canvas && canvas.focus) canvas.focus();
    }

    function finishPrompt(value) {
        closePromptOverlay();
        if (value === null) {
            lastPromptBytes = null;
            promptState = 0;
        } else {
            lastPromptBytes = utf8Bytes(value);
            promptState = 1;
        }
    }

    function showPromptOverlay(opts) {
        if (promptOverlay) return;

        var overlay = document.createElement("div");
        overlay.id = "phira-input-overlay";
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);" +
            "display:flex;align-items:center;justify-content:center;";

        var card = document.createElement("div");
        card.style.cssText =
            "min-width:320px;max-width:80vw;background:#2b3040;color:#fff;border-radius:10px;" +
            "padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5);" +
            "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;";

        var title = document.createElement("div");
        title.textContent = opts.title || "输入";
        title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:6px;";
        card.appendChild(title);

        if (opts.prompt) {
            var desc = document.createElement("div");
            desc.textContent = opts.prompt;
            desc.style.cssText = "font-size:13px;color:#aab;margin-bottom:12px;white-space:pre-wrap;";
            card.appendChild(desc);
        }

        var input = document.createElement("input");
        input.type = opts.password ? "password" : "text";
        input.value = opts.default || "";
        input.style.cssText =
            "width:100%;box-sizing:border-box;background:#1d2130;color:#fff;" +
            "border:1px solid #465;border-radius:6px;padding:10px 12px;font-size:15px;outline:none;";
        card.appendChild(input);

        var row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:16px;";

        var cancel = document.createElement("button");
        cancel.textContent = opts.cancelLabel || "取消";
        cancel.style.cssText =
            "padding:8px 18px;border:none;border-radius:6px;background:#3a4055;" +
            "color:#ddd;font-size:14px;cursor:pointer;";

        var ok = document.createElement("button");
        ok.textContent = opts.okLabel || "确定";
        ok.style.cssText =
            "padding:8px 18px;border:none;border-radius:6px;background:#5b8def;" +
            "color:#fff;font-size:14px;cursor:pointer;";

        row.appendChild(cancel);
        row.appendChild(ok);
        card.appendChild(row);
        overlay.appendChild(card);

        // 阻止覆盖层上的输入事件继续冒泡到 window（游戏监听器）。
        // 必须用冒泡阶段：捕获阶段拦截会让按钮自身的 click 也无法触发。
        var stop = function (e) {
            e.stopPropagation();
        };
        [
            "pointerdown",
            "pointerup",
            "mousedown",
            "mouseup",
            "click",
            "keydown",
            "keyup",
            "keypress",
            "wheel",
            "touchstart",
            "touchend",
        ].forEach(function (name) {
            overlay.addEventListener(name, stop, false);
        });

        cancel.onclick = function () {
            finishPrompt(null);
        };
        ok.onclick = function () {
            finishPrompt(input.value);
        };
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                e.preventDefault();
                finishPrompt(input.value);
            } else if (e.key === "Escape") {
                e.preventDefault();
                finishPrompt(null);
            }
        });
        overlay.addEventListener("mousedown", function (e) {
            if (e.target === overlay) finishPrompt(null);
        });

        document.body.appendChild(overlay);
        promptOverlay = overlay;
        setTimeout(function () {
            input.focus();
            input.select();
        }, 0);
    }

    function host_prompt_start(ptr, len) {
        var raw = readUtf8(ptr >>> 0, len >>> 0);
        var opts = {};
        try {
            opts = JSON.parse(raw) || {};
        } catch (e) {
            // 兼容旧版 Rust：直接传默认文本。
            opts = { default: raw };
        }
        lastPromptBytes = null;
        promptState = -1;
        closePromptOverlay();
        setTimeout(function () {
            showPromptOverlay(opts);
        }, 0);
        return 0;
    }

    function host_prompt_poll(out, cap) {
        if (promptState === -1) return -1;
        if (promptState === 0) {
            promptState = -1;
            return 0;
        }
        var n = writeBytes(out, cap, lastPromptBytes);
        promptState = -1;
        return n;
    }

    function host_prompt_result(out, cap) {
        if (!lastPromptBytes) return 0;
        return writeBytes(out, cap, lastPromptBytes);
    }

    // ---------------------------------------------------------------------
    // 文件选择（异步读取；Rust 侧通过 take_file_* 轮询取回结果）
    // ---------------------------------------------------------------------

    function host_pick_file(idPtr, idLen) {
        var id = readUtf8(idPtr >>> 0, idLen >>> 0);

        var input = document.createElement("input");
        input.type = "file";
        // 放到屏幕外，避免影响布局。
        input.style.position = "fixed";
        input.style.left = "-10000px";
        input.style.top = "0";
        input.style.width = "1px";
        input.style.height = "1px";
        input.style.opacity = "0";

        function cleanup() {
            if (input.parentNode) input.parentNode.removeChild(input);
        }

        input.onchange = function () {
            var file = input.files && input.files[0];
            if (!file) {
                cleanup();
                return;
            }
            file.arrayBuffer().then(function (buffer) {
                pendingFile = {
                    id: id,
                    name: file.name,
                    data: new Uint8Array(buffer),
                };
                cleanup();
            }).catch(function (err) {
                console.error("读取所选文件失败", err);
                cleanup();
            });
        };
        // Chrome 113+ 支持 cancel 事件（用户取消选择）。
        input.addEventListener("cancel", cleanup);

        document.body.appendChild(input);
        input.click();
        return 0;
    }

    function host_take_file_meta(out, cap) {
        if (!pendingFile) return 0;
        var text = pendingFile.id + "\n" + pendingFile.name + "\n" + pendingFile.data.length;
        var bytes = utf8Bytes(text);
        // 容量不足时返回所需大小（可用 out=0/cap=0 探测），由调用方扩容后重试。
        if ((cap >>> 0) < bytes.length) return bytes.length;
        writeBytes(out, cap, bytes);
        return bytes.length;
    }

    function host_take_file_data(out, cap) {
        if (!pendingFile) return -1;
        var data = pendingFile.data;
        // 容量不足时先不消费，返回所需大小。
        if ((cap >>> 0) < data.length) return data.length;
        writeBytes(out, cap, data);
        pendingFile = null;
        return data.length;
    }

    // ---------------------------------------------------------------------
    // 文件持久化：IndexedDB
    //
    // localStorage 只有约 5MB，下载的谱面（音频/图片）根本放不下，刷新后
    // 文件就丢了（表现为 no such file or directory: data/charts/download/...）。
    // wasm 侧是同步文件 API，所以这里在启动时把 IndexedDB 全部读进内存 Map，
    // 写入先更新内存、再异步落库；页面初始化会等待 __phiraStorageReady。
    // ---------------------------------------------------------------------

    function base64DecodedLength(text) {
        if (!text) return 0;
        var clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
        if (!clean) return 0;
        var pad = 0;
        if (clean.length >= 2 && clean.charCodeAt(clean.length - 2) === 61 /* = */) pad = 2;
        else if (clean.length >= 1 && clean.charCodeAt(clean.length - 1) === 61 /* = */) pad = 1;
        return Math.floor((clean.length * 3) / 4) - pad;
    }

    function bytesToBase64(bytes) {
        var out = "";
        var chunk = "";
        for (var i = 0; i < bytes.length; i += 3) {
            var b0 = bytes[i];
            var has1 = i + 1 < bytes.length;
            var has2 = i + 2 < bytes.length;
            var b1 = has1 ? bytes[i + 1] : 0;
            var b2 = has2 ? bytes[i + 2] : 0;

            chunk += B64_CHARS[b0 >> 2];
            chunk += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
            chunk += has1 ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
            chunk += has2 ? B64_CHARS[b2 & 63] : "=";

            // 分块拼接，避免一次生成超长字符串/数组导致栈或参数数量问题。
            if (chunk.length >= 16384) {
                out += chunk;
                chunk = "";
            }
        }
        return out + chunk;
    }

    function base64ToBytes(text) {
        var clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
        var out = new Uint8Array(base64DecodedLength(clean));
        var outIdx = 0;

        for (var i = 0; i < clean.length; i += 4) {
            var c0 = decodeBase64Char(clean.charCodeAt(i));
            var c1 = decodeBase64Char(clean.charCodeAt(i + 1));
            var c2 = decodeBase64Char(clean.charCodeAt(i + 2));
            var c3 = decodeBase64Char(clean.charCodeAt(i + 3));
            if (c0 < 0 || c1 < 0) break;

            out[outIdx++] = (c0 << 2) | (c1 >> 4);
            if (c2 >= 0 && outIdx < out.length) out[outIdx++] = ((c1 & 15) << 4) | (c2 >> 2);
            if (c3 >= 0 && outIdx < out.length) out[outIdx++] = ((c2 & 3) << 6) | c3;
        }

        return outIdx === out.length ? out : out.subarray(0, outIdx);
    }

    function decodeBase64Char(code) {
        if (code >= 0 && code < 128) return B64_LOOKUP[code];
        return -1;
    }

    var storageMap = new Map(); // path -> Uint8Array
    var storageDb = null;
    var storagePending = new Map(); // path -> Uint8Array | null(删除)
    var storageFlushTimer = null;

    function openStorageDb() {
        return new Promise(function (resolve) {
            try {
                if (!window.indexedDB) {
                    resolve(null);
                    return;
                }
                var req = window.indexedDB.open("phira-fs", 1);
                req.onupgradeneeded = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains("files")) {
                        db.createObjectStore("files");
                    }
                };
                req.onsuccess = function () {
                    resolve(req.result);
                };
                req.onerror = function () {
                    resolve(null);
                };
                req.onblocked = function () {
                    resolve(null);
                };
            } catch (e) {
                resolve(null);
            }
        });
    }

    // 把旧版 localStorage 中的数据迁移进内存（和 IndexedDB）。
    function loadLegacyLocalStorage() {
        var paths = [];
        try {
            for (var i = 0; i < window.localStorage.length; i++) {
                var key = window.localStorage.key(i);
                if (key !== null && key.indexOf(STORAGE_PREFIX) === 0) {
                    paths.push(key.slice(STORAGE_PREFIX.length));
                }
            }
        } catch (e) {
            return;
        }
        paths.forEach(function (path) {
            try {
                var value = window.localStorage.getItem(STORAGE_PREFIX + path);
                if (value === null) return;
                if (storageMap.has(path)) return; // IndexedDB 中的数据优先
                var data = base64ToBytes(value);
                storageMap.set(path, data);
                storagePending.set(path, data);
            } catch (e) {
                // 忽略损坏的旧数据
            }
        });
        if (storageDb) {
            // 数据已经迁移到 IndexedDB，释放 localStorage 配额。
            paths.forEach(function (path) {
                try {
                    window.localStorage.removeItem(STORAGE_PREFIX + path);
                } catch (e) {}
            });
        }
        scheduleStorageFlush();
    }

    function scheduleStorageFlush() {
        if (storageFlushTimer !== null) return;
        storageFlushTimer = setTimeout(function () {
            storageFlushTimer = null;
            var batch = storagePending;
            storagePending = new Map();
            if (batch.size === 0) return;

            if (storageDb) {
                try {
                    var tx = storageDb.transaction("files", "readwrite");
                    var store = tx.objectStore("files");
                    batch.forEach(function (value, path) {
                        if (value === null) store.delete(path);
                        else store.put(value, path);
                    });
                } catch (e) {
                    console.warn("IndexedDB 写入失败", e);
                }
                return;
            }

            // 没有 IndexedDB 时退回 localStorage（容量有限）。
            batch.forEach(function (value, path) {
                try {
                    if (value === null) window.localStorage.removeItem(STORAGE_PREFIX + path);
                    else window.localStorage.setItem(STORAGE_PREFIX + path, bytesToBase64(value));
                } catch (e) {}
            });
        }, 0);
    }

    var storageReady = openStorageDb().then(function (db) {
        storageDb = db;
        if (!db) {
            loadLegacyLocalStorage();
            return;
        }
        return new Promise(function (resolve) {
            var req;
            try {
                var tx = db.transaction("files", "readonly");
                req = tx.objectStore("files").openCursor();
            } catch (e) {
                loadLegacyLocalStorage();
                resolve();
                return;
            }
            req.onsuccess = function () {
                var cursor = req.result;
                if (cursor) {
                    var value = cursor.value;
                    if (value) {
                        storageMap.set(
                            String(cursor.key),
                            value instanceof Uint8Array ? value : new Uint8Array(value)
                        );
                    }
                    cursor.continue();
                } else {
                    loadLegacyLocalStorage();
                    resolve();
                }
            };
            req.onerror = function () {
                loadLegacyLocalStorage();
                resolve();
            };
        });
    });
    window.__phiraStorageReady = storageReady;

    function host_storage_size(ptr, len) {
        var path = readUtf8(ptr >>> 0, len >>> 0);
        var data = storageMap.get(path);
        return data ? data.length : -1;
    }

    function host_storage_read(ptr, len, out, cap) {
        var path = readUtf8(ptr >>> 0, len >>> 0);
        var data = storageMap.get(path);
        if (!data) return -1;
        if (data.length > (cap >>> 0)) return -2;
        writeBytes(out, cap, data);
        return data.length;
    }

    function host_storage_write(ptr, len, dataPtr, dataLen) {
        var path = readUtf8(ptr >>> 0, len >>> 0);
        var mem = memory();
        // 复制一份：wasm 内存增长后原视图会失效。
        var data = new Uint8Array(new Uint8Array(mem.buffer, dataPtr >>> 0, dataLen >>> 0));
        storageMap.set(path, data);
        storagePending.set(path, data);
        scheduleStorageFlush();
        return 0;
    }

    function host_storage_remove(ptr, len) {
        var path = readUtf8(ptr >>> 0, len >>> 0);
        storageMap.delete(path);
        storagePending.set(path, null);
        scheduleStorageFlush();
        return 0;
    }

    function host_storage_keys(out, cap) {
        var keys = [];
        storageMap.forEach(function (_value, path) {
            keys.push(path);
        });

        var bytes = utf8Bytes(keys.join("\n"));
        // 容量不足时返回所需大小（out=0/cap=0 可用于探测）。
        if ((cap >>> 0) < bytes.length) return bytes.length;
        writeBytes(out, cap, bytes);
        return bytes.length;
    }

    function on_game_start() {
        // 进入游戏场景时确保 canvas 获得焦点（键盘游玩依赖 canvas 上的 keydown）。
        var canvas = document.getElementById("glcanvas");
        if (canvas && canvas.focus) canvas.focus();
    }

    // 兜底：把页面级键盘事件转发给游戏 canvas。
    // miniquad 只监听 canvas 自身的 keydown/keyup，一旦焦点跑到 body
    // （例如刚关掉输入框、或点到页面空白处），键盘游玩就会完全失效。
    (function installKeyboardForwarding() {
        function isTypingTarget(el) {
            if (!el) return false;
            var tag = (el.tagName || "").toUpperCase();
            return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
        }

        function forward(name, handlerName) {
            document.addEventListener(
                name,
                function (e) {
                    if (document.getElementById("phira-input-overlay")) return;
                    var canvas = document.getElementById("glcanvas");
                    if (!canvas || typeof canvas[handlerName] !== "function") return;
                    // 已经是 canvas 在处理，交给它，避免重复触发。
                    if (e.target === canvas || document.activeElement === canvas) return;
                    if (isTypingTarget(e.target)) return;
                    window.__forwardKey = e.code;
                    canvas[handlerName](e);
                },
                true
            );
        }

        forward("keydown", "onkeydown");
        forward("keyup", "onkeyup");
        forward("keypress", "onkeypress");

        // 点击游戏画面时确保 canvas 重新获得焦点。
        document.addEventListener(
            "pointerdown",
            function (e) {
                if (e.target && e.target.id === "glcanvas") {
                    var canvas = document.getElementById("glcanvas");
                    if (canvas && canvas.focus) canvas.focus();
                }
            },
            true
        );
    })();

    var hostFunctions = {
        host_now: host_now,
        host_log: host_log,
        host_random: host_random,
        host_open_url: host_open_url,
        host_set_fullscreen_btn: host_set_fullscreen_btn,
        host_prompt: host_prompt_result,
        host_prompt_start: host_prompt_start,
        host_prompt_poll: host_prompt_poll,
        host_prompt_result: host_prompt_result,
        host_pick_file: host_pick_file,
        host_take_file_meta: host_take_file_meta,
        host_take_file_data: host_take_file_data,
        host_storage_size: host_storage_size,
        host_storage_read: host_storage_read,
        host_storage_write: host_storage_write,
        host_storage_remove: host_storage_remove,
        host_storage_keys: host_storage_keys,
        on_game_start: on_game_start,
    };

    // gl.js 用 `var importObject` 声明，普通 script 中即为全局对象。
    var miniquadEnv = (typeof importObject !== "undefined" && importObject && importObject.env)
        ? importObject.env
        : (window.__miniquad_env || {});

    Object.assign(miniquadEnv, hostFunctions);
    window.__miniquad_env = miniquadEnv;
})();
