// load wasm module and link with gl functions
//
// this file was made by tons of hacks from emscripten's parseTools and library_webgl
// https://github.com/emscripten-core/emscripten/blob/master/src/parseTools.js
// https://github.com/emscripten-core/emscripten/blob/master/src/library_webgl.js
//
// TODO: split to gl.js and loader.js

"use strict";

const version = "0.3.12";

const canvas = document.querySelector("#glcanvas");
// 默认沿用 WebGL1（miniquad 0.3.x 的 glue 是按 WebGL1 写的，实测最稳），
// 只有显式带 ?gl2=1 时才尝试 WebGL2。
// 注意：prpr 的 MSRenderTarget（谱面离屏渲染 + 特效）会调用
// glRenderbufferStorageMultisample / glBlitFramebuffer，这两个是 WebGL2 独占 API。
// WebGL1 下它们不存在，会被下面的 fake-import 兜底成空函数（静默 no-op），
// 结果就是谱面画进一个不存在的缓冲、blit 不生效 → 谱面纯黑 + UI/打击特效永久堆叠不消失。
// 所以下面在 env 里补齐了这些函数，并为 WebGL1 写了降级实现。
const gl = (/[?&]gl2=1/.test(location.search) ? canvas.getContext("webgl2") : null) || canvas.getContext("webgl");
const isWebGL2 = !!(typeof WebGL2RenderingContext !== "undefined" && gl && gl instanceof WebGL2RenderingContext);
if (gl === null) {
    alert("Unable to initialize WebGL. Your browser or machine may not support it.");
}

var clipboard = null;

// 真正把文本写入系统剪贴板（miniquad 的 wasm 实现只存了变量，没有写入）。
// 注意：execCommand("copy") 会**同步**派发 copy 事件，如果当前正处于 wasm 的
// 调用栈里（sapp_set_clipboard 是 wasm 调进来的），事件处理器再回调 wasm 就会
// 触发 miniquad 的 RefCell 重入 panic。所以在 wasm 栈内只用异步 Clipboard API，
// 失败或不可用时推迟到当前宏任务之后再走 execCommand。
function writeClipboard(text) {
    if (window.__phiraInWasm) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                var p = navigator.clipboard.writeText(text);
                if (p && p.catch) p.catch(function () {});
                return;
            }
        } catch (e) {}
        setTimeout(function () { fallbackClipboard(text); }, 0);
        return;
    }
    if (fallbackClipboard(text)) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {});
        }
    } catch (e) {}
}

function fallbackClipboard(text) {
    var ta = null;
    try {
        ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-10000px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        var canvasEl = document.getElementById("glcanvas");
        if (canvasEl && canvasEl.focus) canvasEl.focus();
        return ok;
    } catch (e) {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
        return false;
    }
}

var plugins = [];
var wasm_memory;

var high_dpi = false;

canvas.focus();
// 触屏上禁用浏览器默认手势，否则 touchmove 会被页面滚动/缩放吞掉
canvas.style.touchAction = "none";
canvas.style.msTouchAction = "none";

canvas.requestPointerLock = canvas.requestPointerLock ||
    canvas.mozRequestPointerLock ||
    // pointer lock in any form is not supported on iOS safari 
    // https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API#browser_compatibility
    (function () {});
document.exitPointerLock = document.exitPointerLock ||
    document.mozExitPointerLock ||
    // pointer lock in any form is not supported on iOS safari
    (function () {});

function assert(flag, message) {
    if (flag == false) {
        alert(message)
    }
}

function acquireVertexArrayObjectExtension(ctx) {
    // WebGL2 中 VAO 是核心特性，直接使用原生方法
    if (typeof ctx.createVertexArray === "function" &&
        typeof ctx.bindVertexArray === "function" &&
        typeof ctx.deleteVertexArray === "function") {
        return;
    }
    // Extension available in WebGL 1 from Firefox 25 and WebKit 536.28/desktop Safari 6.0.3 onwards. Core feature in WebGL 2.
    var ext = ctx.getExtension('OES_vertex_array_object');
    if (ext) {
        ctx['createVertexArray'] = function () { return ext['createVertexArrayOES'](); };
        ctx['deleteVertexArray'] = function (vao) { ext['deleteVertexArrayOES'](vao); };
        ctx['bindVertexArray'] = function (vao) { ext['bindVertexArrayOES'](vao); };
        ctx['isVertexArray'] = function (vao) { return ext['isVertexArrayOES'](vao); };
    }
    else {
        alert("Unable to get OES_vertex_array_object extension");
    }
}


function acquireInstancedArraysExtension(ctx) {
    // WebGL2 中实例化绘制是核心特性
    if (typeof ctx.drawArraysInstanced === "function" &&
        typeof ctx.drawElementsInstanced === "function" &&
        typeof ctx.vertexAttribDivisor === "function") {
        return;
    }
    // Extension available in WebGL 1 from Firefox 26 and Google Chrome 30 onwards. Core feature in WebGL 2.
    var ext = ctx.getExtension('ANGLE_instanced_arrays');
    if (ext) {
        ctx['vertexAttribDivisor'] = function (index, divisor) { ext['vertexAttribDivisorANGLE'](index, divisor); };
        ctx['drawArraysInstanced'] = function (mode, first, count, primcount) { ext['drawArraysInstancedANGLE'](mode, first, count, primcount); };
        ctx['drawElementsInstanced'] = function (mode, count, type, indices, primcount) { ext['drawElementsInstancedANGLE'](mode, count, type, indices, primcount); };
    }
}

function acquireDisjointTimerQueryExtension(ctx) {
    // WebGL2 下扩展名不同（EXT_disjoint_timer_query_webgl2），函数名沿用 EXT 版本前缀
    var ext = isWebGL2 ? ctx.getExtension('EXT_disjoint_timer_query_webgl2') : ctx.getExtension('EXT_disjoint_timer_query');
    if (ext) {
        ctx['createQuery'] = function () { return ext['createQueryEXT'](); };
        ctx['beginQuery'] = function (target, query) { return ext['beginQueryEXT'](target, query); };
        ctx['endQuery'] = function (target) { return ext['endQueryEXT'](target); };
        ctx['deleteQuery'] = function (query) { ext['deleteQueryEXT'](query); };
        ctx['getQueryObject'] = function (query, pname) { return ext['getQueryObjectEXT'](query, pname); };
    }
}

acquireVertexArrayObjectExtension(gl);
acquireInstancedArraysExtension(gl);
acquireDisjointTimerQueryExtension(gl);

// https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_depth_texture
// 注意：depth texture 在 WebGL2 里是核心能力，getExtension 一定返回 null，不能再据此弹窗。
if (!isWebGL2 && gl.getExtension('WEBGL_depth_texture') == null) {
    alert("Cant initialize WEBGL_depth_texture extension");
}

function getArray(ptr, arr, n) {
    return new arr(wasm_memory.buffer, ptr, n);
}

function UTF8ToString(ptr, maxBytesToRead) {
    let u8Array = new Uint8Array(wasm_memory.buffer, ptr);

    var idx = 0;
    var endIdx = idx + maxBytesToRead;

    var str = '';
    while (!(idx >= endIdx)) {
        // For UTF8 byte structure, see:
        // http://en.wikipedia.org/wiki/UTF-8#Description
        // https://www.ietf.org/rfc/rfc2279.txt
        // https://tools.ietf.org/html/rfc3629
        var u0 = u8Array[idx++];

        // If not building with TextDecoder enabled, we don't know the string length, so scan for \0 byte.
        // If building with TextDecoder, we know exactly at what byte index the string ends, so checking for nulls here would be redundant.
        if (!u0) return str;

        if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
        var u1 = u8Array[idx++] & 63;
        if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
        var u2 = u8Array[idx++] & 63;
        if ((u0 & 0xF0) == 0xE0) {
            u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {

            if ((u0 & 0xF8) != 0xF0) console.warn('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string on the asm.js/wasm heap to a JS string!');

            u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (u8Array[idx++] & 63);
        }

        if (u0 < 0x10000) {
            str += String.fromCharCode(u0);
        } else {
            var ch = u0 - 0x10000;
            str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        }
    }

    return str;
}

function stringToUTF8(str, heap, outIdx, maxBytesToWrite) {
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite;
    for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
        var u = str.charCodeAt(i); // possibly a lead surrogate
        if (u >= 0xD800 && u <= 0xDFFF) {
            var u1 = str.charCodeAt(++i);
            u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
        }
        if (u <= 0x7F) {
            if (outIdx >= endIdx) break;
            heap[outIdx++] = u;
        } else if (u <= 0x7FF) {
            if (outIdx + 1 >= endIdx) break;
            heap[outIdx++] = 0xC0 | (u >> 6);
            heap[outIdx++] = 0x80 | (u & 63);
        } else if (u <= 0xFFFF) {
            if (outIdx + 2 >= endIdx) break;
            heap[outIdx++] = 0xE0 | (u >> 12);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        } else {
            if (outIdx + 3 >= endIdx) break;

            if (u >= 0x200000) console.warn('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to an UTF-8 string on the asm.js/wasm heap! (Valid unicode code points should be in range 0-0x1FFFFF).');

            heap[outIdx++] = 0xF0 | (u >> 18);
            heap[outIdx++] = 0x80 | ((u >> 12) & 63);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        }
    }
    return outIdx - startIdx;
}
var FS = {
    loaded_files: [],
    unique_id: 0
};

