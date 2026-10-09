@{
    # ==========================================================
    # 黄果客户端 · 部署配置模板
    # ==========================================================
    # 用法:
    #   1. 把这个文件复制成 deploy.config.psd1
    #   2. 填入你自己的 Cloudflare 信息
    #   3. 双击 部署.cmd
    #
    # ⚠️ deploy.config.psd1 已在 .gitignore 里, 不会被提交
    # ==========================================================

    # ---- Cloudflare ----
    # 申请地址: https://dash.cloudflare.com/profile/api-tokens
    # 需要权限: Account -> Workers Scripts -> Edit
    CF_API_TOKEN = '把你的_Cloudflare_Token_填这里'

    # 账户 ID: Cloudflare 控制台右侧栏可见
    CF_ACCOUNT_ID = '你的_账户ID'

    # Worker 名字 (改这个就是换个部署地址)
    WORKER_NAME = 'huangguo-web'

    # workers.dev 子域名 (脚本会自动从 API 查; 这里只是兜底)
    WORKERS_SUBDOMAIN = ''

    # ---- 网络 ----
    # auto = 自动探测代理 (推荐) ; on = 强制 ; off = 不走
    USE_PROXY = 'auto'

    # 自动探测的代理端口
    PROXY_CANDIDATES = '127.0.0.1:7890,127.0.0.1:7897,127.0.0.1:10809,127.0.0.1:1080,127.0.0.1:8080'

    # ---- 行为 ----
    VERIFY_AFTER_DEPLOY = $true
    MAX_RETRY = 3
}
