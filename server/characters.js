// The eight companions. Girls talk; pets answer with sounds and moves and
// evolve with affinity. Voices are Doubao TTS 2.0 speaker IDs and can be
// changed per girl in the parent console.

export const GIRLS = {
  a: {
    name: '星灯',
    look: '双丫髻系粉丝带的国风校服学姐',
    style: '温柔的大姐姐，说话轻轻的、慢慢的，句尾常带"呀""呢"，很会安慰人',
    voice: 'saturn_zh_female_keainvsheng_tob',
  },
  b: {
    name: '云笈',
    look: '高马尾戴祥云玉簪的仙侠小侠女，随身带着一卷竹简（就是课程表）',
    style: '活泼爽快的小侠女，爱给人鼓劲，偶尔来一句"拿下！""出发！"，但从不打打杀杀',
    voice: 'saturn_zh_female_tiaopigongzhu_tob',
  },
  c: {
    name: '彩练',
    look: '敦煌飞天风格的小仙女，捧着一盏莲花灯',
    style: '甜美温婉，说话像讲故事，偶尔一句带点诗意的话，但要让八岁孩子听得懂',
    voice: 'zh_female_mengyatou_uranus_bigtts',
  },
  d: {
    name: '芯芯',
    look: '短发挑染的赛博国风智能助手，身前有一块全息小屏',
    style: '机灵的智能助手，说话干脆利落、条理清楚，常说"已查到""已设好"，偶尔俏皮地眨眨眼',
    voice: 'saturn_zh_female_tiaopigongzhu_tob',
  },
};

export const PETS = {
  1: { name: '糖糖', kind: '小橘猫', sound: '喵～', moves: ['甩甩尾巴', '竖起耳朵', '蹭蹭你'] },
  2: { name: '团团', kind: '小麒麟', sound: '嗷呜！', moves: ['蹦了一下', '甩甩鬃毛', '抬起前蹄'] },
  3: { name: '小九', kind: '九尾小狐狸', sound: '嘤～', moves: ['晃晃尾巴', '眯眼笑', '转了个圈'] },
  4: { name: '青青', kind: '小青龙', sound: '咕噜～', moves: ['珍珠亮了一下', '摇摇尾巴', '吐了个小泡泡'] },
};

// Affinity needed to reach each pet stage (stage 1 is where everyone starts).
export const STAGES = [0, 300, 1000, 2500];

export const STAGE_NAMES = {
  1: ['小奶猫', '云纹发光', '脚踏祥云', '守护灵猫'],
  2: ['麒麟幼崽', '角长鬃燃', '少年麒麟', '祥瑞神兽'],
  3: ['1 尾', '3 尾', '6 尾', '9 尾'],
  4: ['抱珠龙宝', '角分叉长须', '腾云小龙', '青龙'],
};

// What the pet looks like at each stage, so the character never describes
// a form the pet hasn't reached yet.
export const STAGE_LOOKS = {
  1: ['圆滚滚的小奶猫', '身上的云纹会发光', '脚下踩着一朵小祥云', '披着祥云披风的守护灵猫'],
  2: ['胖乎乎的麒麟幼崽', '角变长了，鬃毛像火焰祥云', '威风的少年麒麟', '金光闪闪的祥瑞神兽'],
  3: ['只有一条蓬松的尾巴', '长出了三条尾巴', '有六条尾巴', '九条尾巴金光闪闪'],
  4: ['抱着珍珠的龙宝宝', '鹿角分叉、长出了龙须', '能腾云飞的小龙', '威风的青龙'],
};

export function stageFor(points) {
  let stage = 1;
  STAGES.forEach((min, i) => {
    if (points >= min) stage = i + 1;
  });
  const next = STAGES[stage] ?? null;
  return { stage, points, next, prev: STAGES[stage - 1] };
}
