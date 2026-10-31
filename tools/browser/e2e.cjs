// End to end with the real models (run.sh e2e --real; costs a few fen): MoMo's tablet
// and Mom's page side by side.
//  1. Mom looks at MoMo's posture: the tablet says so and takes a picture (Chromium's
//     fake camera: a test pattern, so the model should say it can't see her).
//  2. MoMo shows a page of maths homework and asks about problem 3: she is led to it,
//     not given the answer (288).
//  3. Mom sends the teacher's homework list: it becomes today's tasks, MoMo is told.
//  4. Messages both ways.
//  5. Mom asks about the day.
// The pictures are drawn here (text only); what everyone said is printed at the end.
const fs = require('node:fs');
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, waitSaid, nextSaid, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const expect = (ok, what) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

// A picture of some text, drawn in the page and saved as a JPEG.
async function draw(page, file, { chat, title, lines }) {
  const url = await page.evaluate(({ chat, title, lines }) => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = chat ? '#ededed' : '#fbfaf6';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111';
    if (chat) {
      // A teacher's message in a parents' group chat.
      g.fillStyle = '#f7f7f7';
      g.fillRect(0, 0, c.width, 110);
      g.fillStyle = '#111';
      g.font = '30px sans-serif';
      g.textAlign = 'center';
      g.fillText(title, c.width / 2, 65);
      g.textAlign = 'left';
      g.fillStyle = '#777';
      g.font = '24px sans-serif';
      g.fillText('王老师', 40, 160);
      g.fillStyle = '#5b9bd5';
      g.beginPath();
      g.arc(80, 220, 40, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.roundRect(140, 180, 720, 120 + lines.length * 85, 16);
      g.fill();
      g.fillStyle = '#111';
      g.font = '32px sans-serif';
      lines.forEach((l, i) => g.fillText(l, 170, 240 + i * 85));
    } else {
      g.font = 'bold 40px sans-serif';
      g.textAlign = 'center';
      g.fillText(title, c.width / 2, 100);
      g.textAlign = 'left';
      g.font = '32px sans-serif';
      lines.forEach((l, i) => g.fillText(l, 60, 220 + i * 110));
    }
    return c.toDataURL('image/jpeg', 0.9);
  }, { chat, title, lines });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

(async () => {
  const errors = [];
  const momB = await chromium.launch();
  const kidB = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const momCtx = await momContext(momB, { viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true });
  const link = await kidLink(momCtx);

  const kidCtx = await kidB.newContext({ viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
  await kidCtx.addInitScript(...voiceStub(1200));
  const kid = await kidCtx.newPage();
  watchErrors(kid, 'kid', errors);
  await kid.goto(link);
  await kid.waitForSelector('#start:not([hidden])');
  await kid.tap('#startBtn');
  await nextSaid(kid, 0);
  log('kid page up');

  await momCtx.addInitScript(...voiceStub(1200));
  const mom = await momCtx.newPage();
  watchErrors(mom, 'mom', errors);
  await mom.goto(`${BASE}/parent`);
  await mom.waitForSelector('#start:not([hidden])');
  await mom.tap('#startBtn');
  await waitSaid(mom, /妈妈好/);
  log('mom page up');

  // 1. A look at MoMo's posture.
  let n = (await said(mom)).length;
  await mom.tap('.rail [data-panel="look"]');
  await mom.tap('button[data-check="posture"]');
  log(`mom: ${await nextSaid(mom, n)}`);
  expect(/坐姿/.test(await waitSaid(kid, /坐姿/)), 'the tablet tells MoMo first');
  await kid.waitForTimeout(600);
  await kid.screenshot({ path: `${OUT}/1_kid_camera.png` });
  const look = await nextSaid(mom, n + 1, 90000);
  log(`mom heard: ${look}`);
  expect(!/照片拍到了，但|没拍到|摄像头没打开/.test(look), 'the picture was taken and read');
  await mom.waitForTimeout(800);
  await mom.screenshot({ path: `${OUT}/1_mom_look.png` });
  await mom.tap('#photoClose').catch(() => {});

  // 2. A page of homework, then a question about problem 3.
  const sheet = await draw(kid, `${OUT}/worksheet.jpg`, {
    title: '三年级数学 第四单元 练习（二）',
    lines: ['一、口算。 24×3=   56÷8=   130+270=   900-450=', '二、竖式计算。（1）326×4   （2）852÷6', '三、学校买了 6 箱粉笔，每箱 48 盒，一共买了多少盒？', '四、小明有 120 元，买了一本 35 元的故事书和', '     一支 18 元的钢笔，还剩多少元？', '五、一个长方形花坛长 12 米，宽 8 米，它的周长是多少米？'],
  });
  n = (await said(kid)).length;
  await kid.setInputFiles('#photoInput', sheet);
  log(`kid photo: ${await nextSaid(kid, n, 90000)}`);
  await kid.tap('#kbd');
  n = (await said(kid)).length;
  await kid.fill('#typeText', '第三题怎么做呀');
  await kid.press('#typeText', 'Enter');
  const help = await nextSaid(kid, n, 60000);
  log(`kid help: ${help}`);
  expect(!/288/.test(help), 'she leads MoMo to problem 3 without giving the answer');
  await kid.waitForTimeout(500);
  await kid.screenshot({ path: `${OUT}/2_kid_tutor.png` });

  // 3. The teacher's homework list, from Mom.
  const day = await mom.evaluate(() => `${new Date().getMonth() + 1}月${new Date().getDate()}日`);
  const list = await draw(mom, `${OUT}/homework.jpg`, {
    chat: true,
    title: '三年级甲班家长群(45)',
    lines: [`【今日作业】${day}`, '1. 语文：抄写第9课生字，每个3遍', '2. 语文：朗读课文《秋天的雨》3遍，家长签名', '3. 数学：练习册第36-37页', '4. 英语：听读 Unit 4 录音 15 分钟', '明天体育课请穿运动鞋。'],
  });
  n = (await said(mom)).length;
  await mom.setInputFiles('#photoInput', list);
  const added = await nextSaid(mom, n, 90000);
  log(`mom photo: ${added}`);
  expect(/作业/.test(added), 'Mom hears the homework was added');
  expect(/妈妈把作业发给我啦/.test(await waitSaid(kid, /妈妈把作业发给我啦/, 30000)), 'MoMo is told about it');
  await kid.waitForTimeout(2500);
  const tasks = await kid.$$eval('#tasks .title', (t) => t.map((x) => x.textContent));
  log(`kid tasks now: ${tasks.join(' | ')}`);
  // After 8 pm it goes to tomorrow's tasks (said with that day's date), not today's.
  if (/\d+月\d+日/.test(added) && !added.includes(day)) log('(added to tomorrow, as it is after 8 pm: not among today\'s tasks)');
  else expect(tasks.some((t) => /练习册/.test(t)), 'the homework is in MoMo\'s tasks');
  await mom.waitForTimeout(800);
  await mom.screenshot({ path: `${OUT}/3_mom_homework.png` });

  // 4. Messages both ways.
  await mom.tap('#kbd');
  n = (await said(mom)).length;
  await mom.fill('#typeText', '告诉沫沫七点前把钢琴练了，妈妈七点半到家');
  await mom.press('#typeText', 'Enter');
  log(`mom: ${await nextSaid(mom, n, 60000)}`);
  expect(/妈妈让我告诉你/.test(await waitSaid(kid, /妈妈让我告诉你/, 30000)), 'MoMo hears Mom\'s words');
  n = (await said(kid)).length;
  await kid.fill('#typeText', '帮我告诉妈妈我想吃饺子');
  await kid.press('#typeText', 'Enter');
  log(`kid: ${await nextSaid(kid, n, 60000)}`);
  expect(/饺子/.test(await waitSaid(mom, /饺子/, 30000)), 'Mom hears MoMo\'s words');

  // 5. Mom asks about the day (a word first if the answer is slow, then the answer).
  n = (await said(mom)).length;
  await mom.fill('#typeText', '沫沫今天有哪些作业？做完了吗？');
  await mom.press('#typeText', 'Enter');
  let answer = await nextSaid(mom, n, 60000);
  if (/^(好的，我看看～|嗯，我查一下哦。|好，我翻翻今天的记录。|稍等，我看一下。)$/.test(answer)) { // see mom.js
    log(`mom (first): ${answer}`);
    answer = await nextSaid(mom, n + 1, 60000);
  }
  log(`mom asked about homework: ${answer}`);
  expect(/语文|数学|英语|练习册|生字/.test(answer), 'the answer is about today\'s homework');
  await mom.waitForTimeout(600);
  await mom.screenshot({ path: `${OUT}/4_mom_chat.png` });
  log(`feed: ${(await mom.$$eval('#feed li .what', (w) => w.map((x) => x.textContent))).join(' | ')}`);

  console.log(`--- MoMo's tablet said:\n${(await said(kid)).join('\n')}`);
  console.log(`--- Mom's page said:\n${(await said(mom)).join('\n')}`);
  await kidB.close();
  await momB.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
