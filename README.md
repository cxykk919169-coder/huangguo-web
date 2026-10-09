# 湟果视频 · 网页客户端

> **个人学习与技术研究项目 · 非商业用途**
>
> 本项目**不含任何视听内容**，不存储、不上传、不转码、不分发任何视频文件。
> 页面展示的数据全部来自第三方公开网页，仅做**索引与跳转**。
> 所有内容版权归原作者及权利方所有。
>
> ⚠️ **严禁任何商业用途。** 详见 [DISCLAIMER.md](DISCLAIMER.md)。

---

## 这是什么

一个用于学习 Web 技术的练手项目，涉及网页解析、Serverless、PWA、自动化部署等技术点。

- `index.html` —— 前端界面（单文件，手机/电脑通用）
- `worker.js` —— 后端代理（部署到 Cloudflare Workers，**免费**）
- `site.json` —— 站点规则（上游改版/换域名只改这里）

架构：

```
用户浏览器  ->  Cloudflare Worker(代理)  ->  第三方公开网页
```

---

## 技术栈（本项目的学习价值）

| 技术点 | 说明 |
|---|---|
| **HTML 解析** | 五源合并解析（内嵌JSON / JSON-LD / 卡片 / 分类 / 热搜），正则 + 启发式 |
| **Cloudflare Workers** | Serverless 边缘计算，静态资源绑定 + API 代理双模 |
| **PWA** | Service Worker 缓存策略、manifest、桌面安装 |
| **自愈机制** | Cron 定时自检、镜像自动切换、Windows 计划任务守护 |
| **自动化部署** | wrangler + PowerShell 脚本 + GitHub Actions 双流水线 |

---

## 免责声明（摘要）

1. 本项目**非商业**，不收费、无广告、无任何变现；
2. 本站**不存储任何视频内容**，仅索引公开网页信息并提供跳转；
3. 所有第三方内容**版权归权利人所有**；
4. 权利人若认为索引侵权，可通过 **Issue** 联系，我们**及时删除**；
5. **使用者自行承担使用风险**，本项目不提供任何保证；
6. **严禁商业用途**，严禁违法用途。

完整声明见 **[DISCLAIMER.md](DISCLAIMER.md)**。

---

## 许可

[MIT License](LICENSE) —— 仅限个人学习、技术研究与交流使用，**禁止商业用途**。

---

# 手把手部署（完全小白版）

## 准备工作

- 一个 **GitHub 账号**（你已有）
- 一个 **Cloudflare 账号**（免费注册，用邮箱就行）
- 大概 10 分钟

---

## 第 1 步：部署后端（Cloudflare Worker）

### 1.1 注册 Cloudflare

1. 打开 https://dash.cloudflare.com/sign-up
2. 输入邮箱 + 密码，注册，去邮箱点验证链接
3. 登录后进入控制台

### 1.2 创建 Worker

1. 左侧菜单点 **Workers 和 Pages**（或 Workers & Pages）
2. 点 **创建** -> 选 **Workers** -> 点 **创建 Worker**
3. 名字随便起，比如 `huangguo-api`
4. 点 **部署**（先部署默认的 Hello World）
5. 部署后点 **编辑代码**

### 1.3 粘贴代码

1. 把编辑器里**所有内容删掉**
2. 打开本项目里的 `worker.js`，**全选复制**
3. **粘贴**到 Cloudflare 编辑器里
4. 点右上角 **部署**

### 1.4 拿到地址

部署成功后，你会得到一个地址，形如：

```
https://huangguo-api.你的用户名.workers.dev
```

**把这个地址记下来，下一步要用。**

### 1.5 自测

浏览器打开：`https://你的地址.workers.dev/api/health`

看到这样的输出就成功了：

```json
{"ok":true,"mirror":"https://b8ok.ngfxaxnp.cc","mirrors":[...]}
```

---

## 第 2 步：部署前端（GitHub Pages）

### 2.1 建仓库

