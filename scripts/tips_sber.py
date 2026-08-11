import openpyxl, collections, datetime, warnings
warnings.filterwarnings('ignore')

SRC = '/Users/user/Downloads/report (2) (1).xlsx'
wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb['Tables']
rows = list(ws.iter_rows(values_only=True))
hdr = rows[0]
idx = {h: i for i, h in enumerate(hdr)}


def num(v):
    if v in (None, ''):
        return None
    s = str(v).replace('\xa0', '').replace(' ', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def isdate(v):
    try:
        datetime.date.fromisoformat(str(v))
        return True
    except Exception:
        return False


data = []
junk = []
for r in rows[1:]:
    d = r[idx['Дата']]
    if not isdate(d):
        junk.append(r)
        continue
    data.append({
        'date': datetime.date.fromisoformat(str(d)),
        'type': (r[idx['Тип']] or '').strip(),
        'team': (r[idx['Команда']] or '').strip(),
        'tip': num(r[idx['Чаевые']]),
        'check': num(r[idx['Сумма чека за стол']]),
        'pct': num(r[idx['% от суммы чека']]),
        'pay': (r[idx['Способ оплаты']] or '').strip(),
        'comm': (r[idx['Комиссия']] or '').strip(),
        'term': (r[idx['Идентификатор терминала']] or '').strip(),
    })

print('=== СЫРЬЁ ===')
print('строк-данных:', len(data), '| мусорных строк:', len(junk))
for j in junk:
    print('  junk:', str(j[:4])[:160])

ds = sorted({x['date'] for x in data})
print('период:', ds[0], '—', ds[-1], '| дней с операциями:', len(ds),
      '| календарных дней:', (ds[-1] - ds[0]).days + 1)

print()
print('=== ТИПЫ ОПЕРАЦИЙ ===')
for t, c in collections.Counter(x['type'] for x in data).most_common():
    s = sum(x['tip'] or 0 for x in data if x['type'] == t)
    print(f'  {t:28} {c:5} шт   {s:12,.0f} ₽'.replace(',', ' '))

# только денежные операции
money = [x for x in data if x['tip']]
print()
print('денежных операций:', len(money), '| сумма:', f"{sum(x['tip'] for x in money):,.0f}".replace(',', ' '), '₽')

print()
print('=== КТО ПЛАТИТ КОМИССИЮ (перекрёстно с типом) ===')
cross = collections.Counter((x['type'], x['comm']) for x in money)
for (t, c), n in sorted(cross.items()):
    s = sum(x['tip'] for x in money if x['type'] == t and x['comm'] == c)
    print(f'  {t:28} | {c:15} {n:5} шт   {s:12,.0f} ₽'.replace(',', ' '))

print()
print('=== ИТОГО ПО ПЛАТЕЛЬЩИКУ КОМИССИИ ===')
tot_n = len(money)
tot_s = sum(x['tip'] for x in money)
for c, n in collections.Counter(x['comm'] for x in money).most_common():
    s = sum(x['tip'] for x in money if x['comm'] == c)
    print(f'  {c:15} {n:5} шт ({n/tot_n*100:5.1f} %)   {s:12,.0f} ₽ ({s/tot_s*100:5.1f} %)'.replace(',', ' '))

print()
print('=== ПО ПЕРИОДАМ ===')
def block(label, lo, hi):
    sel = [x for x in money if lo <= x['date'] <= hi]
    days = (hi - lo).days + 1
    s = sum(x['tip'] for x in sel)
    pos = [x for x in sel if x['type'] == 'Чаевые с POS-терминала']
    qr = [x for x in sel if x['type'] == 'Чаевые QR']
    print(f'{label}  ({lo}—{hi}, {days} дн.)')
    print(f'   операций {len(sel):4}   сумма {s:11,.0f} ₽   в день {s/days:9,.0f} ₽'.replace(',', ' '))
    print(f'   терминал {len(pos):4} шт / {sum(x["tip"] for x in pos):10,.0f} ₽    QR {len(qr):3} шт / {sum(x["tip"] for x in qr):9,.0f} ₽'.replace(',', ' '))
    checks = [x['check'] for x in sel if x['check']]
    if checks:
        print(f'   сумма чеков {sum(checks):,.0f} ₽ | средний чек {sum(checks)/len(checks):,.0f} ₽ | средние чаевые {s/len(sel):,.0f} ₽'.replace(',', ' '))
    return sel

d = datetime.date
old = block('СТАРОЕ ОКНО 20–31.07', d(2026,7,20), d(2026,7,31))
new = block('НОВАЯ НЕДЕЛЯ 01–09.08', d(2026,8,1), d(2026,8,9))
allp = block('ВЕСЬ ПЕРИОД', ds[0], ds[-1])

print()
print('=== ПОДЕНЬНО ===')
byday = collections.defaultdict(lambda: [0, 0.0, 0, 0])  # n, sum, n_guest_pays, n_waiter_pays
WD = ['пн','вт','ср','чт','пт','сб','вс']
for x in money:
    b = byday[x['date']]
    b[0] += 1
    b[1] += x['tip']
    if x['comm'] == 'с отправителя':
        b[2] += 1
    else:
        b[3] += 1
cur = ds[0]
while cur <= ds[-1]:
    b = byday.get(cur, [0, 0.0, 0, 0])
    print(f'  {cur} {WD[cur.weekday()]}  {b[0]:4} шт  {b[1]:10,.0f} ₽   гость платит комиссию: {b[2]:3}'.replace(',', ' '))
    cur += datetime.timedelta(days=1)

print()
print('=== ПРЕСЕТЫ (% от суммы чека), только терминал ===')
pos_all = [x for x in money if x['type'] == 'Чаевые с POS-терминала']
cp = collections.Counter(x['pct'] for x in pos_all)
for p, n in sorted(cp.items(), key=lambda kv: -kv[1]):
    s = sum(x['tip'] for x in pos_all if x['pct'] == p)
    print(f'  {p:6} %   {n:4} шт ({n/len(pos_all)*100:5.1f} %)   {s:11,.0f} ₽'.replace(',', ' '))

print()
print('=== ПО ОФИЦИАНТАМ ===')
for t, n in collections.Counter(x['team'] for x in money).most_common():
    s = sum(x['tip'] for x in money if x['team'] == t)
    print(f'  {t:14} {n:4} шт   {s:11,.0f} ₽'.replace(',', ' '))
