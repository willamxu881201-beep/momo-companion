# Makes the sample documents the tests read (made-up school papers, nobody real in
# them). Needs python-docx, openpyxl, python-pptx, Pillow, reportlab and LibreOffice
# (for the old .doc/.xls/.ppt and the PDF); the results are checked in, so the tests
# themselves need none of this.   python3 test/fixtures/make.py
import os, shutil, subprocess, tempfile
from datetime import date
from docx import Document
from docx.shared import Pt
from openpyxl import Workbook
from pptx import Presentation
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
out = lambda name: os.path.join(HERE, name)

# A notice from the class teacher: a heading, paragraphs (one with a bold word in the
# middle, a tab and a line break), a numbered list and a table.
doc = Document()
doc.add_heading('关于举行秋季运动会的通知', level=1)
doc.add_paragraph('各位家长：')
p = doc.add_paragraph('我校定于2026年11月6日（星期五）在学校操场举行秋季')
p.add_run('运动会').bold = True
p.add_run('，请家长提醒孩子做好准备。')
doc.add_paragraph('注意事项：')
for line in ['1. 当天穿运动服和运动鞋，不穿校服。', '2. 自带水壶和毛巾。', '3. 早上7:30到校，下午3:00结束。']:
    doc.add_paragraph(line)
t = doc.add_table(rows=1, cols=3)
for cell, text in zip(t.rows[0].cells, ['项目', '时间', '地点']):
    cell.text = text
for row in [['50米跑', '8:30', '跑道'], ['跳绳', '9:30', '篮球场'], ['接力赛', '14:00', '跑道']]:
    cells = t.add_row().cells
    for cell, text in zip(cells, row):
        cell.text = text
q = doc.add_paragraph('报名截止：')
q.add_run('\t11月3日')
q.add_run().add_break()
q.add_run('三年级甲班 王老师')
doc.save(out('notice.docx'))

# Mid-term scores: numbers, percentages, dates, a formula, and a hidden sheet.
wb = Workbook()
ws = wb.active
ws.title = '期中成绩'
ws.append(['科目', '分数', '满分', '得分率', '考试日期'])
for subject, score, d in [('语文', 92, date(2026, 10, 20)), ('数学', 88, date(2026, 10, 21)), ('英语', 95, date(2026, 10, 22)), ('科学', 79, date(2026, 10, 23))]:
    ws.append([subject, score, 100, score / 100, d])
for r in range(2, 6):
    ws.cell(r, 4).number_format = '0%'
    ws.cell(r, 5).number_format = 'yyyy-mm-dd'
ws.append(['平均', '=AVERAGE(B2:B5)', 100])
reading = wb.create_sheet('每周阅读')
reading.append(['日期', '书名', '分钟'])
for d, book, minutes in [(date(2026, 10, 19), '夏洛的网', 30), (date(2026, 10, 20), '夏洛的网', 25), (date(2026, 10, 21), '小王子', 40)]:
    reading.append([d, book, minutes])
for r in range(2, 5):
    reading.cell(r, 1).number_format = 'yyyy"年"m"月"d"日"'
old = wb.create_sheet('旧数据')
old.append(['这一页是隐藏的'])
old.sheet_state = 'hidden'
raw = out('scores_raw.xlsx')
wb.save(raw)

# A lesson: three slides, notes on the second.
prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = '认识分数'
s.placeholders[1].text = '三年级数学 第七单元'
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = '什么是几分之一'
body = s.placeholders[1].text_frame
body.text = '把一个物体平均分成几份，每份是它的几分之一。'
body.add_paragraph().text = '分数线上面是分子，下面是分母。'
s.notes_slide.notes_text_frame.text = '让学生动手折纸，体会平均分。'
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = '练一练'
s.placeholders[1].text = '一个蛋糕平均分成4份，每份是这个蛋糕的几分之几？'
prs.save(out('lesson.pptx'))

# A story long enough to be cut into parts: four seasons, each with its own facts.
seasons = [
    ('春天', '小燕子从南方飞回来，在屋檐下用泥土和草叶搭了一个新窝。'),
    ('夏天', '池塘里的荷花开了，青蛙在荷叶上数星星，一共数到了三百六十五颗。'),
    ('秋天', '松鼠把一百零八颗松果藏在老橡树的树洞里，准备过冬。'),
    ('冬天', '下了第一场雪，小狐狸在雪地上踩出一串梅花一样的脚印。'),
]
parts = []
for name, fact in seasons:
    filler = '森林里的朋友们每天都在忙着自己的事情，风吹过树梢，阳光照在小路上。' * 18
    parts.append(f'{name}\n{fact}{filler}{fact}')
with open(out('story.txt'), 'w', encoding='utf-8') as f:
    f.write('四季的森林\n\n' + '\n\n'.join(parts) + '\n')

# The same scores as a CSV saved by a Chinese Excel: GBK, not UTF-8.
with open(out('scores_gbk.csv'), 'w', encoding='gbk', newline='') as f:
    f.write('科目,分数\r\n语文,92\r\n数学,88\r\n')

# A scanned page: a picture of text in a PDF, no text layer.
font = ImageFont.truetype('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 36)
img = Image.new('RGB', (1000, 600), 'white')
draw = ImageDraw.Draw(img)
for i, line in enumerate(['家长会通知', '时间：11月12日 晚上7点', '地点：三年级甲班教室', '请家长准时参加。']):
    draw.text((80, 80 + i * 110), line, fill='black', font=font)
tmp = tempfile.mkdtemp()
png = os.path.join(tmp, 'scan.png')
img.save(png)
c = canvas.Canvas(out('scan.pdf'), pagesize=(500, 300))
c.drawImage(png, 0, 0, 500, 300)
c.save()

# LibreOffice: the formula gets its value, and the old formats and a text PDF. (No old
# .ppt: LibreOffice's runs to 650 KB; the test uses a stand-in for that conversion.)
def soffice(fmt, src):
    subprocess.run(['soffice', '--headless', '--convert-to', fmt, '--outdir', tmp, src], check=True, capture_output=True)
    return os.path.join(tmp, os.path.splitext(os.path.basename(src))[0] + '.' + fmt.split(':')[0])

shutil.move(soffice('xlsx', raw), out('scores.xlsx'))
os.remove(raw)
shutil.move(soffice('pdf', out('notice.docx')), out('notice.pdf'))
shutil.move(soffice('doc', out('notice.docx')), out('notice.doc'))
shutil.move(soffice('xls', out('scores.xlsx')), out('scores.xls'))
shutil.rmtree(tmp)
print('made', sorted(os.listdir(HERE)))