var GL = {
    counter: 1,
    buffers: [],
    mappedBuffers: {},
    programs: [],
    framebuffers: [],
    renderbuffers: [],
    textures: [],
    uniforms: [],
    shaders: [],
    vaos: [],
    timerQueries: [],
    contexts: {},
    programInfos: {},
    // WebGL1 兜底 blit 需要知道「某个 FBO 的 color attachment 是哪张纹理」
    fboTextures: {},
    boundFramebuffer: 0,
    boundTexture: null,

    recordError: function (code) {
        GL.lastError = code;
    },

    getNewId: function (table) {
        var ret = GL.counter++;
        for (var i = table.length; i < ret; i++) {
            table[i] = null;
        }
        return ret;
    },

    validateGLObjectID: function (objectHandleArray, objectID, callerFunctionName, objectReadableType) {
        if (objectID != 0) {
            if (objectHandleArray[objectID] === null) {
                console.error(callerFunctionName + ' called with an already deleted ' + objectReadableType + ' ID ' + objectID + '!');
            } else if (!objectHandleArray[objectID]) {
                console.error(callerFunctionName + ' called with an invalid ' + objectReadableType + ' ID ' + objectID + '!');
            }
        }
    },
    getSource: function (shader, count, string, length) {
        var source = '';
        for (var i = 0; i < count; ++i) {
            var len = length == 0 ? undefined : getArray(length + i * 4, Uint32Array, 1)[0];
            source += UTF8ToString(getArray(string + i * 4, Uint32Array, 1)[0], len);
        }
        return source;
    },
    populateUniformTable: function (program) {
        GL.validateGLObjectID(GL.programs, program, 'populateUniformTable', 'program');
        var p = GL.programs[program];
        var ptable = GL.programInfos[program] = {
            uniforms: {},
            maxUniformLength: 0, // This is eagerly computed below, since we already enumerate all uniforms anyway.
            maxAttributeLength: -1, // This is lazily computed and cached, computed when/if first asked, "-1" meaning not computed yet.
            maxUniformBlockNameLength: -1 // Lazily computed as well
        };

        var utable = ptable.uniforms;
        // A program's uniform table maps the string name of an uniform to an integer location of that uniform.
        // The global GL.uniforms map maps integer locations to WebGLUniformLocations.
        var numUniforms = gl.getProgramParameter(p, 0x8B86/*GL_ACTIVE_UNIFORMS*/);
        for (var i = 0; i < numUniforms; ++i) {
            var u = gl.getActiveUniform(p, i);

            var name = u.name;
            ptable.maxUniformLength = Math.max(ptable.maxUniformLength, name.length + 1);

            // If we are dealing with an array, e.g. vec4 foo[3], strip off the array index part to canonicalize that "foo", "foo[]",
            // and "foo[0]" will mean the same. Loop below will populate foo[1] and foo[2].
            if (name.slice(-1) == ']') {
                name = name.slice(0, name.lastIndexOf('['));
            }

            // Optimize memory usage slightly: If we have an array of uniforms, e.g. 'vec3 colors[3];', then
            // only store the string 'colors' in utable, and 'colors[0]', 'colors[1]' and 'colors[2]' will be parsed as 'colors'+i.
            // Note that for the GL.uniforms table, we still need to fetch the all WebGLUniformLocations for all the indices.
            var loc = gl.getUniformLocation(p, name);
            if (loc) {
                var id = GL.getNewId(GL.uniforms);
                utable[name] = [u.size, id];
                GL.uniforms[id] = loc;

                for (var j = 1; j < u.size; ++j) {
                    var n = name + '[' + j + ']';
                    loc = gl.getUniformLocation(p, n);
                    id = GL.getNewId(GL.uniforms);

                    GL.uniforms[id] = loc;
                }
            }
        }
    }
}

function _glGenObject(n, buffers, createFunction, objectTable, functionName) {
    for (var i = 0; i < n; i++) {
        var buffer = gl[createFunction]();
        var id = buffer && GL.getNewId(objectTable);
        if (buffer) {
            buffer.name = id;
            objectTable[id] = buffer;
        } else {
            console.error("GL_INVALID_OPERATION");
            GL.recordError(0x0502 /* GL_INVALID_OPERATION */);

            alert('GL_INVALID_OPERATION in ' + functionName + ': GLctx.' + createFunction + ' returned null - most likely GL context is lost!');
        }
        getArray(buffers + i * 4, Int32Array, 1)[0] = id;
    }
}

function _webglGet(name_, p, type) {
    // Guard against user passing a null pointer.
    // Note that GLES2 spec does not say anything about how passing a null pointer should be treated.
    // Testing on desktop core GL 3, the application crashes on glGetIntegerv to a null pointer, but
    // better to report an error instead of doing anything random.
    if (!p) {
        console.error('GL_INVALID_VALUE in glGet' + type + 'v(name=' + name_ + ': Function called with null out pointer!');
        GL.recordError(0x501 /* GL_INVALID_VALUE */);
        return;
    }
    var ret = undefined;
    switch (name_) { // Handle a few trivial GLES values
        case 0x8DFA: // GL_SHADER_COMPILER
            ret = 1;
            break;
        case 0x8DF8: // GL_SHADER_BINARY_FORMATS
            if (type != 'EM_FUNC_SIG_PARAM_I' && type != 'EM_FUNC_SIG_PARAM_I64') {
                GL.recordError(0x500); // GL_INVALID_ENUM

                err('GL_INVALID_ENUM in glGet' + type + 'v(GL_SHADER_BINARY_FORMATS): Invalid parameter type!');
            }
            return; // Do not write anything to the out pointer, since no binary formats are supported.
        case 0x87FE: // GL_NUM_PROGRAM_BINARY_FORMATS
        case 0x8DF9: // GL_NUM_SHADER_BINARY_FORMATS
            ret = 0;
            break;
        case 0x86A2: // GL_NUM_COMPRESSED_TEXTURE_FORMATS
            // WebGL doesn't have GL_NUM_COMPRESSED_TEXTURE_FORMATS (it's obsolete since GL_COMPRESSED_TEXTURE_FORMATS returns a JS array that can be queried for length),
            // so implement it ourselves to allow C++ GLES2 code get the length.
            var formats = gl.getParameter(0x86A3 /*GL_COMPRESSED_TEXTURE_FORMATS*/);
            ret = formats ? formats.length : 0;
            break;
        case 0x821D: // GL_NUM_EXTENSIONS
            assert(false, "unimplemented");
            break;
        case 0x821B: // GL_MAJOR_VERSION
        case 0x821C: // GL_MINOR_VERSION
            assert(false, "unimplemented");
            break;
    }

    if (ret === undefined) {
        var result = gl.getParameter(name_);
        switch (typeof (result)) {
            case "number":
                ret = result;
                break;
            case "boolean":
                ret = result ? 1 : 0;
                break;
            case "string":
                GL.recordError(0x500); // GL_INVALID_ENUM
                console.error('GL_INVALID_ENUM in glGet' + type + 'v(' + name_ + ') on a name which returns a string!');
                return;
            case "object":
                if (result === null) {
                    // null is a valid result for some (e.g., which buffer is bound - perhaps nothing is bound), but otherwise
                    // can mean an invalid name_, which we need to report as an error
                    switch (name_) {
                        case 0x8894: // ARRAY_BUFFER_BINDING
                        case 0x8B8D: // CURRENT_PROGRAM
                        case 0x8895: // ELEMENT_ARRAY_BUFFER_BINDING
                        case 0x8CA6: // FRAMEBUFFER_BINDING
                        case 0x8CA7: // RENDERBUFFER_BINDING
                        case 0x8069: // TEXTURE_BINDING_2D
                        case 0x85B5: // WebGL 2 GL_VERTEX_ARRAY_BINDING, or WebGL 1 extension OES_vertex_array_object GL_VERTEX_ARRAY_BINDING_OES
                        case 0x8919: // GL_SAMPLER_BINDING
                        case 0x8E25: // GL_TRANSFORM_FEEDBACK_BINDING
                        case 0x8514: { // TEXTURE_BINDING_CUBE_MAP
                            ret = 0;
                            break;
                        }
                        default: {
                            GL.recordError(0x500); // GL_INVALID_ENUM
                            console.error('GL_INVALID_ENUM in glGet' + type + 'v(' + name_ + ') and it returns null!');
                            return;
                        }
                    }
                } else if (result instanceof Float32Array ||
                    result instanceof Uint32Array ||
                    result instanceof Int32Array ||
                    result instanceof Array) {
                    for (var i = 0; i < result.length; ++i) {
                        assert(false, "unimplemented")
                    }
                    return;
                } else {
                    try {
                        ret = result.name | 0;
                    } catch (e) {
                        GL.recordError(0x500); // GL_INVALID_ENUM
                        console.error('GL_INVALID_ENUM in glGet' + type + 'v: Unknown object returned from WebGL getParameter(' + name_ + ')! (error: ' + e + ')');
                        return;
                    }
                }
                break;
            default:
                GL.recordError(0x500); // GL_INVALID_ENUM
                console.error('GL_INVALID_ENUM in glGet' + type + 'v: Native code calling glGet' + type + 'v(' + name_ + ') and it returns ' + result + ' of type ' + typeof (result) + '!');
                return;
        }
    }

    switch (type) {
        case 'EM_FUNC_SIG_PARAM_I64': getArray(p, Int32Array, 1)[0] = ret;
        case 'EM_FUNC_SIG_PARAM_I': getArray(p, Int32Array, 1)[0] = ret; break;
        case 'EM_FUNC_SIG_PARAM_F': getArray(p, Float32Array, 1)[0] = ret; break;
        case 'EM_FUNC_SIG_PARAM_B': getArray(p, Int8Array, 1)[0] = ret ? 1 : 0; break;
        default: throw 'internal glGet error, bad type: ' + type;
    }
}

