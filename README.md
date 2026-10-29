# MoMo 的云端伙伴

住在平板里的 AI 伙伴，陪 8 岁的沫沫（MoMo）自己管好每一天：

- **记得课程表**：学校按 D1–D6 轮换，问"明天上什么课""下周一呢"，伙伴按课表回答，不会编造。
- **提醒当天的任务**：到点开口提醒；15 分钟后还没开始，再温柔地提醒一次。
- **好感度进化**：任务做完、妈妈确认后才涨好感度，宠物随之进化（比如小九的尾巴从 1 条长到 9 条）。
- **说话就能用**：问课程、说"作业写完了"、"明天七点叫我起床"都行。
- **8 个伙伴自由搭配**：4 个少女（星灯、云笈、彩练、芯芯）负责说话，4 个宠物（糖糖、团团、小九、青青）负责陪伴和进化。
- **会动、有表情**：少女全身站在画面中间，是两段循环动画：安静站着时轻轻呼吸、眨眼、头发飘动，说话时边说边做小手势，声音一停就回到安静的样子；想事情、开心、欢呼、担心、犯困各有一个姿势。
- **宠物有自己的生活**：平时绕着少女走来走去（四条腿真的在迈步，踩着祥云的形态是飘着走），会绕她跑一圈（从她身后穿过去）、躲到她背后再从腿边探出头、蹦跳、东张西望，一阵子没人理就打个盹，晚上睡在她脚边。沫沫说话时它跑到前面听，少女想事情时它在旁边歪着头，少女说话时它凑过来仰头听，有好消息一起跳；点它会跳起来，连点三下少女会说说它，点少女它也会跑过去。
- **拍照给伙伴看**：沫沫和妈妈都能拍照或发文件（照片、截图、PDF）。课程表会自动更新到课表里；老师发的作业清单会自动加到今天的任务；一页作业题，伙伴会一步一步引导沫沫想，不直接给答案。
- **妈妈也有伙伴**：妈妈的页面和沫沫的一样，是同一个伙伴，可以说话或打字问她"沫沫作业写完了吗"，让她"告诉沫沫七点前练琴"；沫沫说"帮我告诉妈妈…"，妈妈那边也会马上听到。右边是今天的任务（点一下就能确认）、今天的动态和照片。原来的后台设置放在「管理」里。
- **看看沫沫**：妈妈点「在做什么」「在练琴吗」「看看坐姿」，平板会先说一声、角落里显示摄像头画面，然后拍一张照片（练琴还会听几秒声音），伙伴把看到的告诉妈妈；坐姿不对，还会温柔地提醒沫沫。
- **推送到妈妈手机**（可选）：妈妈的页面没打开时，沫沫让转告的话、「看看沫沫」的结果、做完等确认的任务，会推送到妈妈的微信（或别的推送服务）。

## 用到的服务

| 用途 | 服务 |
|---|---|
| 判断要做什么（查课表、记完成、定闹钟） | 火山方舟 `doubao-seed-2-1-lite` |
| 伙伴说话 | 火山方舟 `doubao-seed-character` |
| 听懂沫沫说的话 | 豆包「录音文件识别极速版」（开通了就用，最快）；没开通时用火山方舟 `doubao-seed-2-0-mini` |
| 伙伴的声音 | 豆包语音 2.0（没配置时用平板自带的声音） |
| 看照片、文件和平板拍的照片 | 火山方舟 `doubao-seed-2-1-pro` |
| 和妈妈对话 | 火山方舟 `doubao-seed-2-1-lite` |

服务器只需要 Node.js（22.13 以上），不用装任何 npm 包；数据存在一个 SQLite 文件里。读 PDF 用到 poppler（安装脚本会自动装）。

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

**5. 打开妈妈的页面** `https://你的域名/parent`，用家长密码登录，点「管理」：

