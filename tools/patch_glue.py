import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    content = f.read()

# 合并 miniquad / host.js 提供的 env 导入
content = content.replace(
    "const imports = __wbg_get_imports();",
    "const imports = __wbg_get_imports(); if (window.__miniquad_env) { imports.env = window.__miniquad_env; }",
)
# 兼容旧版本补丁
content = content.replace(
    "if (window.__miniquad_env) { imports.env = Object.assign(imports.env || {}, window.__miniquad_env); }",
    "if (window.__miniquad_env) { imports.env = window.__miniquad_env; }",
)

# wasm-bindgen 会生成 `import * as importN from "env"`，改成全局引用
content, n = re.subn(
    r'import \* as (import\d+) from "env"',
    r"const \1 = window.__miniquad_env;",
    content,
)

with open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write(content)

print(f"patched {path}: env imports replaced = {n}")
