# Windows 开发与 Ubuntu 部署

本文对应 Docker + 账号密码注册版本。当前服务器：Ubuntu 20.04.4 / x86_64，`10.0.9.175`，免密 SSH `root@10.0.9.175`，现有 Docker 27.5.1、Node 22.23.2。沿用现有 Docker，不需安装 Podman、pasta 或调整 cgroup。8080 已被占用，本项目使用 7000 起的端口。

## 1. Windows 首次启动

启动 Docker Desktop，确认使用 Linux containers。在 PowerShell 中：

```powershell
cd F:\ai-demo\deepseek-harness-portal
npm ci --prefix portal
.\build-image.ps1
```

脚本从官方 npm 查询 `latest`，按明确版本构建，并打印 `DSH_IMAGE=sha256:...`。本次验证版本为 `0.1.1-rc.2`。不需要另外 clone DSH 源码，也不依赖 Windows 全局安装的 dsh。

如果还没有 `.env`，复制一次：

```powershell
Copy-Item .env.example .env
notepad .env
```

已有 `.env` 时直接编辑，不要覆盖。至少确认：

```dotenv
NODE_ENV=development
DOMAIN=localhost
HOST=127.0.0.1
PORTAL_ORIGIN=http://localhost:7000
PORT=7000
INSTANCE_ROUTING=ports
INSTANCE_PORT_START=7001
COOKIE_DOMAIN=
ADMIN_NAME=admin
ADMIN_PASSWORD=填写你自己的至少16位密码
DSH_IMAGE=填写构建脚本输出的sha256值
```

本次已在本机生成 `.env`，管理员密码随机生成，查看文件中的 `ADMIN_PASSWORD` 即可。它不进入 Git。ADMIN 配置只在数据库尚无管理员时生效；启动后改 `.env` 密码不会重置数据库账号。

```powershell
.\run-portal.ps1
```

保持终端运行，打开 `http://localhost:7000`。普通用户点击 Register，填写账号、密码、确认密码即可，邮箱、SMTP、验证码均不需要。管理员账号为 `admin`；它默认只管理平台，不自动创建个人 DSH。

注册账号统一转为小写，允许 3–32 位英文字母、数字、点、下划线、连字符。密码至少 8 个字符，最多 72 字节。注册成功会自动登录并创建独立容器，准备就绪后点击 Launch。

## 2. 本地改代码后怎样看效果

- 修改 `portal/public/`：浏览器刷新即可，没有前端打包步骤。
- 修改 `portal/src/`：在运行终端按 Ctrl+C，再执行 `run-portal.ps1`，刷新浏览器。
- 修改 `portal/package*.json`：先重新 `npm ci --prefix portal`，再重启。
- 修改 `image/`：重新构建、替换 `.env` 的镜像 ID、重启 Portal。DSH 版本升级则使用 Portal 的“DSH 版本”页构建受控镜像并在实例管理中切换；已有实例不会因镜像标签改变而自动升级。

```powershell
npm test --prefix portal
node --env-file=.env scripts/smoke-docker.mjs
```

第一条不依赖 Docker；第二条创建临时容器和数据卷，检查启动、停止/恢复、重建后数据保留及网络出站，结束后清理这些测试数据。项目专属网络和对应规则保留供 Portal 使用。

## 3. 国内下载源

Docker Desktop → Settings → Docker Engine 的 `registry-mirrors` 负责基础镜像下载；地址必须是纯 URL，不能包含 Markdown 链接语法。你已配置并验证生效。

镜像构建内部默认：npm 使用 `https://registry.npmmirror.com`，Debian 使用 `http://mirrors.aliyun.com`。apt 仍验证 Debian 签名及包摘要，没有关闭验证。国内镜像可能同步延迟；脚本从官方 npm 解析版本，不会因镜像缺包静默安装旧版本。

临时改为官方源的 PowerShell 示例（只影响这次终端中的构建）：

```powershell
$env:NPM_REGISTRY='https://registry.npmjs.org'
$env:DEBIAN_MIRROR='http://deb.debian.org'
.\build-image.ps1
Remove-Item Env:NPM_REGISTRY, Env:DEBIAN_MIRROR
```