1. **课表**：填"某一天是 D 几"、每个 D 的课程、假期。也可以直接把课程表拍照发给伙伴（📷），她会自动填好。
2. **每天的任务**：添加每天的事（写作业 16:00、练琴 17:00……）。只做一次的事直接跟伙伴说，老师的作业清单拍照发给她就行。
3. **平板**：复制「孩子页面的链接」，在平板或手机上打开。几台设备都能用同一个链接；链接里带着一把钥匙，不要发到群里，万一发出去了就点「换一个新链接」，旧链接马上失效。

**6. 平板上**：打开孩子页面的链接，点「叫醒伙伴」。打开过一次以后，这台设备直接打开 `https://你的域名/` 也能进。建议：
- 用 Chrome 打开，菜单里「添加到主屏幕」，以后像 App 一样全屏打开。
- 第一次说话时允许使用麦克风；妈妈第一次要「看看沫沫」时，平板会问能不能用摄像头，点允许。
- 平板接上充电，页面开着就会到点提醒。

## 手机推送（可选）

妈妈的页面没打开时，伙伴可以把这些推送到手机：沫沫让伙伴转告的话、「看看沫沫」的结果、沫沫说做完了的任务（等你确认）、沫沫发来的照片（只推一句话，不推照片）。几件事挨得很近会合成一条；页面开着时不推，因为页面上伙伴已经说了。

选一个推送服务，拿到它给你的地址，在服务器上加到 `/etc/momo/momo.env` 里：

```bash
nano /etc/momo/momo.env
# 加一行，比如：
# NOTIFY_URL=https://wxpusher.zjiecode.com/api/send/message/SPT_你的SPT
systemctl restart momo
```

然后在妈妈页面点「管理 → 平板 → 发一条测试推送」，看手机收到没有。

| 服务 | 推到哪里 | `NOTIFY_URL` 怎么写 |
|---|---|---|
| WxPusher 极简推送 | 微信 | `https://wxpusher.zjiecode.com/api/send/message/SPT_你的SPT`（在 WxPusher 文档的「极简推送」里用微信扫码拿到 SPT） |
| Server酱 | 微信 | `https://sctapi.ftqq.com/你的SendKey.send`（免费版每天只能推几条） |
| PushPlus | 微信 | `https://www.pushplus.plus/send?token=你的token` |
| 企业微信、钉钉、飞书的群机器人 | 群聊 | 机器人的 Webhook 地址原样填（钉钉的安全设置选「IP 地址」，填服务器的 IP） |
| Bark | iPhone | `https://api.day.app/你的key` |
| ntfy | ntfy App（安卓、iPhone） | `https://ntfy.sh/你起的频道名`（名字起长一点，别人猜不到） |
| Telegram | Telegram | `https://api.telegram.org/bot机器人的token/sendMessage?chat_id=你的ID` |

- 想少收一些：`NOTIFY_KINDS=message,check`（`message` 沫沫的留言，`check` 看看沫沫的结果，`done` 做完的任务，`photo` 沫沫发来的照片；不填就是全部）。
- 每天最多推 30 条，`NOTIFY_PER_DAY` 可以改。
- 这个地址里带着你在推送服务的密钥，和其他 Key 一样只填在服务器上，不要发给别人。推送的那一两句话会经过你选的服务。

## 日常更新

```bash
cd /opt/momo-companion && git pull && systemctl restart momo
```

看日志：`journalctl -u momo -n 50 --no-pager`

备份数据：复制 `/var/lib/momo/momo.db`（照片在 `/var/lib/momo/files`，7 天后自动删除）。

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

- 不保存录音；聊天记录只在内存里留 20 分钟，用来接上下文，不写进数据库。妈妈问起时，伙伴只知道沫沫做了什么事（任务、照片、传的话），不知道聊天的原话。
- 照片（发给伙伴的和平板拍的）只存在自己的服务器上，7 天后自动删除，只有登录了家长密码才能看。平板拍照前伙伴会先说一声，拍照时屏幕角上一直显示摄像头画面，不会偷偷拍；平板没打开就拍不了。
- 每天有用量上限（默认沫沫对话 80 次、妈妈对话 80 次、语音识别 150 次、配音 2 万字、看照片 60 次），在 `/etc/momo/momo.env` 里可以改。
- 开了手机推送的话，推送的那一两句话会经过你选的推送服务（不含照片和录音）。
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

