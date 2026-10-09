#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wrangler.toml 校验器
====================
背景: YAML 的 `run: |` 块每行都带前导空格, 用 <<'EOF' 写文件时这些空格会原样进文件。
wrangler 对「行首有空格」的配置有时能忍、有时会静默回退到 dashboard 上的旧配置,
表现为 run_worker_first 失效、/api/* 全 404。这个脚本在部署前把它拦住。

用法: python3 .github/check_toml.py wrangler.toml
"""
import re
import sys


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "wrangler.toml"
    try:
        text = open(path, encoding="utf-8").read()
    except Exception as e:
        print("  [X ] 读不到 %s: %s" % (path, e))
        return 1

    print("  === wrangler.toml 校验 ===")
    ok = True

    # 1. 行首禁止有空格 (TOML 里 table/key 顶格)
    bad = []
    for i, line in enumerate(text.splitlines(), 1):
        if re.match(r"^[ \t]+(name|main|compatibility_date|\[)", line):
            bad.append((i, line))
    if bad:
        print("  [X ] 这些行行首有空格:")
        for i, line in bad[:10]:
            print("        L%d: %r" % (i, line[:70]))
        ok = False
    else:
        print("  [OK] 行首无空格")

    # 2. 真 TOML 解析
    try:
        try:
            import tomllib as tl
        except ImportError:
            import tomli as tl
        d = tl.loads(text)
        print("  [OK] TOML 语法合法")
    except Exception as e:
        print("  [X ] TOML 解析失败: %s" % e)
        # 打印出错附近的行, 方便定位
        m = re.search(r"at line (\d+)", str(e))
        if m:
            n = int(m.group(1))
            for i, line in enumerate(text.splitlines(), 1):
                if abs(i - n) <= 2:
                    print("        L%d: %s" % (i, line[:90]))
        return 1

    # 3. 必填字段
    need = ["name", "main", "compatibility_date", "assets", "triggers"]
    miss = [k for k in need if k not in d]
    if miss:
        print("  [X ] 缺字段: %s" % miss)
        ok = False
    else:
        print("  [OK] 字段齐全: %s" % ", ".join(need))

    # 4. run_worker_first 必须是非空数组 (数组模式才能精确控制哪些路径走 Worker)
    rwf = (d.get("assets") or {}).get("run_worker_first")
    if not isinstance(rwf, list) or not rwf:
        print("  [X ] assets.run_worker_first 必须是非空数组, 实际=%r" % (rwf,))
        ok = False
    else:
        print("  [OK] run_worker_first (%d 条): %s" % (len(rwf), ", ".join(rwf)))
        # /api/* 必须在内, 否则 /api 全 404
        if "/api/*" not in rwf:
            print("  [X ] run_worker_first 里没有 /api/*, /api 会被静态资源兜底成 404")
            ok = False
        else:
            print("  [OK] /api/* 已覆盖")

    # 5. 静态资源目录存在且有内容
    import os
    adir = (d.get("assets") or {}).get("directory")
    if adir:
        if os.path.isdir(adir):
            n = len(os.listdir(adir))
            print("  [OK] 静态目录 %s 存在 (%d 个文件)" % (adir, n))
            if n == 0:
                print("  [X ] 静态目录是空的")
                ok = False
            if os.path.isfile(os.path.join(adir, "_headers")):
                print("  [OK] _headers 已就位 (缓存策略声明)")
            else:
                print("  [--] 没有 _headers, 静态资源会走 Cloudflare 默认缓存头")
        else:
            print("  [X ] 静态目录 %s 不存在" % adir)
            ok = False

    print("  RESULT %s" % ("OK" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
