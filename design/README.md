# 主界面的备选方案

现在上线的是方案 A「晕染」：页面背景是少女和宠物两种底色的渐变，两个角色抠成透明站在上面——少女全身居中，宠物绕着她走动（见 `web/kid.css`、`web/kid.js`）。

另外三组方案先存在这里，以后想换时直接用：

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

## 全身像（现在上线的）

少女的全身像也是 Seedream 5.0 生成的：先拿 `web/img/girl_{a,b,c,d}.jpg` 当参考画全身站立像（1344×1792，纯色背景，头顶和脚下留白），再拿这张全身像当参考，各改出 3 张只动嘴或眼睛的（`m1` 说“哦”、`m2` 说“啊”、`blink` 闭眼）和 5 个姿势（开心、欢呼、思考、犯困、担心），一个少女 9 张，约 ¥0.3 一张。

模型每次重画都会有细微差别，所以嘴型和眨眼不整张替换，而是只取变化的部分做成小贴片：

```bash
# raw/ 里放 fb_<g>.jpg（全身像）、<g>_m1.jpg、<g>_m2.jpg、<g>_blink.jpg、<g>_<姿势>.jpg
.venv/bin/python design/tools/full_body.py raw web/img/full 1440
```

- 每张抠成透明 WebP（同 `cut_stills.py`），缩到 1440 高。
- 嘴型贴片：找出嘴巴变化最大的位置，在它周围的椭圆里取“改过的图和原图的差别”，边缘羽化，不会带出整张图的细微偏差。
- 眨眼贴片：闭眼时模型常把眉毛一起压低，所以贴片连眉毛一起取。
- 位置写进 `sprites.json`：每个贴片放在哪，以及嘴、脸、身体、脚的位置。页面靠它对口型、放对话框、让宠物绕着脚走。

宠物抠图直接用 `cut_stills.py`：`… cut_stills.py out 640 web/img/pet/*.jpg`，再按 `{宠物}_{阶段}[_happy|_sleepy].webp` 放进 `web/img/pet/sprite/`。