改了页面以后，跑一下浏览器检查。每次会起一个临时的本地服务器（全新的数据库、随机的家长密码、不带任何 Key），用 Chromium 打开页面检查，截图和服务器日志放在 `tools/browser/out/`。第一次要装 Playwright：`npm install --no-save playwright && npx playwright install chromium`。

| 命令 | 检查什么 |
|---|---|
| `tools/browser/run.sh devices` | 沫沫的页面在 11 种屏幕上（小手机到电脑）：不横向滚动，气泡不挡她的脸和宠物的头，按钮在第一屏 |
| `tools/browser/run.sh mom` | 妈妈的页面：登录、测试推送、慢的回答先应一声、看看沫沫（假摄像头）和沫沫页面上的次数、页面没开时推送到手机、开着时不推（约 2 分钟） |
| `tools/browser/run.sh voice` | 伙伴的声音：边生成边播没有断点，隔几秒才回答也能出声（华为浏览器的规矩），说话的动作跟着声音 |
| `tools/browser/run.sh e2e --real` | 用真的模型走一遍：看坐姿、拍作业问第三题（不给答案）、妈妈发作业清单、互相传话、妈妈问今天的作业。需要环境变量里有 `ARK_API_KEY`，花几分钱 |

| 目录 | 内容 |
|---|---|
| `server/schedule.js` | D1–D6 轮换计算（跳过周末、假期，支持手动指定某天） |
| `server/brain.js` | 和沫沫：先判断要不要查课表/记任务/定闹钟/转告妈妈，再让伙伴说话（看过的作业题也在她心里）；和妈妈：查记录、让平板看一眼、传话、加任务 |
| `server/vision.js`、`server/eyes.js` | 读照片和文件（课程表、作业清单、作业题）并照着办；妈妈要看沫沫时让平板拍照、读照片 |
| `server/post.js` | 妈妈和沫沫之间传的话（平板没开或在安静时间就先存着） |
| `server/notify.js` | 妈妈的页面没打开时，推送到手机（WxPusher、Server酱、PushPlus、群机器人等） |
| `server/files.js` | 照片存 7 天、PDF 转成图片 |
| `server/family.js` | 课表、任务、闹钟、好感度的规则 |
| `server/events.js` | 到点提醒和闹钟、转告留言，通过 SSE 推送到平板和妈妈的页面 |
| `server/http.js` | 网页和接口 |
| `web/companion.js` | 两个页面共用的伙伴：少女和宠物、对话气泡、声音、听写、拍照 |
| `web/kid.*`、`web/parent.html` + `web/mom.*` + `web/admin.*` | 沫沫的页面；妈妈的页面（`/parent`），里面的「管理」 |
| `web/vid/full/` | 少女的全身循环动画（安静、说话各一段，上半是画面、下半是透明度），页面用 WebGL 合成 |
| `web/vid/walk/` | 宠物走路的循环动画，`walks.json` 记着每个的大小和脚的位置 |
| `web/img/full/` | 少女的全身抠图（1080×1440 透明 WebP）：基础图和 5 个姿势，位置记在 `sprites.json` |
| `web/img/pet/sprite/` | 宠物抠图（4 个进化阶段，各有平常、开心、睡觉三种样子） |
| `web/img/`、`web/vid/` | 半身像（开始页和选伙伴时用）；早先的表情图和半身循环动画，留作备用 |
| `deploy/` | 安装脚本、systemd 服务、Caddy 配置 |
| `tools/browser/` | 浏览器检查（见上） |
| `design/` | 主界面的备选方案（庭院、书房、云海的场景图和抠图脚本），说明见 `design/README.md` |
