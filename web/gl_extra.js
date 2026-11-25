// gl.js 旧版本缺少部分 WebGL 导入函数，这里补齐（使用 gl.js 暴露的 gl / GL / getArray）。
(function () {
    if (typeof importObject === "undefined" || typeof gl === "undefined") {
        return;
    }
    var env = importObject.env;

    function missing(name, fn) {
        if (typeof env[name] !== "function") {
            env[name] = fn;
        }
    }

    missing("glGenRenderbuffers", function (n, ids) {
        for (var i = 0; i < n; i++) {
            var id = GL.getNewId(GL.renderbuffers);
            GL.renderbuffers[id] = gl.createRenderbuffer();
            getArray(ids + i * 4, Uint32Array, 1)[0] = id;
        }
    });

    missing("glDeleteRenderbuffers", function (n, ids) {
        var arr = getArray(ids, Uint32Array, n);
        for (var i = 0; i < n; i++) {
            var id = arr[i];
            if (id && GL.renderbuffers[id]) {
                gl.deleteRenderbuffer(GL.renderbuffers[id]);
                GL.renderbuffers[id] = null;
            }
        }
    });

    missing("glBindRenderbuffer", function (target, id) {
        GL.validateGLObjectID(GL.renderbuffers, id, "glBindRenderbuffer", "renderbuffer");
        gl.bindRenderbuffer(target, GL.renderbuffers[id]);
    });

    missing("glRenderbufferStorageMultisample", function (target, samples, internalformat, width, height) {
        if (gl.renderbufferStorageMultisample) {
            gl.renderbufferStorageMultisample(target, samples, internalformat, width, height);
        } else {
            gl.renderbufferStorage(target, internalformat, width, height);
        }
    });

    missing("glFramebufferRenderbuffer", function (target, attachment, renderbuffertarget, id) {
        GL.validateGLObjectID(GL.renderbuffers, id, "glFramebufferRenderbuffer", "renderbuffer");
        gl.framebufferRenderbuffer(target, attachment, renderbuffertarget, GL.renderbuffers[id]);
    });

    missing("glBlitFramebuffer", function (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
        if (gl.blitFramebuffer) {
            gl.blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
        }
    });

    missing("glGenerateMipmap", function (target) {
        gl.generateMipmap(target);
    });

    missing("glGetError", function () {
        return gl.getError();
    });
})();