1. 打开 https://github.com/new
2. **Repository name**：`huangguo-web`（或你喜欢的名字）
3. 选 **Public**（必须公开，Pages 免费版只支持公开仓库）
4. 点 **Create repository**

### 2.2 上传文件

**方法 A：网页上传（最简单）**

1. 在仓库页面点 **uploading an existing file** 链接
2. 把 `index.html`、`site.json`、`README.md` 拖进去
3. 底下点 **Commit changes**

**方法 B：命令行**

```bash
git clone https://github.com/你的用户名/huangguo-web.git
cd huangguo-web
copy ..\\index.html .
copy ..\\site.json .
git add .
git commit -m init
git push
```

### 2.3 开启 Pages

1. 进入仓库 -> 点上方 **Settings**
2. 左侧菜单找到 **Pages**
3. **Source** 选 **Deploy from a branch**
4. **Branch** 选 **main**，文件夹选 **/ (root)**
5. 点 **Save**
6. 等 1-2 分钟，刷新页面，会看到：

```
Your site is live at https://你的用户名.github.io/huangguo-web/
```

---

## 第 3 步：把两者连起来

1. 用手机或电脑打开你的 Pages 地址：

```
https://你的用户名.github.io/huangguo-web/
```

2. 页面底部点 **服务器设置**
3. 填入第 1 步拿到的 Worker 地址：

```
https://huangguo-api.你的用户名.workers.dev
```

4. 点 **保存** -> 页面刷新 -> **完成！**

---

# 验证

打开你的网址，应该能看到：

- 顶部有分类标签（推荐 / AI短剧 / AI漫剧 / AI换脸 / AI魔改 / 吃瓜）
- 下面是封面卡片网格
- 点任意一部 -> 看详情 -> 点集数 -> 页面内直接播放
- 顶部搜索框可以搜片名，或直接输入数字 ID 跳转

---

# 别人怎么用

**把网址发给他们就行。** 手机、电脑、平板都能打开，**不用安装任何东西**。

如果你想更正式一点：

1. **买个短域名**（几十块一年），用 Cloudflare 免费 CDN 绑定
2. **做个二维码**，方便分享
3. **做成 APK**（用 WebView 套壳，参考那个开源项目）

---

# 常见问题

## Q1: 页面显示「还没有配置后端服务器」
-> 点底部「服务器设置」，填入 Worker 地址。

## Q2: 提示 CORS / 跨域错误
-> Worker 没部署好。打开 `你的Worker地址/api/health` 自测。

## Q3: 图片显示不出来
-> 官方图片 CDN 的 auth_key 过期了，重新加载页面即可。

## Q4: 视频播放失败
-> 直链的 auth_key 有时效。刷新页面拿新的。

## Q5: 全部都不能用了
-> **官方换域名了。** 去发布页 https://huangguoai.ai 拿新域名，
   然后改 `worker.js` 顶部的 `MIRRORS` 数组，重新部署。

## Q6: Cloudflare 免费额度够吗

| 项目 | 免费额度 |
|------|---------|
| 请求数 | 每天 **100,000 次** |
| CPU 时间 | 每次请求 10ms |

**按每人每天看 20 部剧算，够 5000 人用。**

---

# 官方改版了怎么办

只需要改 `worker.js` 里的解析规则（`parseCards` / `parseVideo` 两个函数），或者参考 `site.json` 里的选择器定义。

改完在 Cloudflare 编辑器里重新粘贴 -> 部署，**10 秒生效**，不用改前端。

---

# 文件说明

| 文件 | 作用 |
|------|------|
| `index.html` | 前端界面（部署到 GitHub Pages） |
| `worker.js` | 后端代理（部署到 Cloudflare Workers） |
| `site.json` | 站点规则文档（给人看的） |
| `README.md` | 本文件 |

---

# 声明

- 本项目**不含任何内容**，只是解析公开网页的展示工具
- 视频数据来自公开可访问的网页
- 使用者应自行确认所在地法律法规
- 仅供个人学习与技术研究