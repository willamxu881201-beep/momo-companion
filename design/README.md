# 主界面的备选方案

现在上线的是方案 A「晕染」的布局（磨砂玻璃、少女全身居中、宠物绕着她走动），背景换成了跟着任务走的场景（`web/img/scene/`，见 `server/activity.js`）：空闲时在庭院（方案 B）或云海（方案 D），写作业去书房，练琴去琴房，运动去运动馆或公园，睡觉在卧室；原来的彩色渐变也还能选。

场景图都是 Seedream 5.0 生成的（1920×1200，约 ¥0.3 一张）：白天的先生成，要求地面开阔、中间空出来给角色站，主要的家具放在左边（横屏时右边是任务栏）；夜景拿白天那张当参考改光线，构图完全一致，昼夜可以直接淡入淡出。书房为了全身的少女重画过（原来那张书桌横在画面最下方）。

最早的三组方案：

| 方案 | 场景 | 角色怎么放 |
|---|---|---|
| B 庭院 | `scenes/courtyard_day.webp`、`courtyard_night.webp` | 抠成透明，站在月洞门前 |
| C 书房 | `scenes/study_day.webp`、`study_night.webp` | 抠成透明，站在圆窗前；任务是软木板上的便签 |
| D 云海 | `scenes/sky_day.webp`、`sky_night.webp` | 抠成透明，场景里的云层盖在腰上 |

- `homescreens.html`：四组方案的可操作样稿（已发布为 Claude 页面，素材路径按那个页面写的）。
- 场景图由豆包 Seedream 5.0 生成，夜景是拿白天那张当参考改的，所以构图完全一致，昼夜可以直接淡入淡出。

## 抠图

两个脚本都用 [rembg](https://github.com/danielgatis/rembg) 的 `isnet-general-use` 模型（第一次运行会自动下载，约 170 MB），在 CPU 上就能跑，不花钱：

```bash
python3 -m venv .venv && .venv/bin/pip install "rembg[cpu]"

# 静态图：输出带透明背景的 WebP，边缘去掉了原来底色的残留
.venv/bin/python design/tools/cut_stills.py out/sprites 960 web/img/girl_b.jpg web/img/pet/3_2.jpg

# 动画：输出“上半是画面、下半是透明度”的 MP4，所有平板都能播，页面里用 WebGL 合成
.venv/bin/python design/tools/alpha_loop.py web/vid/girl_b_idle.mp4 out/girl_b_idle_alpha.mp4 /tmp/work
```

一段 5 秒的动画约 2 分半；24 段全部处理完约 1 小时。合成用的 WebGL 代码在 `homescreens.html` 末尾（搜索 `alphaSrc`）。

## 全身像和循环动画（现在上线的）

少女的全身像是 Seedream 5.0 生成的：先拿 `web/img/girl_{a,b,c,d}.jpg` 当参考画全身站立像（1344×1792，纯色背景，头顶和脚下留白），再拿这张全身像当参考改出 5 个姿势（开心、欢呼、思考、犯困、担心），约 ¥0.3 一张。

```bash
# raw/ 里放 fb_<g>.jpg（全身像）、<g>_<姿势>.jpg（还有早先用的 <g>_m1/m2/blink.jpg）
.venv/bin/python design/tools/full_body.py raw web/img/full 1440
```

每张抠成透明 WebP（同 `cut_stills.py`），位置写进 `sprites.json`：嘴、脸、身体、脚在哪儿。页面靠它放对话框、让宠物绕着脚走。（这个脚本还会做嘴型和眨眼的小贴片，那是改成动画以前用的，页面已经不用了。）

### 少女的循环动画

站着不动时和说话时各一段，用 Seedance 2.0 生成：首帧和尾帧都是全身像，5 秒，720p，约 ¥5 一段，4 个少女 8 段约 ¥40。提示词要她双脚站在原地、镜头固定、结尾回到开头的姿势。

Seedance 的镜头还是会有一点漂，所以每段再处理一遍：

```bash
.venv/bin/pip install opencv-python-headless
.venv/bin/python design/tools/full_loop.py raw/fb_b_talk.mp4 web/vid/full/b_talk.mp4 960
```

- 用她腰以下（腿、裙子、鞋，基本不动的地方）的特征点，算出每一帧相对第一帧的缩放和平移，平滑后抵消掉，脚就固定在同一个位置，身体自然的晃动和手势保留。
- 每帧抠图、透明度在前后帧之间平滑（首尾相接）、边缘去色，输出"上半是画面、下半是透明度"的 H.264（720×1920），每段 1 MB 左右。页面里 `companion.js` 的 `AlphaLoop` 用 WebGL 把两半合成，安静和说话两段之间淡入淡出。
- 一段 5 秒的动画处理约 3–6 分钟（4 核 CPU）。

### 宠物走路

会走路的 12 个形态（猫 1–2、麒麟 1–4、狐狸 1–4、龙 1–2）：先用 Seedream 拿宠物原图当参考，画侧身朝右、迈着步的样子（1792×1344），挑一张；再用 Seedance 2.0 生成原地走路的循环（镜头跟着它，480p，5 秒，约 ¥2.3 一段）。踩在祥云上的形态（猫 3–4、龙 3–4）不用走路动画，移动时轻轻飘着。

```bash
.venv/bin/python design/tools/full_loop.py raw/walk_3_1.mp4 web/vid/walk/3_1.mp4 420 pet   # 用头和身体对齐（腿在动）
.venv/bin/python design/tools/walk_manifest.py web/vid/walk web/img/pet/sprite web/vid/walk/walks.json
```

`walks.json` 记着每段的宽高比、该画多大（走路的样子画成坐着时的九成高）、脚在哪儿，这样宠物从坐着变成走路时大小差不多、脚踩在同一个点上。