var Module;
var wasm_exports;

function resize(canvas, on_resize) {
    var dpr = dpi_scale();
    var displayWidth = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var displayHeight = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width != displayWidth ||
        canvas.height != displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        // 移动端（旋转屏幕 / 地址栏收起 / 进入全屏）浏览器合成的 canvas 尺寸
        // 经常比布局尺寸慢一拍，这里把通知也推迟到下一帧，避免 wasm 拿到旧尺寸。
        if (on_resize != undefined)
            setTimeout(function () { on_resize(displayWidth, displayHeight); }, 0);
    }
}

// 统一的尺寸同步入口：任何可能改变 canvas 显示尺寸的事件都走这里。
// 只依赖 window.onresize 在移动端会漏事件（orientationchange、全屏切换、
// 地址栏伸缩、visual viewport 变化都不会触发 window resize）。
function syncCanvasSize() {
    if (!wasm_exports || !wasm_exports.resize) {
        resize(canvas);
        return;
    }
    resize(canvas, wasm_exports.resize);
}

function installSizeWatchers() {
    if (window.__phiraSizeWatchersReady) return;
    window.__phiraSizeWatchersReady = true;

    window.addEventListener("resize", syncCanvasSize, { passive: true });
    window.addEventListener("orientationchange", function () {
        setTimeout(syncCanvasSize, 120);
        setTimeout(syncCanvasSize, 400);
    }, { passive: true });
    document.addEventListener("fullscreenchange", function () {
        setTimeout(syncCanvasSize, 60);
        setTimeout(syncCanvasSize, 300);
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", syncCanvasSize, { passive: true });
        window.visualViewport.addEventListener("scroll", syncCanvasSize, { passive: true });
    }
    if (window.ResizeObserver) {
        try {
            new ResizeObserver(syncCanvasSize).observe(canvas);
        } catch (e) {}
    }
}

function animation() {
    wasm_exports.frame();
    // 兜底：每 15 帧核对一次 canvas 尺寸，覆盖 ResizeObserver 也漏掉的情况
    // （例如浏览器缩放导致 devicePixelRatio 改变但 clientWidth 不变）。
    if ((window.__phiraFrameNo = (window.__phiraFrameNo || 0) + 1) % 15 === 0) {
        try { syncCanvasSize(); } catch (e) {}
    }
    window.requestAnimationFrame(animation);
}

const SAPP_EVENTTYPE_TOUCHES_BEGAN = 10;
const SAPP_EVENTTYPE_TOUCHES_MOVED = 11;
const SAPP_EVENTTYPE_TOUCHES_ENDED = 12;
const SAPP_EVENTTYPE_TOUCHES_CANCELLED = 13;

const SAPP_MODIFIER_SHIFT = 1;
const SAPP_MODIFIER_CTRL = 2;
const SAPP_MODIFIER_ALT = 4;
const SAPP_MODIFIER_SUPER = 8;

function into_sapp_mousebutton(btn) {
    switch (btn) {
        case 0: return 0;
        case 1: return 2;
        case 2: return 1;
        default: return btn;
    }
}

function into_sapp_keycode(key_code) {
    switch (key_code) {
        case "Space": return 32;
        case "Quote": return 222;
        case "Comma": return 44;
        case "Minus": return 45;
        case "Period": return 46;
        case "Slash": return 189;
        case "Digit0": return 48;
        case "Digit1": return 49;
        case "Digit2": return 50;
        case "Digit3": return 51;
        case "Digit4": return 52;
        case "Digit5": return 53;
        case "Digit6": return 54;
        case "Digit7": return 55;
        case "Digit8": return 56;
        case "Digit9": return 57;
        case "Semicolon": return 59;
        case "Equal": return 61;
        case "KeyA": return 65;
        case "KeyB": return 66;
        case "KeyC": return 67;
        case "KeyD": return 68;
        case "KeyE": return 69;
        case "KeyF": return 70;
        case "KeyG": return 71;
        case "KeyH": return 72;
        case "KeyI": return 73;
        case "KeyJ": return 74;
        case "KeyK": return 75;
        case "KeyL": return 76;
        case "KeyM": return 77;
        case "KeyN": return 78;
        case "KeyO": return 79;
        case "KeyP": return 80;
        case "KeyQ": return 81;
        case "KeyR": return 82;
        case "KeyS": return 83;
        case "KeyT": return 84;
        case "KeyU": return 85;
        case "KeyV": return 86;
        case "KeyW": return 87;
        case "KeyX": return 88;
        case "KeyY": return 89;
        case "KeyZ": return 90;
        case "BracketLeft": return 91;
        case "Backslash": return 92;
        case "BracketRight": return 93;
        case "Backquote": return 96;
        case "Escape": return 256;
        case "Enter": return 257;
        case "Tab": return 258;
        case "Backspace": return 259;
        case "Insert": return 260;
        case "Delete": return 261;
        case "ArrowRight": return 262;
        case "ArrowLeft": return 263;
        case "ArrowDown": return 264;
        case "ArrowUp": return 265;
        case "PageUp": return 266;
        case "PageDown": return 267;
        case "Home": return 268;
        case "End": return 269;
        case "CapsLock": return 280;
        case "ScrollLock": return 281;
        case "NumLock": return 282;
        case "PrintScreen": return 283;
        case "Pause": return 284;
        case "F1": return 290;
        case "F2": return 291;
        case "F3": return 292;
        case "F4": return 293;
        case "F5": return 294;
        case "F6": return 295;
        case "F7": return 296;
        case "F8": return 297;
        case "F9": return 298;
        case "F10": return 299;
        case "F11": return 300;
        case "F12": return 301;
        case "F13": return 302;
        case "F14": return 303;
        case "F15": return 304;
        case "F16": return 305;
        case "F17": return 306;
        case "F18": return 307;
        case "F19": return 308;
        case "F20": return 309;
        case "F21": return 310;
        case "F22": return 311;
        case "F23": return 312;
        case "F24": return 313;
        case "Numpad0": return 320;
        case "Numpad1": return 321;
        case "Numpad2": return 322;
        case "Numpad3": return 323;
        case "Numpad4": return 324;
        case "Numpad5": return 325;
        case "Numpad6": return 326;
        case "Numpad7": return 327;
        case "Numpad8": return 328;
        case "Numpad9": return 329;
        case "NumpadDecimal": return 330;
        case "NumpadDivide": return 331;
        case "NumpadMultiply": return 332;
        case "NumpadSubtract": return 333;
        case "NumpadAdd": return 334;
        case "NumpadEnter": return 335;
        case "NumpadEqual": return 336;
        case "ShiftLeft": return 340;
        case "ControlLeft": return 341;
        case "AltLeft": return 342;
        case "OSLeft": return 343;
        case "ShiftRight": return 344;
        case "ControlRight": return 345;
        case "AltRight": return 346;
        case "OSRight": return 347;
        case "ContextMenu": return 348;
    }

    console.log("Unsupported keyboard key: ", key_code)
}

function dpi_scale()  {
    if (high_dpi) {
        // 按设备真实像素密度渲染：任何分辨率 / 系统缩放比例的屏幕都输出满分辨率画面。
        // （之前限制到 1.5 是为了帧率，但会让 2x/3x 屏明显发糊，已移除。）
        return window.devicePixelRatio || 1.0;
    } else {
        return 1.0;
    }
}

function texture_size(internalFormat, width, height) {
    if (internalFormat == gl.ALPHA) {
        return width * height;
    }
    else if (internalFormat == gl.RGB) {
        return width * height * 3;
    } else if (internalFormat == gl.RGBA) {
        return width * height * 4;
    } else { // TextureFormat::RGB565 | TextureFormat::RGBA4 | TextureFormat::RGBA5551
        return width * height * 3;
    }
}

function mouse_relative_position(clientX, clientY) {
    var targetRect = canvas.getBoundingClientRect();

    // 必须用「canvas 实际像素 / CSS 像素」这个真实比例，而不是想当然的
    // dpi_scale()。当画布尺寸与布局尺寸不同步时（移动端旋转/全屏/地址栏
    // 伸缩），用 dpi_scale 会让点击位置整体偏移。
    var sx = targetRect.width > 0 ? canvas.width / targetRect.width : dpi_scale();
    var sy = targetRect.height > 0 ? canvas.height / targetRect.height : dpi_scale();

    var x = (clientX - targetRect.left) * sx;
    var y = (clientY - targetRect.top) * sy;

    return { x, y };
}

var emscripten_shaders_hack = false;

var importObject = {
    env: {
        console_debug: function (ptr) {
            console.debug(UTF8ToString(ptr));
        },
        console_log: function (ptr) {
            console.log(UTF8ToString(ptr));
        },
        console_info: function (ptr) {
            console.info(UTF8ToString(ptr));
        },
        console_warn: function (ptr) {
            console.warn(UTF8ToString(ptr));
        },
        console_error: function (ptr) {
            console.error(UTF8ToString(ptr));
        },
        set_emscripten_shader_hack: function (flag) {
            emscripten_shaders_hack = flag;
        },
        sapp_set_clipboard: function(ptr, len) {
            clipboard = UTF8ToString(ptr, len);
            writeClipboard(clipboard);
        },
        dpi_scale,
        rand: function () {
            return Math.floor(Math.random() * 2147483647);
        },
        now: function () {
            return Date.now() / 1000.0;
        },
        canvas_width: function () {
            return Math.floor(canvas.width);
        },
        canvas_height: function () {
            return Math.floor(canvas.height);
        },
        glClearDepthf: function (depth) {
            gl.clearDepth(depth);
        },
        glClearColor: function (r, g, b, a) {
            gl.clearColor(r, g, b, a);
        },
        glClearStencil: function (s) {
            gl.clearStencil(s);
        },
        glColorMask: function (red, green, blue, alpha) {
            gl.colorMask(red, green, blue, alpha);
        },
        glScissor: function (x, y, w, h) {
            gl.scissor(x, y, w, h);
        },
        glClear: function (mask) {
            gl.clear(mask);
        },
        glGenTextures: function (n, textures) {
            _glGenObject(n, textures, "createTexture", GL.textures, "glGenTextures")
        },
        glActiveTexture: function (texture) {
            gl.activeTexture(texture)
        },
        glBindTexture: function (target, texture) {
            GL.validateGLObjectID(GL.textures, texture, 'glBindTexture', 'texture');
            GL.boundTexture = texture ? GL.textures[texture] : null;
            gl.bindTexture(target, GL.textures[texture]);
        },
        glTexImage2D: function (target, level, internalFormat, width, height, border, format, type, pixels) {
            gl.texImage2D(target, level, internalFormat, width, height, border, format, type,
                pixels ? getArray(pixels, Uint8Array, texture_size(internalFormat, width, height)) : null);
        },
        glTexSubImage2D: function (target, level, xoffset, yoffset, width, height, format, type, pixels) {
            gl.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type,
                pixels ? getArray(pixels, Uint8Array, texture_size(format, width, height)) : null);
        },
        glReadPixels: function(x, y, width, height, format, type, pixels) {
            var pixelData = getArray(pixels, Uint8Array, texture_size(format, width, height));
            gl.readPixels(x, y, width, height, format, type, pixelData);
        },
        glTexParameteri: function (target, pname, param) {
            gl.texParameteri(target, pname, param);
        },
        glUniform1fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform1fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 1 * count);
            gl.uniform1fv(GL.uniforms[location], view);
        },
        glUniform2fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform2fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform2fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 2 * count);
            gl.uniform2fv(GL.uniforms[location], view);
        },
        glUniform3fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform3fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform3fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 3 * count);
            gl.uniform3fv(GL.uniforms[location], view);
        },
        glUniform4fv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform4fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniform4fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 4 * count);
            gl.uniform4fv(GL.uniforms[location], view);
        },
        glUniform1iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform1iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 1 * count);
            gl.uniform1iv(GL.uniforms[location], view);
        },
        glUniform2iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform2fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform2iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 2 * count);
            gl.uniform2iv(GL.uniforms[location], view);
        },
        glUniform3iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform3fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform3iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 3 * count);
            gl.uniform3iv(GL.uniforms[location], view);
        },
        glUniform4iv: function (location, count, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform4fv', 'location');
            assert((value & 3) == 0, 'Pointer to i32 data passed to glUniform4iv must be aligned to four bytes!');
            var view = getArray(value, Int32Array, 4 * count);
            gl.uniform4iv(GL.uniforms[location], view);
        },
        glBlendFunc: function (sfactor, dfactor) {
            gl.blendFunc(sfactor, dfactor);
        },
        glBlendEquationSeparate: function (modeRGB, modeAlpha) {
            gl.blendEquationSeparate(modeRGB, modeAlpha);
        },
        glDisable: function (cap) {
            gl.disable(cap);
        },
        glDrawElements: function (mode, count, type, indices) {
            gl.drawElements(mode, count, type, indices);
        },
        glGetIntegerv: function (name_, p) {
            _webglGet(name_, p, 'EM_FUNC_SIG_PARAM_I');
        },
        glUniform1f: function (location, v0) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1f', 'location');
            gl.uniform1f(GL.uniforms[location], v0);
        },
        glUniform1i: function (location, v0) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniform1i', 'location');
            gl.uniform1i(GL.uniforms[location], v0);
        },
        glGetAttribLocation: function (program, name) {
            return gl.getAttribLocation(GL.programs[program], UTF8ToString(name));
        },
        glEnableVertexAttribArray: function (index) {
            gl.enableVertexAttribArray(index);
        },
        glDisableVertexAttribArray: function (index) {
            gl.disableVertexAttribArray(index);
        },
        glVertexAttribPointer: function (index, size, type, normalized, stride, ptr) {
            gl.vertexAttribPointer(index, size, type, !!normalized, stride, ptr);
        },
        glGetUniformLocation: function (program, name) {
            GL.validateGLObjectID(GL.programs, program, 'glGetUniformLocation', 'program');
            name = UTF8ToString(name);
            var arrayIndex = 0;
            // If user passed an array accessor "[index]", parse the array index off the accessor.
            if (name[name.length - 1] == ']') {
                var leftBrace = name.lastIndexOf('[');
                arrayIndex = name[leftBrace + 1] != ']' ? parseInt(name.slice(leftBrace + 1)) : 0; // "index]", parseInt will ignore the ']' at the end; but treat "foo[]" as "foo[0]"
                name = name.slice(0, leftBrace);
            }

            var uniformInfo = GL.programInfos[program] && GL.programInfos[program].uniforms[name]; // returns pair [ dimension_of_uniform_array, uniform_location ]
            if (uniformInfo && arrayIndex >= 0 && arrayIndex < uniformInfo[0]) { // Check if user asked for an out-of-bounds element, i.e. for 'vec4 colors[3];' user could ask for 'colors[10]' which should return -1.
                return uniformInfo[1] + arrayIndex;
            } else {
                return -1;
            }
        },
        glUniformMatrix4fv: function (location, count, transpose, value) {
            GL.validateGLObjectID(GL.uniforms, location, 'glUniformMatrix4fv', 'location');
            assert((value & 3) == 0, 'Pointer to float data passed to glUniformMatrix4fv must be aligned to four bytes!');
            var view = getArray(value, Float32Array, 16);
            gl.uniformMatrix4fv(GL.uniforms[location], !!transpose, view);
        },
        glUseProgram: function (program) {
            GL.validateGLObjectID(GL.programs, program, 'glUseProgram', 'program');
            gl.useProgram(GL.programs[program]);
        },
        glGenVertexArrays: function (n, arrays) {
            _glGenObject(n, arrays, 'createVertexArray', GL.vaos, 'glGenVertexArrays');
        },
        glGenFramebuffers: function (n, ids) {
            _glGenObject(n, ids, 'createFramebuffer', GL.framebuffers, 'glGenFramebuffers');
        },
        glBindVertexArray: function (vao) {
            gl.bindVertexArray(GL.vaos[vao]);
        },
        glBindFramebuffer: function (target, framebuffer) {
            GL.validateGLObjectID(GL.framebuffers, framebuffer, 'glBindFramebuffer', 'framebuffer');

            // 记录 READ/DRAW 绑定，供 WebGL1 的 blit 兜底使用
            if (target === 0x8CA8 /* READ_FRAMEBUFFER */) {
                GL.readFramebuffer = framebuffer | 0;
            } else if (target === 0x8CA9 /* DRAW_FRAMEBUFFER */) {
                GL.drawFramebuffer = framebuffer | 0;
            } else {
                GL.readFramebuffer = framebuffer | 0;
                GL.drawFramebuffer = framebuffer | 0;
            }
            GL.boundFramebuffer = framebuffer | 0;
            if (!isWebGL2 && (target === 0x8CA8 || target === 0x8CA9)) {
                // WebGL1 只有 FRAMEBUFFER 这一个绑定点，READ/DRAW 会触发 GL_INVALID_ENUM
                target = 0x8D40;
            }
            gl.bindFramebuffer(target, framebuffer ? GL.framebuffers[framebuffer] : null);
        },

        glGenRenderbuffers: function (n, ids) {
            _glGenObject(n, ids, 'createRenderbuffer', GL.renderbuffers, 'glGenRenderbuffers');
        },
        glDeleteRenderbuffers: function (n, ids) {
            for (var i = 0; i < n; i++) {
                var id = getArray(ids + i * 4, Uint32Array, 1)[0];
                var rb = GL.renderbuffers[id];
                if (!rb) continue;
                gl.deleteRenderbuffer(rb);
                rb.name = 0;
                GL.renderbuffers[id] = null;
            }
        },
        glBindRenderbuffer: function (target, renderbuffer) {
            GL.validateGLObjectID(GL.renderbuffers, renderbuffer, 'glBindRenderbuffer', 'renderbuffer');
            gl.bindRenderbuffer(target, renderbuffer ? GL.renderbuffers[renderbuffer] : null);
        },
        glRenderbufferStorage: function (target, internalformat, width, height) {
            gl.renderbufferStorage(target, internalformat, width, height);
        },
        glRenderbufferStorageMultisample: function (target, samples, internalformat, width, height) {
            if (typeof gl.renderbufferStorageMultisample === "function") {
                gl.renderbufferStorageMultisample(target, samples, internalformat, width, height);
                return;
            }
            // WebGL1 没有多采样 renderbuffer，退化成普通 renderbuffer（无抗锯齿，但画面正确）。
            // 同时把 WebGL2 的尺寸化内部格式映射成 WebGL1 允许的格式。
            var fmt = internalformat;
            if (fmt === 0x8051 /* GL_RGB8 */) fmt = 0x8D62 /* GL_RGB565 */;
            else if (fmt === 0x8058 /* GL_RGBA8 */) fmt = 0x8056 /* GL_RGBA4 */;
            gl.renderbufferStorage(target, fmt, width, height);
        },
        glFramebufferRenderbuffer: function (target, attachment, rbtarget, renderbuffer) {
            GL.validateGLObjectID(GL.renderbuffers, renderbuffer, 'glFramebufferRenderbuffer', 'renderbuffer');
            gl.framebufferRenderbuffer(target, attachment, rbtarget, renderbuffer ? GL.renderbuffers[renderbuffer] : null);
        },
        glBlitFramebuffer: function (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
            if (typeof gl.blitFramebuffer === "function") {
                gl.blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
                return;
            }
            // WebGL1 兜底：用 copyTexSubImage2D 把源 FBO 的像素拷进目标 FBO 的 color 纹理
            var dstTex = GL.fboTextures[GL.drawFramebuffer];
            if (!dstTex) return;
            gl.bindFramebuffer(gl.FRAMEBUFFER, GL.framebuffers[GL.readFramebuffer] || null);
            gl.bindTexture(gl.TEXTURE_2D, dstTex);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, dx0, dy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, GL.framebuffers[GL.boundFramebuffer] || null);
            gl.bindTexture(gl.TEXTURE_2D, GL.boundTexture);
        },
        glGetError: function () {
            return gl.getError();
        },

        glGenBuffers: function (n, buffers) {
            _glGenObject(n, buffers, 'createBuffer', GL.buffers, 'glGenBuffers');
        },
        glBindBuffer: function (target, buffer) {
            GL.validateGLObjectID(GL.buffers, buffer, 'glBindBuffer', 'buffer');
            gl.bindBuffer(target, GL.buffers[buffer]);
        },
        glBufferData: function (target, size, data, usage) {
            gl.bufferData(target, data ? getArray(data, Uint8Array, size) : size, usage);
        },
        glBufferSubData: function (target, offset, size, data) {
            gl.bufferSubData(target, offset, data ? getArray(data, Uint8Array, size) : size);
        },
        glEnable: function (cap) {
            gl.enable(cap);
        },
        glFlush: function () {
            gl.flush();
        },
        glFinish: function () {
            gl.finish();
        },
        glDepthFunc: function (func) {
            gl.depthFunc(func);
        },
        glBlendFuncSeparate: function (sfactorRGB, dfactorRGB, sfactorAlpha, dfactorAlpha) {
            gl.blendFuncSeparate(sfactorRGB, dfactorRGB, sfactorAlpha, dfactorAlpha);
        },
        glViewport: function (x, y, width, height) {
            gl.viewport(x, y, width, height);
        },
        glDrawArrays: function (mode, first, count) {
            gl.drawArrays(mode, first, count);
        },
        glCreateProgram: function () {
            var id = GL.getNewId(GL.programs);
            var program = gl.createProgram();
            program.name = id;
            GL.programs[id] = program;
            return id;
        },
        glAttachShader: function (program, shader) {
            GL.validateGLObjectID(GL.programs, program, 'glAttachShader', 'program');
            GL.validateGLObjectID(GL.shaders, shader, 'glAttachShader', 'shader');
            gl.attachShader(GL.programs[program], GL.shaders[shader]);
        },
        glLinkProgram: function (program) {
            GL.validateGLObjectID(GL.programs, program, 'glLinkProgram', 'program');
            gl.linkProgram(GL.programs[program]);
            GL.populateUniformTable(program);
        },
        glPixelStorei: function (pname, param) {
            gl.pixelStorei(pname, param);
        },
        glFramebufferTexture2D: function (target, attachment, textarget, texture, level) {
            GL.validateGLObjectID(GL.textures, texture, 'glFramebufferTexture2D', 'texture');
            if (attachment === 0x8CE0 /* COLOR_ATTACHMENT0 */) {
                GL.fboTextures[GL.boundFramebuffer] = texture ? GL.textures[texture] : null;
            }
            gl.framebufferTexture2D(target, attachment, textarget, GL.textures[texture], level);
        },
        glGetProgramiv: function (program, pname, p) {
            assert(p);
            GL.validateGLObjectID(GL.programs, program, 'glGetProgramiv', 'program');
            if (program >= GL.counter) {
                console.error("GL_INVALID_VALUE in glGetProgramiv");
                return;
            }
            var ptable = GL.programInfos[program];
            if (!ptable) {
                console.error('GL_INVALID_OPERATION in glGetProgramiv(program=' + program + ', pname=' + pname + ', p=0x' + p.toString(16) + '): The specified GL object name does not refer to a program object!');
                return;
            }
            if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
                var log = gl.getProgramInfoLog(GL.programs[program]);
                assert(log !== null);

                getArray(p, Int32Array, 1)[0] = log.length + 1;
            } else if (pname == 0x8B87 /* GL_ACTIVE_UNIFORM_MAX_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else if (pname == 0x8B8A /* GL_ACTIVE_ATTRIBUTE_MAX_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else if (pname == 0x8A35 /* GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH */) {
                console.error("unsupported operation");
                return;
            } else {
                getArray(p, Int32Array, 1)[0] = gl.getProgramParameter(GL.programs[program], pname);
            }
        },
        glCreateShader: function (shaderType) {
            var id = GL.getNewId(GL.shaders);
            GL.shaders[id] = gl.createShader(shaderType);
            return id;
        },
        glStencilFuncSeparate: function (face, func, ref_, mask) {
            gl.stencilFuncSeparate(face, func, ref_, mask);
        },
        glStencilMaskSeparate: function (face, mask) {
            gl.stencilMaskSeparate(face, mask);
        },
        glStencilOpSeparate: function (face, fail, zfail, zpass) {
            gl.stencilOpSeparate(face, fail, zfail, zpass);
        },
        glFrontFace: function (mode) {
            gl.frontFace(mode);
        },
        glCullFace: function (mode) {
            gl.cullFace(mode);
        },
        glCopyTexImage2D: function (target, level, internalformat, x, y, width, height, border) {
            gl.copyTexImage2D(target, level, internalformat, x, y, width, height, border);
        },

        glShaderSource: function (shader, count, string, length) {
            GL.validateGLObjectID(GL.shaders, shader, 'glShaderSource', 'shader');
            var source = GL.getSource(shader, count, string, length);

            // https://github.com/emscripten-core/emscripten/blob/incoming/src/library_webgl.js#L2708
            if (emscripten_shaders_hack) {
                source = source.replace(/#extension GL_OES_standard_derivatives : enable/g, "");
                source = source.replace(/#extension GL_EXT_shader_texture_lod : enable/g, '');
                var prelude = '';
                if (source.indexOf('gl_FragColor') != -1) {
                    prelude += 'out mediump vec4 GL_FragColor;\n';
                    source = source.replace(/gl_FragColor/g, 'GL_FragColor');
                }
                if (source.indexOf('attribute') != -1) {
                    source = source.replace(/attribute/g, 'in');
                    source = source.replace(/varying/g, 'out');
                } else {
                    source = source.replace(/varying/g, 'in');
                }

                source = source.replace(/textureCubeLodEXT/g, 'textureCubeLod');
                source = source.replace(/texture2DLodEXT/g, 'texture2DLod');
                source = source.replace(/texture2DProjLodEXT/g, 'texture2DProjLod');
                source = source.replace(/texture2DGradEXT/g, 'texture2DGrad');
                source = source.replace(/texture2DProjGradEXT/g, 'texture2DProjGrad');
                source = source.replace(/textureCubeGradEXT/g, 'textureCubeGrad');

                source = source.replace(/textureCube/g, 'texture');
                source = source.replace(/texture1D/g, 'texture');
                source = source.replace(/texture2D/g, 'texture');
                source = source.replace(/texture3D/g, 'texture');
                source = source.replace(/#version 100/g, '#version 300 es\n' + prelude);
            }

            gl.shaderSource(GL.shaders[shader], source);
        },
        glGetProgramInfoLog: function (program, maxLength, length, infoLog) {
            GL.validateGLObjectID(GL.programs, program, 'glGetProgramInfoLog', 'program');
            var log = gl.getProgramInfoLog(GL.programs[program]);
            assert(log !== null);
            let array = getArray(infoLog, Uint8Array, maxLength);
            for (var i = 0; i < maxLength; i++) {
                array[i] = log.charCodeAt(i);
            }
        },
        glCompileShader: function (shader, count, string, length) {
            GL.validateGLObjectID(GL.shaders, shader, 'glCompileShader', 'shader');
            gl.compileShader(GL.shaders[shader]);
        },
        glGetShaderiv: function (shader, pname, p) {
            assert(p);
            GL.validateGLObjectID(GL.shaders, shader, 'glGetShaderiv', 'shader');
            if (pname == 0x8B84) { // GL_INFO_LOG_LENGTH
                var log = gl.getShaderInfoLog(GL.shaders[shader]);
                assert(log !== null);

                getArray(p, Int32Array, 1)[0] = log.length + 1;

            } else if (pname == 0x8B88) { // GL_SHADER_SOURCE_LENGTH
                var source = gl.getShaderSource(GL.shaders[shader]);
                var sourceLength = (source === null || source.length == 0) ? 0 : source.length + 1;
                getArray(p, Int32Array, 1)[0] = sourceLength;
            } else {
                getArray(p, Int32Array, 1)[0] = gl.getShaderParameter(GL.shaders[shader], pname);
            }
        },
        glGetShaderInfoLog: function (shader, maxLength, length, infoLog) {
            GL.validateGLObjectID(GL.shaders, shader, 'glGetShaderInfoLog', 'shader');
            var log = gl.getShaderInfoLog(GL.shaders[shader]);
            assert(log !== null);
            let array = getArray(infoLog, Uint8Array, maxLength);
            for (var i = 0; i < maxLength; i++) {
                array[i] = log.charCodeAt(i);
            }
        },
        glVertexAttribDivisor: function (index, divisor) {
            gl.vertexAttribDivisor(index, divisor);
        },
        glDrawArraysInstanced: function (mode, first, count, primcount) {
            gl.drawArraysInstanced(mode, first, count, primcount);
        },
        glDrawElementsInstanced: function (mode, count, type, indices, primcount) {
            gl.drawElementsInstanced(mode, count, type, indices, primcount);
        },
        glDeleteShader: function (shader) { gl.deleteShader(shader) },
        glDeleteBuffers: function (n, buffers) {
            for (var i = 0; i < n; i++) {
                var id = getArray(buffers + i * 4, Uint32Array, 1)[0];
                var buffer = GL.buffers[id];

                // From spec: "glDeleteBuffers silently ignores 0's and names that do not
                // correspond to existing buffer objects."
                if (!buffer) continue;

                gl.deleteBuffer(buffer);
                buffer.name = 0;
                GL.buffers[id] = null;
            }
        },
        glDeleteFramebuffers: function (n, buffers) {
            for (var i = 0; i < n; i++) {
                var id = getArray(buffers + i * 4, Uint32Array, 1)[0];
                var buffer = GL.framebuffers[id];

                // From spec: "glDeleteFrameBuffers silently ignores 0's and names that do not
                // correspond to existing buffer objects."
                if (!buffer) continue;

                gl.deleteFramebuffer(buffer);
                buffer.name = 0;
                GL.framebuffers[id] = null;
            }
        },
        glDeleteTextures: function (n, textures) {
            for (var i = 0; i < n; i++) {
                var id = getArray(textures + i * 4, Uint32Array, 1)[0];
                var texture = GL.textures[id];
                if (!texture) continue; // GL spec: "glDeleteTextures silently ignores 0s and names that do not correspond to existing textures".
                gl.deleteTexture(texture);
                texture.name = 0;
                GL.textures[id] = null;
            }
        },
		glGenQueries: function (n, ids) {
			_glGenObject(n, ids, 'createQuery', GL.timerQueries, 'glGenQueries');
		},
		glDeleteQueries: function (n, ids) {
            for (var i = 0; i < n; i++) {
                var id = getArray(textures + i * 4, Uint32Array, 1)[0];
                var query = GL.timerQueries[id];
                if (!query) {
					continue;
				}
                gl.deleteQuery(query);
                query.name = 0;
                GL.timerQueries[id] = null;
            }
		},
		glBeginQuery: function (target, id) {
			GL.validateGLObjectID(GL.timerQueries, id, 'glBeginQuery', 'id');
			gl.beginQuery(target, GL.timerQueries[id]);
		},
		glEndQuery: function (target) {
			gl.endQuery(target);
		},
		glGetQueryObjectiv: function (id, pname, ptr) {
			GL.validateGLObjectID(GL.timerQueries, id, 'glGetQueryObjectiv', 'id');
			let result = gl.getQueryObject(GL.timerQueries[id], pname);
			getArray(ptr, Uint32Array, 1)[0] = result;
		},
		glGetQueryObjectui64v: function (id, pname, ptr) {
			GL.validateGLObjectID(GL.timerQueries, id, 'glGetQueryObjectui64v', 'id');
			let result = gl.getQueryObject(GL.timerQueries[id], pname);
			let heap = getArray(ptr, Uint32Array, 2);
			heap[0] = result;
			heap[1] = (result - heap[0])/4294967296;
		},
        setup_canvas_size: function(high_dpi) {
            window.high_dpi = high_dpi;
            resize(canvas);
        },
        run_animation_loop: function (ptr) {
            canvas.onmousemove = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                // TODO: do not send mouse_move when cursor is captured
                wasm_exports.mouse_move(Math.floor(x), Math.floor(y));

                // TODO: check that mouse is captured?
                if (event.movementX != 0 || event.movementY != 0) {
                    wasm_exports.raw_mouse_move(Math.floor(event.movementX), Math.floor(event.movementY));
                }
            };
            canvas.onmousedown = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                var btn = into_sapp_mousebutton(event.button);
                wasm_exports.mouse_down(x, y, btn);
            };
            // SO WEB SO CONSISTENT
            canvas.addEventListener('wheel',
                function (event) {
                    event.preventDefault();
                    wasm_exports.mouse_wheel(-event.deltaX, -event.deltaY);
                });
            canvas.onmouseup = function (event) {
                var relative_position = mouse_relative_position(event.clientX, event.clientY);
                var x = relative_position.x;
                var y = relative_position.y;

                var btn = into_sapp_mousebutton(event.button);
                wasm_exports.mouse_up(x, y, btn);
            };
            canvas.onkeydown = function (event) {
                window.__canvasKey = event.code;
                var sapp_key_code = into_sapp_keycode(event.code);
                switch (sapp_key_code) {
                    //  space, arrows - prevent scrolling of the page
                    case 32: case 262: case 263: case 264: case 265:
                    // F1-F10
                    case 290: case 291: case 292: case 293: case 294: case 295: case 296: case 297: case 298: case 299:
                    // backspace is Back on Firefox/Windows
                    case 259:
                    // tab - for UI
                    case 258:
                    // quote and slash are Quick Find on Firefox
                    case 39: case 47:
                        event.preventDefault();
                        break;
                }

                var modifiers = 0;
                if (event.ctrlKey) {
                    modifiers |= SAPP_MODIFIER_CTRL;
                }
                if (event.shiftKey) {
                    modifiers |= SAPP_MODIFIER_SHIFT;
                }
                if (event.altKey) {
                    modifiers |= SAPP_MODIFIER_ALT;
                }
                wasm_exports.key_down(sapp_key_code, modifiers, event.repeat);
                // for "space", "quote", and "slash" preventDefault will prevent
                // key_press event, so send it here instead
                if (sapp_key_code == 32 || sapp_key_code == 39 || sapp_key_code == 47) {
                    wasm_exports.key_press(sapp_key_code);
                }
            };
            canvas.onkeyup = function (event) {
                var sapp_key_code = into_sapp_keycode(event.code);

                var modifiers = 0;
                if (event.ctrlKey) {
                    modifiers |= SAPP_MODIFIER_CTRL;
                }
                if (event.shiftKey) {
                    modifiers |= SAPP_MODIFIER_SHIFT;
                }
                if (event.altKey) {
                    modifiers |= SAPP_MODIFIER_ALT;
                }

                wasm_exports.key_up(sapp_key_code, modifiers);
            };
            canvas.onkeypress = function (event) {
                var sapp_key_code = into_sapp_keycode(event.code);

                // firefox do not send onkeypress events for ctrl+keys and delete key while chrome do
                // workaround to make this behavior consistent
                let chrome_only = sapp_key_code == 261 || event.ctrlKey;
                if (chrome_only == false) {
                    wasm_exports.key_press(event.charCode);
                }
            };

            // 触摸输入统一走 miniquad 的 touch 通道，和上游 miniquad 的 web glue 完全一致。
            //
            // 为什么不能把第一根手指映射成鼠标：
            //   鼠标在 miniquad/prpr 里只占一个固定 id（button_to_id(Left) = u64::MAX），
            //   把第一根手指塞进鼠标通道等于「一根手指霸占唯一的鼠标触点」，
            //   剩下的手指虽然发了 touch 事件，但判定层里鼠标触点每帧都被
            //   Handler::finalize() 重新补成 Moved，会和真实 touch 状态互相覆盖，
            //   结果就是第二根手指按下去没有反应 —— 也就是「不支持多点触控」。
            //   引擎（prpr judge）本身是按 touch id 用 HashMap 逐个追踪触点的，
            //   只要每根手指都带自己的 id 走 touch 通道，多指/多押天然可用。
            //
            // 兼容开关：URL 带 ?mouse=1 时恢复旧的「第一根手指模拟鼠标」行为，
            // 仅在极老浏览器上 touch 通道不可用时使用。
            const emulateMouseWithFirstTouch = /[?&]mouse=1/.test(location.search);
            let primaryTouchId = null;

            function dispatchTouch(phase, touch, pos) {
                // 排查用：记录最后一次触摸的原始/换算坐标
                window.__lastTouch = { clientX: touch.clientX, clientY: touch.clientY, x: pos.x, y: pos.y };
                if (emulateMouseWithFirstTouch) {
                    const ended = phase === SAPP_EVENTTYPE_TOUCHES_ENDED || phase === SAPP_EVENTTYPE_TOUCHES_CANCELLED;
                    if (phase === SAPP_EVENTTYPE_TOUCHES_BEGAN && primaryTouchId === null) {
                        primaryTouchId = touch.identifier;
                        wasm_exports.mouse_move(Math.floor(pos.x), Math.floor(pos.y));
                        wasm_exports.mouse_down(Math.floor(pos.x), Math.floor(pos.y), 0);
                        return;
                    }
                    if (touch.identifier === primaryTouchId) {
                        wasm_exports.mouse_move(Math.floor(pos.x), Math.floor(pos.y));
                        if (ended) {
                            primaryTouchId = null;
                            wasm_exports.mouse_up(Math.floor(pos.x), Math.floor(pos.y), 0);
                        }
                        return;
                    }
                }
                wasm_exports.touch(phase, touch.identifier, pos.x, pos.y);
            }

            canvas.addEventListener("touchstart", function (event) {
                event.preventDefault();

                for (const touch of event.changedTouches) {
                    dispatchTouch(SAPP_EVENTTYPE_TOUCHES_BEGAN, touch, mouse_relative_position(touch.clientX, touch.clientY));
                }
            });
            canvas.addEventListener("touchend", function (event) {
                event.preventDefault();

                for (const touch of event.changedTouches) {
                    dispatchTouch(SAPP_EVENTTYPE_TOUCHES_ENDED, touch, mouse_relative_position(touch.clientX, touch.clientY));
                }
            });
            canvas.addEventListener("touchcancel", function (event) {
                event.preventDefault();

                for (const touch of event.changedTouches) {
                    dispatchTouch(SAPP_EVENTTYPE_TOUCHES_CANCELLED, touch, mouse_relative_position(touch.clientX, touch.clientY));
                }
            });
            canvas.addEventListener("touchmove", function (event) {
                event.preventDefault();

                for (const touch of event.changedTouches) {
                    dispatchTouch(SAPP_EVENTTYPE_TOUCHES_MOVED, touch, mouse_relative_position(touch.clientX, touch.clientY));
                }
            });

            // 移动端只靠 window.onresize 会漏掉旋转/全屏/地址栏伸缩等场景，
            // 统一由 installSizeWatchers 监听多种事件并多次补同步。
            installSizeWatchers();
            window.onresize = syncCanvasSize;
            window.addEventListener("copy", function(e) {
                if (clipboard != null) {
                    e.clipboardData.setData('text/plain', clipboard);
                    e.preventDefault();
                }
            });
            window.addEventListener("cut", function(e) {
                if (clipboard != null) {
                    e.clipboardData.setData('text/plain', clipboard);
                    e.preventDefault();
                }
            });

            window.addEventListener("paste", function(e) {
                e.stopPropagation();
                e.preventDefault();
                var clipboardData = e.clipboardData || window.clipboardData;
                var pastedData = clipboardData.getData('Text');

                if (pastedData != undefined && pastedData != null && pastedData.length != 0) {
                    var len = (new TextEncoder().encode(pastedData)).length;
                    var msg = wasm_exports.allocate_vec_u8(len);
                    var heap = new Uint8Array(wasm_memory.buffer, msg, len);
                    stringToUTF8(pastedData, heap, 0, len);
                    wasm_exports.on_clipboard_paste(msg, len);
                }
            });

            window.ondragover = function(e) {
                e.preventDefault();
            };

            window.ondrop = async function(e) {
                e.preventDefault();

                wasm_exports.on_files_dropped_start();

                for (let file of e.dataTransfer.files) {
                    const nameLen = file.name.length;
                    const nameVec = wasm_exports.allocate_vec_u8(nameLen);
                    const nameHeap = new Uint8Array(wasm_memory.buffer, nameVec, nameLen);
                    stringToUTF8(file.name, nameHeap, 0, nameLen);

                    const fileBuf = await file.arrayBuffer();
                    const fileLen = fileBuf.byteLength;
                    const fileVec = wasm_exports.allocate_vec_u8(fileLen);
                    const fileHeap = new Uint8Array(wasm_memory.buffer, fileVec, fileLen);
                    fileHeap.set(new Uint8Array(fileBuf), 0);

                    wasm_exports.on_file_dropped(nameVec, nameLen, fileVec, fileLen);
                }

                wasm_exports.on_files_dropped_finish();
            };

            window.requestAnimationFrame(animation);
        },

        fs_load_file: function (ptr, len) {
            var url = UTF8ToString(ptr, len);
            var file_id = FS.unique_id;
            FS.unique_id += 1;
            // 绝对跨域地址（官方文件 CDN）没有 CORS 头，走 phira1 代理；
            // 相对路径仍走无扩展名出口 /__res（避免 IDM 按 .ogg/.ttf 拦截）
            var urls;
            if (/^https?:\/\//i.test(url)) {
                urls = ["https://phira1.xytools.qzz.io/index.php?url=" + encodeURIComponent(url)];
            } else {
                var clean = url.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
                var candidates = [clean];
                if (clean.indexOf("assets/") === 0 || clean.indexOf("respack/") === 0) {
                    candidates.push(clean.slice(clean.indexOf("/") + 1));
                } else {
                    candidates.push("assets/" + clean);
                    candidates.push("respack/" + clean);
                }
                urls = candidates.map(function (p) { return "/__res?p=" + encodeURIComponent(p); });
            }

            var urlIdx = 0;
            function requestFile() {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', urls[urlIdx], true);
                xhr.responseType = 'arraybuffer';
                // 标记为 XHR 请求，避免下载管理器把资源当成文件下载拦截
                try { xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); } catch (e) {}

                xhr.onreadystatechange = function() {
                    if (this.readyState !== 4) return;
                    if (this.status === 200) {
                        FS.loaded_files[file_id] = new Uint8Array(this.response);
                        wasm_exports.file_loaded(file_id);
                    } else if (urlIdx + 1 < urls.length) {
                        urlIdx += 1;
                        setTimeout(requestFile, 120);
                    } else {
                        FS.loaded_files[file_id] = null;
                        wasm_exports.file_loaded(file_id);
                    }
                };
                xhr.send();
            }
            requestFile();

            return file_id;
        },

        fs_get_buffer_size: function (file_id) {
            if (FS.loaded_files[file_id] == null) {
                return -1;
            } else {
                return FS.loaded_files[file_id].length;
            }
        },
        fs_take_buffer: function (file_id, ptr, max_length) {
            var file = FS.loaded_files[file_id];
            console.assert(file.length <= max_length);
            var dest = new Uint8Array(wasm_memory.buffer, ptr, max_length);
            for (var i = 0; i < file.length; i++) {
                dest[i] = file[i];
            }
            delete FS.loaded_files[file_id];
        },
        sapp_set_cursor_grab: function (grab) {
            if (grab) {
                canvas.requestPointerLock();
            } else {
                document.exitPointerLock();
            }
        },
        sapp_set_cursor: function(ptr, len) {
            canvas.style.cursor = UTF8ToString(ptr, len);
        },
        sapp_is_fullscreen: function() {
            let fullscreenElement = document.fullscreenElement;

            return fullscreenElement != null && fullscreenElement.id == canvas.id;
        },
        sapp_set_fullscreen: function(fullscreen) {
            if (!fullscreen) {
                document.exitFullscreen();
            } else {
                canvas.requestFullscreen();
            }
        },
        sapp_set_window_size: function(new_width, new_height) {
            canvas.width = new_width;
            canvas.height = new_height;
            // 不能在 wasm 调用栈内同步回调 wasm 的 resize 导出：miniquad 的 resize
            // 会再次进入 GLOBALS 的 RefCell，造成借用重入 panic（表现为 unreachable）。
            // 推迟到下一个宏任务，此时 wasm 已退出 with()。
            setTimeout(function () { resize(canvas, wasm_exports.resize); }, 0);
        }
    }
};


