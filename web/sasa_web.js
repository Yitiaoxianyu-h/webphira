// sasa 的 WebAudio 后端（普通 script，必须在 gl.js / host.js 之后加载）。
//
// Rust 侧（vendored sasa）通过 extern "C" 导入这些函数，导出
// `sasa_web_render(frames) -> *const f32`（交错立体声）供这里调用。
//
// Safari/iOS 上音频会「莫名没声音」，根因有三类，本文件全部覆盖：
//  1. AudioContext 被系统挂起（suspended）或中断（interrupted，iOS 特有状态），
//     需要在用户手势/页面回到前台时主动 resume；
//  2. `ScriptProcessorNode.connect()` 之后浏览器可能立刻同步回调 onaudioprocess，
//     如果此刻 wasm 正在执行（游玩时创建 AudioManager 就在 frame 内），
//     就会重入 miniquad 的 RefCell 导致 panic。所以连接后先静音一帧再放行；
//  3. iOS Safari 偶发停止回调（节点「假死」），需要检测并重建节点。

(function () {
    "use strict";

    var audioContext = null;
    var scriptNode = null;
    var actualSampleRate = 0;
    var actualBufferSize = 0;

    // 只有在当前 wasm 调用栈退出之后才允许真正渲染（见文件头第 2 点）。
    var renderArmed = false;
    var armTimer = 0;

    // 上一次 onaudioprocess 的时间戳，用于检测节点假死。
    var lastRenderAt = 0;
    var watchdogTimer = 0;

    function getExports() {
        if (typeof wasm_exports !== "undefined" && wasm_exports) return wasm_exports;
        return window.wasm_exports || null;
    }

    function getMemory() {
        if (typeof wasm_memory !== "undefined" && wasm_memory) return wasm_memory;
        return window.wasm_memory || null;
    }

    function zeroOutput(output) {
        for (var channel = 0; channel < output.numberOfChannels; channel++) {
            output.getChannelData(channel).fill(0);
        }
    }

    // 把「真正开始渲染」推迟到当前宏任务之后：connect()/resume() 期间任何
    // 同步回调都只输出静音，绝不会在 wasm 调用栈里重入 wasm。
    function armRender() {
        renderArmed = false;
        if (armTimer) clearTimeout(armTimer);
        armTimer = setTimeout(function () {
            armTimer = 0;
            renderArmed = true;
            lastRenderAt = performance.now();
        }, 0);
    }

    function onAudioProcess(event) {
        var output = event.outputBuffer;

        // 连接/恢复的瞬间浏览器可能同步拉一次缓冲：输出静音，避免重入 wasm。
        if (!renderArmed) {
            zeroOutput(output);
            return;
        }

        var frames = output.length;

        try {
            var exportsObj = getExports();
            var mem = getMemory();
            if (!exportsObj || typeof exportsObj.sasa_web_render !== "function" || !mem) {
                zeroOutput(output);
                return;
            }

            var ptr = exportsObj.sasa_web_render(frames);
            // wasm 内存可能在渲染过程中增长，必须重新取一次 memory。
            mem = getMemory();
            if (!ptr || !mem) {
                zeroOutput(output);
                return;
            }

            // Rust 返回的是 f32 缓冲区，frames 帧 × 2 声道，交错存放。
            var interleaved = new Float32Array(mem.buffer, ptr, frames * 2);
            var left = output.getChannelData(0);
            var right = output.numberOfChannels > 1 ? output.getChannelData(1) : null;

            for (var i = 0; i < frames; i++) {
                left[i] = interleaved[i * 2];
                if (right) right[i] = interleaved[i * 2 + 1];
            }
            lastRenderAt = performance.now();
        } catch (e) {
            // 单次失败不能让整个音频链路静音。
            zeroOutput(output);
            if (!onAudioProcess.warned) {
                onAudioProcess.warned = true;
                console.warn("audio render failed", e);
            }
        }
    }

    // AudioContext 处于 suspended / interrupted 时都尝试恢复。
    // iOS 的 "interrupted"（来电、控制中心、切后台）不属于 suspended，
    // 只判断 suspended 会一直没声音。
    function ensureRunning() {
        if (!audioContext) return;
        if (audioContext.state === "running") return;
        try {
            var promise = audioContext.resume();
            if (promise && promise.catch) {
                promise.catch(function () {});
            }
        } catch (e) {}
    }

    function sasa_web_resume() {
        if (!audioContext) return;
        // 已经在运行就不要反复 arm（每次触摸都静音一帧会造成爆音/断续）。
        if (audioContext.state === "running") return;
        ensureRunning();
    }

    // iOS Safari 偶发停止回调：context 仍是 running，但 onaudioprocess 不再触发。
    // 检测到超过 1.5 秒没有任何渲染就重建 ScriptProcessorNode。
    function recreateNode(reason) {
        if (!audioContext) return;
        try {
            if (scriptNode) {
                scriptNode.onaudioprocess = null;
                try { scriptNode.disconnect(); } catch (e) {}
            }
            var size = actualBufferSize || 2048;
            var node = audioContext.createScriptProcessor(size, 0, 2);
            node.onaudioprocess = onAudioProcess;
            renderArmed = false;
            node.connect(audioContext.destination);
            scriptNode = node;
            actualBufferSize = node.bufferSize || size;
            lastRenderAt = 0;
            armRender();
            console.warn("[phira] 音频节点已重建：" + reason);
        } catch (e) {
            console.warn("[phira] 音频节点重建失败", e);
        }
    }

    function watchdog() {
        if (!audioContext) return;
        if (audioContext.state !== "running") {
            ensureRunning();
            return;
        }
        if (!renderArmed) return; // 刚连接，等待放行
        if (lastRenderAt && performance.now() - lastRenderAt > 1500) {
            recreateNode("audioprocess 停止");
        }
    }

    function startWatchdog() {
        if (watchdogTimer) return;
        watchdogTimer = setInterval(watchdog, 1000);
    }

    function sasa_web_start(preferredSampleRate, bufferSize) {
        if (scriptNode && audioContext) {
            ensureRunning();
            return actualSampleRate;
        }
        try {
            var Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) {
                console.error("当前浏览器不支持 WebAudio");
                return 0;
            }

            var ctx;
            try {
                ctx = preferredSampleRate
                    ? new Ctor({ sampleRate: preferredSampleRate })
                    : new Ctor();
            } catch (e) {
                // 浏览器不支持指定采样率时回退到默认值。
                ctx = new Ctor();
            }

            var size = bufferSize >>> 0;
            if (!size) size = 2048;

            // Safari 对 (size, 0, 2) 之外的组合更宽容，逐级回退。
            var configs = [
                [size, 0, 2],
                [size, 1, 2],
                [2048, 0, 2]
            ];
            var node = null;
            var lastErr = null;
            for (var i = 0; i < configs.length && !node; i++) {
                try {
                    node = ctx.createScriptProcessor(configs[i][0], configs[i][1], configs[i][2]);
                } catch (e) {
                    lastErr = e;
                }
            }
            if (!node) {
                console.error("创建 ScriptProcessorNode 失败", lastErr);
                if (ctx.close) ctx.close();
                return 0;
            }

            node.onaudioprocess = onAudioProcess;
            renderArmed = false;
            node.connect(ctx.destination);

            audioContext = ctx;
            scriptNode = node;
            actualSampleRate = ctx.sampleRate;
            actualBufferSize = node.bufferSize || size;
            lastRenderAt = 0;

            // 一些浏览器需要在 running 之后才会回调，先尝试恢复一次。
            ensureRunning();
            armRender();

            // 浏览器可能在标签页切换/设备变化后挂起音频上下文，导致"声音突然消失"。
            ctx.addEventListener("statechange", function () {
                if (ctx.state !== "running") {
                    setTimeout(ensureRunning, 0);
                } else {
                    armRender();
                }
            });

            startWatchdog();

            return actualSampleRate;
        } catch (e) {
            console.error("sasa_web_start 失败", e);
            return 0;
        }
    }

    function sasa_web_buffer_size() {
        if (!scriptNode) return 0;
        return scriptNode.bufferSize || actualBufferSize;
    }

    function sasa_web_latency() {
        if (!scriptNode || !actualSampleRate) return 0;
        return (actualBufferSize / actualSampleRate) * 2;
    }

    // 浏览器的自动播放策略要求用户手势后才能恢复音频。
    // 除了首次唤醒，也用于 iOS 在切后台/来电后回到前台时恢复。
    var resumeEvents = ["pointerdown", "touchstart", "touchend", "mousedown", "keydown", "click"];
    for (var i = 0; i < resumeEvents.length; i++) {
        document.addEventListener(resumeEvents[i], sasa_web_resume, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) setTimeout(sasa_web_resume, 100);
    });
    window.addEventListener("focus", sasa_web_resume);
    window.addEventListener("pageshow", function () {
        setTimeout(sasa_web_resume, 100);
    });
    document.addEventListener("fullscreenchange", function () {
        setTimeout(sasa_web_resume, 100);
    });

    var sasaFunctions = {
        sasa_web_start: sasa_web_start,
        sasa_web_resume: sasa_web_resume,
        sasa_web_buffer_size: sasa_web_buffer_size,
        sasa_web_latency: sasa_web_latency,
    };

    var miniquadEnv = (typeof importObject !== "undefined" && importObject && importObject.env)
        ? importObject.env
        : (window.__miniquad_env || {});

    Object.assign(miniquadEnv, sasaFunctions);
    window.__miniquad_env = miniquadEnv;
})();
