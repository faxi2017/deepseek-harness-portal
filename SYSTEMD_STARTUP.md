# Portal 的 systemd 启动与维护

本文适用于服务器部署目录：`/home/codes/deepseek-harness-portal`。

将 Portal 交给 systemd 后，它会在后台运行并随服务器启动；SSH 终端可正常退出。之后请只用 `systemctl` 管理 Portal，不再运行 `bash run-portal.sh` 或 `bash stop-portal.sh`。

## 以后只要 portal/package.json 或 portal/package-lock.json 有变化，服务器拉取代码后都要重新执行：
```bash
npm ci --prefix portal
```

## 首次切换到 systemd

先确认手工启动的 Portal 已停止，再安装本仓库的服务定义：

```bash
cd /home/codes/deepseek-harness-portal

# 停止当前前台或 nohup 方式启动的 Portal。
bash stop-portal.sh

# 安装服务定义并让 systemd 重新读取。
sudo install -m 644 scripts/dsh-portal.service /etc/systemd/system/dsh-portal.service
sudo systemctl daemon-reload

# 设置开机自启并立即在后台启动。
sudo systemctl enable --now dsh-portal

# 确认服务正常运行并查看最近日志。
sudo systemctl status dsh-portal --no-pager
sudo journalctl -u dsh-portal -n 80 --no-pager
```

`scripts/dsh-portal.service` 已使用当前部署目录。它以 `root` 用户运行，以便继续管理服务器上的 Docker 用户实例；因此 `.env` 和 `portal/data` 不应开放给普通用户。

## 日常管理

```bash
# 重启 Portal，例如更新代码或配置后。
sudo systemctl restart dsh-portal

# 启动、停止及查看状态。
sudo systemctl start dsh-portal
sudo systemctl stop dsh-portal
sudo systemctl status dsh-portal --no-pager

# 查看最近日志；实时跟踪日志时按 Ctrl+C 只会退出日志，不会停止 Portal。
sudo journalctl -u dsh-portal -n 100 --no-pager
sudo journalctl -fu dsh-portal
```

服务异常退出时，systemd 会在 5 秒后自动重启。若不希望随开机启动，可执行：

```bash
sudo systemctl disable --now dsh-portal
```

## 更新项目代码后的重启

更新前先停止服务、备份配置与 SQLite 数据，然后更新依赖、测试并重新启动：

```bash
cd /home/codes/deepseek-harness-portal
sudo systemctl stop dsh-portal

mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
tar -czf "backups/portal-$stamp.tgz" .env portal/data

git pull --ff-only origin main
npm ci --prefix portal
npm test --prefix portal

sudo systemctl start dsh-portal
sudo journalctl -u dsh-portal -n 80 --no-pager
```

如果修改了 `scripts/dsh-portal.service`，重新安装服务文件后再重启：

```bash
cd /home/codes/deepseek-harness-portal
sudo install -m 644 scripts/dsh-portal.service /etc/systemd/system/dsh-portal.service
sudo systemctl daemon-reload
sudo systemctl restart dsh-portal
```

## 常见检查

服务无法启动时，先查看详细状态和日志：

```bash
sudo systemctl status dsh-portal --no-pager -l
sudo journalctl -u dsh-portal -b --no-pager
command -v node
```

服务模板要求 Node 位于 `/usr/bin/node`。如果最后一条命令返回其他路径，请更新 `scripts/dsh-portal.service` 中的 `ExecStart`，重新安装服务文件，并执行 `daemon-reload` 后重启服务。