function register_plugins(plugins) {
    if (plugins == undefined)
        return;

    for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].register_plugin != undefined && plugins[i].register_plugin != null) {
            plugins[i].register_plugin(importObject);
        }
    }
}

function u32_to_semver(crate_version) {
    let major_version = (crate_version >> 24) & 0xff;
    let minor_version = (crate_version >> 16) & 0xff;
    let patch_version = crate_version & 0xffff;

    return major_version + "." + minor_version + "." + patch_version;
}

function init_plugins(plugins) {
    if (plugins == undefined)
        return;

    for (var i = 0; i < plugins.length; i++) {
        if (plugins[i].on_init != undefined && plugins[i].on_init != null) {
            plugins[i].on_init();
        }
        if (plugins[i].name == undefined || plugins[i].name == null ||
            plugins[i].version == undefined || plugins[i].version == null) {
            console.warn("Some of the registred plugins do not have name or version");
            console.warn("Probably old version of the plugin used");
        } else {
            var version_func = plugins[i].name + "_crate_version";

            if (wasm_exports[version_func] == undefined) {
                console.log("Plugin " + plugins[i].name + " is present in JS bundle, but is not used in the rust code.");
            } else {
                var crate_version = u32_to_semver(wasm_exports[version_func]());

                if (plugins[i].version != crate_version) {
                    console.error("Plugin " + plugins[i].name + " version mismatch" +
                                  "js version: " + plugins[i].version + ", crate version: " + crate_version)
                }
            }
        }
     }
}