Linux 示例：

```bash
NPM_REGISTRY=https://registry.npmjs.org DEBIAN_MIRROR=http://deb.debian.org bash build-image.sh
```

本机 `npm config set registry ...` 不会自动修改镜像内部配置。镜像用 npm 发布版的预构建包；若上游监听限制发生变化，补丁检查会中止，需审阅新版后再升级。

## 4. 服务器第一次部署

先在 Windows 将修改提交并推送到自己的仓库；本次尚未替你提交或推送：

```powershell
git status
git add -A
git commit -m "Use Docker and account password registration"
git push origin main
ssh root@10.0.9.175
```

检查 `git status` 中没有 `.env`、数据库、用户数据或日志。服务器执行以下命令（目录已存在则进入现有目录，不重复 clone）：

```bash
git clone https://github.com/faxi2017/deepseek-harness-portal.git /home/codes/deepseek-harness-portal
cd /home/codes/deepseek-harness-portal
bash scripts/check-server.sh
npm ci --prefix portal
bash build-image.sh
cp .env.example .env
chmod 600 .env
nano .env
```

将服务器配置改成：

```dotenv
NODE_ENV=production
DOMAIN=10.0.9.175
HOST=0.0.0.0
PORTAL_ORIGIN=http://10.0.9.175:7000
PORT=7000
INSTANCE_ROUTING=ports
INSTANCE_PORT_START=7001
COOKIE_DOMAIN=
ADMIN_NAME=admin
ADMIN_PASSWORD=填写服务器专用的至少16位密码
DSH_IMAGE=填写服务器构建输出的sha256值
INSTANCE_NETWORK=dsh-portal-tenants
PORT_RANGE_START=18000
PORT_RANGE_END=18100
```

其余资源配置按 `.env.example` 保留。生产模式要求不可变镜像 ID。Windows 与服务器分别构建的 ID 可能不同，应使用各自引擎实际输出的值。

先前台启动看日志：

```bash
bash run-portal.sh
```

手动停止或后台重启：

```bash
bash stop-portal.sh
nohup bash run-portal.sh > /tmp/dsh-portal.log 2>&1 < /dev/null &
tail -n 80 /tmp/dsh-portal.log
```

Windows 浏览器打开 `http://10.0.9.175:7000`。第一个注册用户通常得到 `http://10.0.9.175:7001`，下一个是 `7002`；被占用的内部端口会跳过，不保证始终连续。管理员可从 Instances 的 Open 按钮进入实例。

确认成功后 Ctrl+C，安装仓库中的 systemd 服务：

```bash
install -m 644 scripts/dsh-portal.service /etc/systemd/system/dsh-portal.service
systemctl daemon-reload
systemctl enable --now dsh-portal
systemctl status dsh-portal --no-pager
journalctl -u dsh-portal -n 80 --no-pager
```

模板采用服务器现有 root + Docker，工作目录固定 `/home/codes/deepseek-harness-portal`，Node 路径为已检查的 `/usr/bin/node`。只启动一个 Portal 进程。若改部署路径或账号，同步修改服务文件；拥有 Docker socket 权限的账号实质上具有宿主机高权限。

端口说明：7000 是 Portal；默认 7001–7101 是由 Portal 提供鉴权的用户入口，共 101 个槽位。18000–18100 仅绑定宿主机回环，用于代理访问容器，不要对外开放。若服务器防火墙或网络 ACL 阻止访问，只对实际试用网段放行 7000–7101/TCP；不要改动其他现有服务规则。

## 5. 后续 Windows 修改 → 服务器更新 → 试用

Windows：

```powershell
cd F:\ai-demo\deepseek-harness-portal
npm test --prefix portal
git add -A
git commit -m "Describe your change"
git push origin main
ssh root@10.0.9.175
```

服务器：

```bash
cd /home/codes/deepseek-harness-portal
git status --short
git rev-parse HEAD
systemctl stop dsh-portal
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
tar -czf "backups/portal-$stamp.tgz" .env portal/data
git pull --ff-only origin main
npm ci --prefix portal
npm test --prefix portal
systemctl start dsh-portal
journalctl -u dsh-portal -n 60 --no-pager
```

