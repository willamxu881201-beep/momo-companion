# 主界面的备选方案

现在上线的是方案 A「晕染」：角色动画保留原来的底色，边缘柔化，页面背景是少女和宠物两种底色的渐变（见 `web/kid.css`）。

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