function miniquad_add_plugin(plugin) {
    plugins.push(plugin);
}

// read module imports and create fake functions in import object
// this is will allow to successfeully link wasm even with wrong version of gl.js
// needed to workaround firefox bug with lost error on wasm linking errors
function add_missing_functions_stabs(obj) {
    var imports = WebAssembly.Module.imports(obj);

    for (const i in imports) {
        if (importObject["env"][imports[i].name] == undefined) {
            console.warn("No " + imports[i].name + " function in gl.js");
            importObject["env"][imports[i].name] = function() {
                console.warn("Missed function: " + imports[i].name);
            };
        }
    }
}

function load(wasm_path) {
    var req = fetch(wasm_path);

    register_plugins(plugins);

    if (typeof WebAssembly.compileStreaming === 'function') {
        WebAssembly.compileStreaming(req)
            .then(obj => {
                add_missing_functions_stabs(obj);
                return WebAssembly.instantiate(obj, importObject);
            })
            .then(
                obj => {
                    wasm_memory = obj.exports.memory;
                    wasm_exports = obj.exports;

                    var crate_version = u32_to_semver(wasm_exports.crate_version());
                    if (version != crate_version) {
                        console.error(
                            "Version mismatch: gl.js version is: " + version +
                                ", miniquad crate version is: " + crate_version);
                    }
                    init_plugins(plugins);
                    obj.exports.main();
                })
            .catch(err => {
                console.error("WASM failed to load, probably incompatible gl.js version");
                console.error(err);
            })
    } else {
        req
            .then(function (x) { return x.arrayBuffer(); })
            .then(function (bytes) { return WebAssembly.compile(bytes); })
            .then(function (obj) {
                add_missing_functions_stabs(obj);
                return WebAssembly.instantiate(obj, importObject);
            })
            .then(function (obj) {
                wasm_memory = obj.exports.memory;
                wasm_exports = obj.exports;

                var crate_version = u32_to_semver(wasm_exports.crate_version());
                if (version != crate_version) {
                    console.error(
                        "Version mismatch: gl.js version is: " + version +
                            ", rust sapp-wasm crate version is: " + crate_version);
                }
                init_plugins(plugins);
                obj.exports.main();
            })
            .catch(err => {
                console.error("WASM failed to load, probably incompatible gl.js version");
                console.error(err);
            });
    }
}