第一次备份前应已成功启动过 Portal（`portal/data` 存在）。这里备份 `.env` 和 SQLite；不包含 Docker 用户卷。`DATA_DIR` 若自定义，应替换备份路径。记录更新前 commit，更新失败先恢复代码及兼容的数据，再启动旧版。拉取出现冲突应处理冲突，不能用 reset 强行丢弃服务器改动。

只改 Portal 不必重建 DSH 镜像。启动成功后在 Windows 刷新 `http://10.0.9.175:7000`，用新账号注册或登录现有账号检查；再进入用户端口验证 DSH。用户数据保留在服务器，不能同步 Windows 的 node_modules、SQLite 或 `.env` 覆盖服务器。

没有推送 Git 时也可以传源码，但长期使用上面的 Git 流程更容易确认服务器到底运行哪个版本。

## 6. 升级 DSH 和保留用户数据

管理员进入“DSH 版本”，输入 `latest` 或明确的 npm 版本号构建受控镜像。构建沿用本项目的 Dockerfile（包含监听补丁和安全启动脚本），不会在任一用户容器中执行全局 `npm update`。构建完成后先将一个测试用户升级到目标版本；确认插件、模型网关和工作流正常，再逐个或分批升级其他实例。设置“新用户默认”只影响之后注册的用户，不会自动改变已有实例。

每次升级都会停止该实例、备份其 home 和 workspace 卷到仅供 Portal 使用的 Docker 卷，然后以目标不可变镜像重新创建容器并执行 HTTP 健康检查。失败时系统会恢复升级前镜像和两个数据卷；成功记录也保留可回退快照。实例管理的“DSH 版本”可查看记录并执行手动回退；管理员可按版本单独开放个人自助升级。升级快照会随“删除实例/用户”一并删除。

旧镜像和快照是回退前提，请勿在验证期运行会清理项目卷或镜像的全局 Docker 清理命令。即使自动回退成功，也应在新版本上先做灰度验证：未来 DSH 可能引入外部服务、插件或数据格式兼容性变化。

## 7. 当前限制与排查

- 注册和密码登录不再需要邮箱、SMTP 或验证码。管理员设置保留邀请码、注册开关；密码登录始终可用，避免关闭后无人能登录。数据库保留旧邮箱列、OTP 表及旧兼容模块，不会继续暴露邮箱接口；已有仅邮箱账号需要补充用户名和密码后才能迁移使用。
- 每用户可写 `/home/dsh` 和 `/workspace`，容器系统目录只读。“任意插件”若要求 root、apt 安装或访问内网服务，需要管理员调整镜像/网络策略；普通 DSH 插件保存在各自用户卷。
- 模型网关已接入 Bifrost，管理员可统一配置模型 Key、子用户日 Token 额度和用量统计，同时保留用户自带模型。启用方式、数据备份和兼容边界见 `MODEL_GATEWAY.md`。仅对租户放行指定 IP 的 7999 模型入口，Bifrost 管理端口 14000 仅监听回环，原有私网隔离继续生效。
- HTTP 内网试用能登录，但凭证未加密；某些浏览器功能（剪贴板、麦克风等）需要 HTTPS。正式部署应增加 TLS。
- Docker 被重启后重启 Portal，重新验证网络规则。若报 DOCKER-USER 不存在，需检查 Docker iptables 后端；不要通过关闭隔离绕过。当前未支持 rootless Docker 或 Docker 原生 nftables 后端。
- 7000 或用户端口被占用会导致启动失败；检查监听，调整成互不重叠的端口范围。当前默认启动全部 101 个用户入口监听，可缩小 `PORT_RANGE_END`。
- 修改 ADMIN_PASSWORD 后旧密码仍有效：管理员只在首次启动创建；应在 Profile 中修改密码。忘记密码时由管理员在 Users 页点击 Reset password。
- DSH 启动日志若提示 `--expose-internals`：使用项目的新镜像启动脚本，不要手工替换成裸 `dsh web`。
- 本次尚未将 Portal 正式部署为服务器服务，也未推送代码；先完成本地验收，再按本文部署。
