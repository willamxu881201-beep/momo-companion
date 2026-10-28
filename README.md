# MoMo 的云端伙伴

住在平板里的 AI 伙伴，陪 8 岁的沫沫（MoMo）自己管好每一天：

- **记得课程表**：学校按 D1–D6 轮换，问"明天上什么课""下周一呢"，伙伴按课表回答，不会编造。
- **提醒当天的任务**：到点开口提醒；15 分钟后还没开始，再温柔地提醒一次。
- **好感度进化**：任务做完、妈妈确认后才涨好感度，宠物随之进化（比如小九的尾巴从 1 条长到 9 条）。
- **说话就能用**：问课程、说"作业写完了"、"明天七点叫我起床"都行。
- **8 个伙伴自由搭配**：4 个少女（星灯、云笈、彩练、芯芯）负责说话，4 个宠物（糖糖、团团、小九、青青）负责陪伴和进化。
- **会动、有表情**：少女待机和说话时是循环动画，想事情、开心、欢呼、担心、犯困各有表情；宠物 4 个阶段各有一段动画，还有开心和睡觉的样子。平板放不了视频时自动换成静态图。

## 用到的服务

| 用途 | 服务 |
|---|---|
| 判断要做什么（查课表、记完成、定闹钟） | 火山方舟 `doubao-seed-2-1-lite` |
| 伙伴说话 | 火山方舟 `doubao-seed-character` |
| 听懂沫沫说的话 | 火山方舟 `doubao-seed-2-0-mini`（语音输入） |
| 伙伴的声音 | 豆包语音 2.0（没配置时用平板自带的声音） |

服务器只需要 Node.js（22.13 以上），不用装任何 npm 包；数据存在一个 SQLite 文件里。

## 第一次部署（火山引擎 Ubuntu 24.04）

以下命令都在 ECS Terminal 里，用 root 运行。

**1. 装 Node.js、git、Caddy**（装过就跳过）

```bash
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -y && apt-get install -y git curl gnupg debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
```

**2. 拉代码**

```bash
git clone https://github.com/willamxu881201-beep/momo-companion /opt/momo-companion
```

仓库如果设成了私有，需要先给服务器一个只读的部署密钥，见文末「私有仓库」。

**3. 运行安装脚本**（把域名换成你的；没有域名就用 `IP 用横线连接.sslip.io`）

```bash
bash /opt/momo-companion/deploy/install.sh 101-47-157-111.sslip.io
```

**4. 填密码和 Key**

```bash
nano /etc/momo/momo.env
```

填好 `PARENT_PASSWORD`（家长后台密码）、`ARK_API_KEY`，有豆包语音就填 `DOUBAO_APPID` 和 `DOUBAO_TOKEN`。按 `Ctrl+O` 回车保存，`Ctrl+X` 退出，然后：

```bash
systemctl restart momo
```

这个文件只有 root 能读，密钥不会出现在代码和网页里。

**5. 打开家长后台** `https://你的域名/parent`，登录后：

1. **课表**：填"某一天是 D 几"、每个 D 的课程、假期。
2. **任务**：添加每天的事（写作业 16:00、练琴 17:00……）。
3. **平板**：复制「孩子页面的链接」，在平板或手机上打开。几台设备都能用同一个链接；链接里带着一把钥匙，不要发到群里，万一发出去了就点「换一个新链接」，旧链接马上失效。

**6. 平板上**：打开孩子页面的链接，点「叫醒伙伴」。打开过一次以后，这台设备直接打开 `https://你的域名/` 也能进。建议：
- 用 Chrome 打开，菜单里「添加到主屏幕」，以后像 App 一样全屏打开。
- 第一次说话时允许使用麦克风。
- 平板接上充电，页面开着就会到点提醒。

## 日常更新

```bash
cd /opt/momo-companion && git pull && systemctl restart momo
```

看日志：`journalctl -u momo -n 50 --no-pager`

备份数据：复制 `/var/lib/momo/momo.db`。

## 好感度规则

| 怎么得到 | 加多少 |
|---|---|
| 妈妈确认一件任务完成 | +10 |
| 这件任务是按计划时间做完的 | 再 +5 |
| 早上（5:00–10:00）或晚上（19:00–22:30）第一次和伙伴说话 | +3 |
| 聊天 | 每次 +1，每天最多 +5 |

好感度只涨不跌，换伙伴也不清零。宠物在 300、1000、2500 点时进化到第 2、3、4 阶段。

妈妈在后台确认任务后，平板上的伙伴会马上夸沫沫，并说出加了多少好感度；宠物进化时会发光，伙伴会宣布它的新样子。

## 隐私和费用

- 不保存录音；聊天记录只在内存里留 20 分钟，用来接上下文，不写进数据库。
- 每天有用量上限（默认对话 80 次、语音识别 150 次、配音 2 万字），在 `/etc/momo/momo.env` 里可以改。
- 安静时间（默认 21:30–6:30）不发任务提醒，闹钟照常响。少女和宠物换成睡觉的样子；这时妈妈确认任务，平板只更新数字，不出声，宠物进化等到早上再宣布。

## 私有仓库

仓库设为私有后，服务器拉代码需要一个只读部署密钥：

```bash
ssh-keygen -t ed25519 -f /root/.ssh/momo_deploy -N "" -C momo-server
cat /root/.ssh/momo_deploy.pub
```

把输出的那一行加到 GitHub 仓库的 Settings → Deploy keys（不要勾选写权限），然后：

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/momo_deploy
EOF
cd /opt/momo-companion && git remote set-url origin git@github.com:willamxu881201-beep/momo-companion.git
```

## 开发

```bash
npm test                                   # 单元测试
PARENT_PASSWORD=test ARK_API_KEY=… npm start   # 本地运行，打开 http://127.0.0.1:8080/parent
```

| 目录 | 内容 |
|---|---|
| `server/schedule.js` | D1–D6 轮换计算（跳过周末、假期，支持手动指定某天） |
| `server/brain.js` | 两步对话：先判断要不要查课表/记任务/定闹钟，再让伙伴说话 |
| `server/family.js` | 课表、任务、闹钟、好感度的规则 |
| `server/events.js` | 到点提醒和闹钟，通过 SSE 推送到平板 |
| `server/http.js` | 网页和接口 |
| `web/` | 孩子页面（`kid.*`）、家长后台（`parent.*`） |
| `web/img/`、`web/vid/` | 少女和宠物的图片（6 种表情、4 个进化阶段）和 5 秒循环动画（720×960，首尾同一帧） |
| `deploy/` | 安装脚本、systemd 服务、Caddy 配置 |
| `design/` | 主界面的备选方案（庭院、书房、云海的场景图和抠图脚本），说明见 `design/README.md` |
