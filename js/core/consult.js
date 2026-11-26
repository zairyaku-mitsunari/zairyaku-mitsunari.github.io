// 三成への相談。質問の言葉から内容を判断し、記録を計算して答える（規則による回答。AIではない）。
// 答えられない質問は、そのことを伝える。回答には対象期間と根拠を添える。
import { addDays, addMonths, monthTitle } from './date.js';
import { live, find, summary, categoryName, sourceName } from './ledger.js';
import { periodRange, monthContaining, balance, totalAssets, bills, isConfigured } from './finance.js';
import { unpaid, liabilities, loanBalance, plannedTotal, nextUnpaid, INSURANCE } from './schedule.js';
import { outlook, nextPayday, occurrences } from './payroll.js';
import { spent, forecast, budgetStatuses, goalStatus, activeGoals, baseline, SCOPES } from './planning.js';
import { compare, topEntries, ranking, storeNames, storeTotal, pace } from './trends.js';
import { findings, monthlyAmount } from './advice.js';
import { report } from './council.js';
import { diagnose } from './diagnosis.js';
import { events, TYPES } from './calendar.js';
import { yen, signed } from './money.js';
import { Store, LedgerError } from './store.js';

export const EXAMPLES = ['今月の収支を報告してくれ', '今月の食費はいくら？', '先月と比べてどう？', '何に一番お金を使っている？', 'このペースだと月末はいくら？', '今月あといくら使える？', '次のカードの引き落としはいくら？', 'サブスクに毎月いくら払っている？',
  '保険料は年間いくら？', '年間100万円貯めるには？', '家計を診断して', '今後の支払い予定は？', '今月の無駄な支出は？', '総資産はいくら？', '事業の利益はどれくらい？', '来月の財務作戦を考えてくれ'];

const normalize = (q) => String(q).normalize('NFKC').replace(/^\s*(三成|みつなり)[、,。\s]*/, '').trim();

export function periodOf(data, question, today) {
  const month = monthContaining(today, data);
  const year = Number(today.slice(0, 4));
  const named = (label, range) => ({ label: `${label}（${range.start}〜${range.end}）`, name: label, range });
  const m = question.match(/(1[0-2]|[1-9])月(?!間)/);
  if (/昨日|きのう/.test(question)) return named('昨日', { start: addDays(today, -1), end: addDays(today, -1) });
  if (/今日|きょう|本日/.test(question)) return named('今日', { start: today, end: today });
  if (/今週|1週間|一週間/.test(question)) return named('直近7日', { start: addDays(today, -6), end: today });
  if (/先月|前月/.test(question)) return named('先月', periodRange(addMonths(month, -1), data));
  if (/来月/.test(question)) return named('来月', periodRange(addMonths(month, 1), data));
  if (/去年|昨年/.test(question)) return named(`${year - 1}年`, { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` });
  if (/今年|本年/.test(question)) return named('今年', { start: `${year}-01-01`, end: today });
  if (m && !/今月/.test(question)) {
    const n = Number(m[1]);
    const target = `${n > Number(month.slice(5)) ? year - 1 : year}-${String(n).padStart(2, '0')}`;
    return named(`${monthTitle(target)}度`, periodRange(target, data));
  }
  return named('今月', periodRange(month, data));
}

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「三百」「五十」「百」→ 数（万の前に置く 1〜9999） */
function kanjiNumber(text) {
  let total = 0;
  let digit = 0;
  for (const ch of text) {
    if (KANJI[ch]) digit = KANJI[ch];
    else { total += (digit || 1) * { 十: 10, 百: 100, 千: 1000 }[ch]; digit = 0; }
  }
  return total + digit;
}

/** 「100万円」「1,000,000円」「50万」「三百万円」→ 円 */
export function amountIn(input) {
  const question = input.replace(/[一二三四五六七八九十百千]+(?=\s*万)/g, (t) => String(kanjiNumber(t)));
  const man = question.match(/([\d,]+)\s*万\s*(?:([\d,]+)\s*)?円?/);
  if (man) return Number(man[1].replace(/,/g, '')) * 10000 + Number((man[2] ?? '0').replace(/,/g, ''));
  const plain = question.match(/([\d,]{4,})\s*円/);
  return plain ? Number(plain[1].replace(/,/g, '')) : null;
}

function categoryIn(data, question) {
  const list = live(data.categories).filter((c) => c.name.length >= 2 && question.includes(c.name));
  return list.sort((a, b) => b.name.length - a.name.length || Number(b.kind === 'expense') - Number(a.kind === 'expense'))[0] ?? null;
}
// 話し言葉の呼び方 → 項目の名前（複数なら合計する）
const SYNONYMS = [
  [/光熱費/, '光熱費', ['電気代', 'ガス代', '水道代']],
  [/ガソリン|給油/, 'ガソリン代', ['ガソリン代']],
  [/(スマホ|スマートフォン|携帯)(電話)?(代|料金|料)/, '携帯電話料金', ['携帯電話料金']],
  [/電気(代|料金|料)/, '電気代', ['電気代']], [/ガス(代|料金|料)/, 'ガス代', ['ガス代']], [/水道(代|料金|料)/, '水道代', ['水道代']],
  [/(ネット|インターネット|回線|[Ww]i-?[Ff]i)(代|料金|料|の料金)/, 'インターネット料金', ['インターネット料金']],
  [/食べ物|食料品|食材|食事代/, '食費', ['食費']], [/外食/, '外食費', ['外食費']],
  [/飲み物|飲料|お酒|酒代/, '飲料費', ['飲料費']],
  [/洋服|服代|衣類/, '衣服費', ['衣服費']], [/化粧品|美容代/, '美容費', ['美容費']], [/薬代|お薬/, '薬代', ['薬代']],
  [/(車|クルマ|くるま|自動車)(の|にかかる)?(維持費|費用|お金|出費|支出)/, '自動車関連', ['自動車関連']],
  [/交通費/, '交通費', ['交通費']], [/娯楽費|遊び代/, '趣味・娯楽', ['趣味・娯楽']], [/住居費|住まいの費用/, '住宅関連', ['住宅関連']],
];
function synonymIn(data, question) {
  const hit = SYNONYMS.find(([pattern]) => pattern.test(question));
  if (!hit) return null;
  const [, title, names] = hit;
  const ids = names.map((n) => live(data.categories).find((c) => c.name === n || (c.isGroup && c.name.startsWith(n)))?.id).filter(Boolean);
  return ids.length ? { title, names, ids } : null;
}

const PERIOD_ONLY = /^(じゃあ|では|それ|それじゃあ?)?[、,\s]*(昨日|きのう|今日|今週|先月|前月|今月|来月|去年|昨年|今年|(1[0-2]|[1-9])月)(分|の分)?(は|だと|なら)?[?？。]*$/;
const PERIOD_WORDS = /昨日|きのう|今日|きょう|本日|今週|1週間|一週間|先月|前月|今月|来月|去年|昨年|今年|本年|(1[0-2]|[1-9])月/g;
/** 「先月は？」のように期間だけを聞かれたら、直前の質問の期間を置き換える */
export function followUp(question, previous) {
  const q = normalize(question);
  const m = q.match(PERIOD_ONLY);
  if (!m || !previous) return question;
  const rest = normalize(previous).replace(PERIOD_WORDS, '').replace(/^[のはも、\s]+/, '');
  return rest ? `${m[2]}の${rest}` : question;
}

const named = (list, question) => list.find((x) => question.includes(x.name)) ?? list.find((x) => {
  const short = x.name.replace(/(カード|銀行|口座|普通預金)/g, '');
  return short.length >= 2 && question.includes(short);
});
const reply = (title, lines, basis, matched = true) => ({ title, lines: [...lines, ...(basis ? [`根拠：${basis}`] : [])], matched });

export function answer(data, input, today, defaultScope = 'all') {
  const q = normalize(input);
  if (!q) return reply('質問を入力してください', ['例：' + EXAMPLES.slice(0, 3).join('／')], null, false);
  const scope = /事業|ビジネス|仕事の経費/.test(q) && !/辞め/.test(q) ? 'business' : /個人|家計/.test(q) ? 'personal' : defaultScope;
  const period = periodOf(data, q, today);
  const costs = (kind) => live(data.recurringCosts).filter((c) => c.kind === kind && c.isActive && (scope === 'all' || c.scope === scope));
  const list = (items, text) => items.slice(0, 12).map(text).concat(items.length > 12 ? [`ほか${items.length - 12}件`] : []);

  if (/何ができ|使い方|どんな(質問|こと).*(でき|答え)|ヘルプ|^(こんにちは|こんばんは|おはよう)/.test(q)) {
    return reply('できること', ['記録を計算して、次のような質問に答えます。生成AIではないため、決まった種類の質問だけです。', ...EXAMPLES, '続けて「先月は？」のように期間だけを聞くこともできます。'], null);
  }

  if (/貯蓄率|(収入|給料).*(何|なん)(パーセント|%|割).*(残|貯)|何(パーセント|%|割)(残|貯)|(貯|残).*(割合|比率)/.test(q)) {
    const sum = summary(data, period.range, scope);
    return reply('貯蓄率', sum.income > 0 ? [`${period.name}の貯蓄率は ${(Math.round((sum.net / sum.income) * 1000) / 10).toFixed(1)}% です。`, `収入 ${yen(sum.income)}、支出 ${yen(sum.expense)}、残り ${signed(sum.net)}`, `対象：${period.label}（${SCOPES[scope]}）`,
      ...(period.range.end > today ? ['期間の途中のため、これからの収入や支出で変わります。'] : [])] : [`${period.name}は収入の記録がないため、貯蓄率は計算できません。`, `支出は ${yen(sum.expense)} です。`], '記録した収入と支出（（収入−支出）÷収入）');
  }

  if (/比べ|比較|増えた|減った|との違い|使い(すぎ|過ぎ)|前の月|先月より|前より|変わった|変化/.test(q)) {
    const month = monthContaining(/(先月|前月)(は|の支出は)/.test(q) ? period.range.start : today, data);
    const r = compare(data, month, scope, today);
    const span = (x) => `${x.start}〜${x.end}`;
    if (!r.comparable) return reply('前の期間との比較', ['前の期間の支出の記録がないため、比べられません。', `今の期間の支出は ${yen(r.now)}（${span(r.current)}）`], '記録した支出');
    const up = r.rows.filter((x) => x.diff > 0).slice(0, 5);
    const down = r.rows.filter((x) => x.diff < 0).slice(0, 3);
    const big = up.length ? topEntries(data, r.current, scope, up[0].categoryID, 2) : [];
    return reply('前の期間との比較', [
      r.now === r.past ? `支出は同じ ${yen(r.now)} です。` : `支出は ${yen(Math.abs(r.now - r.past))} ${r.now > r.past ? '増えています' : '減っています'}（${yen(r.past)} → ${yen(r.now)}）。`,
      ...(up.length ? ['【増えた項目】', ...up.map((x) => `${x.name} +${yen(x.diff)}（${yen(x.past)} → ${yen(x.now)}）`)] : []),
      ...(down.length ? ['【減った項目】', ...down.map((x) => `${x.name} -${yen(-x.diff)}（${yen(x.past)} → ${yen(x.now)}）`)] : []),
      ...(big.length ? [`${up[0].name}で大きい記録：${big.map((t) => `${t.day} ${t.storeName || '店名なし'} ${yen(t.amount)}`).join('、')}`] : []),
      `比べた期間：${span(r.current)} と ${span(r.previous)}（${SCOPES[scope]}）`,
      ...(r.partial ? ['月の途中のため、前の期間も同じ日数までで比べています。'] : []),
    ], '記録した支出（返金を引いた額）。記録していない支払いは含みません。');
  }

  if (/(一番|いちばん|最も)(大き|高)|(最大|一番|いちばん)の(出費|支出|支払)|高い(買い物|支払|出費)|大きな?(支払|出費|買い物)/.test(q)) {
    const found = topEntries(data, period.range, scope);
    return reply(`${period.name}の大きな支払い`, found.length ? [...found.map((t) => `${t.day} ${categoryName(data, t.categoryID)} ${yen(t.amount)}${t.storeName ? `（${t.storeName}）` : ''}`), `対象：${period.label}（${SCOPES[scope]}）`]
      : ['この期間の支出の記録はありません。'], found.length ? '記録した支出を金額の大きい順に表示' : null);
  }

  if (/多い順|内訳|ランキング|使い道|どこに.*(消え|使|いっ|行っ)|何(に|が).*(一番|いちばん|多|使)|(一番|いちばん).*(出費|支出|使|お金)|(出費|支出)が(一番)?多い/.test(q)) {
    const found = ranking(data, period.range, scope);
    const total = found.reduce((s, x) => s + x.amount, 0);
    return reply(`${period.name}の支出の多い順`, found.length ? [...found.slice(0, 7).map((x, i) => `${i + 1}. ${x.name} ${yen(x.amount)}（${Math.round((x.amount / total) * 100)}%）`),
      ...(found.length > 7 ? [`ほか${found.length - 7}項目`] : []), `合計 ${yen(total)}`, `対象：${period.label}（${SCOPES[scope]}）`] : ['この期間の支出の記録はありません。'], found.length ? '記録した支出（返金を引いた額）' : null);
  }

  if (/(1|一)日(あたり|当たり|に?いくら|の平均|平均)|毎日.*(いくら|どのくらい|どれくらい|使)|ペース|月末.*(いくら|見込|予測|どう)|(支出|出費)(の)?見込/.test(q)) {
    const p = pace(data, today, scope);
    const f = forecast(data, p.range, scope, null, today);
    return reply('支出のペース', [`今の月度は${p.elapsed}日目で、支出は ${yen(p.amount)}、1日あたり ${yen(p.perDay)} です。`,
      ...(f ? [`月度末の支出の見込みは ${yen(f.amount)}（推定。残りの固定費の予定 ${yen(f.planned)} と、固定費以外の日割り ${yen(f.variableRest)} を含む）。`,
        ...(f.unknown ? [`金額が未入力の予定${f.unknown}件は含みません。`] : [])] : ['月度が始まって7日たつまでは、月末の見込みは出しません（ぶれが大きいため）。']),
      `対象：${p.range.start}〜${p.range.end}（${SCOPES[scope]}）`], '今の月度の記録と、登録した支払い予定');
  }

  if (/診断|分析して|健康(?!診断|・)|状態はどう|健全/.test(q)) {
    const result = diagnose(data, today, scope);
    const known = result.metrics.filter((m) => m.level !== 'unknown');
    const warn = known.filter((m) => m.level === 'warn');
    return reply('財務の診断', [warn.length ? `注意したい点が${warn.length}件あります。` : known.length ? '計算できる指標に、大きな注意点はありません。' : '診断に必要な記録がまだ足りません。',
      ...list([...warn, ...known.filter((m) => m.level !== 'warn')], (m) => `${m.level === 'warn' ? '【注意】' : ''}${m.title}：${m.value}`),
      result.metrics.length - known.length ? `分からない指標が${result.metrics.length - known.length}件あります（記録が足りません）。` : '分析の「診断」で根拠を確認できます。'], '記録と設定からの計算（目安は一般的な値です）', known.length > 0);
  }

  if (/予定|カレンダー|支払日|支払い日|スケジュール|払う(もの|分|予定|お金)|近いうち/.test(q) && !/引き?落と?し|保険の見直し/.test(q)) {
    const days = /今日/.test(q) ? 0 : /来月|今月|1か月|一か月/.test(q) ? 31 : 7;
    const found = events(data, { start: today, end: addDays(today, days) }, today, scope).filter((e) => e.state === 'planned' || e.state === 'info');
    return reply(`${days === 0 ? '今日' : `今後${days}日`}の予定`, found.length ? list(found, (e) => `${e.day} ${e.title}（${TYPES[e.type]}）${e.amount == null ? '' : ` ${yen(e.amount)}`}`) : ['この期間の予定はありません。'], '登録した予定（実績ではありません）');
  }

  if (/引き?落と?し|引落|請求|カード.*(支払|代金|落ち|引かれ)/.test(q)) {
    const card = named(live(data.cards), q);
    const cards = card ? [card] : live(data.cards);
    const due = cards.flatMap((c) => bills(data, c).filter((b) => !b.settled && b.remaining > 0).map((b) => ({ c, b })));
    const month = /来月|今月|先月/.test(q) ? addMonths(today.slice(0, 7), /来月/.test(q) ? 1 : /先月/.test(q) ? -1 : 0) : null;
    const found = due.filter(({ b }) => (month ? b.paymentDay.startsWith(month) : b.paymentDay >= today)).sort((a, b) => (a.b.paymentDay < b.b.paymentDay ? -1 : 1));
    const chosen = month ? found : found.filter((x) => x.b.paymentDay === found[0]?.b.paymentDay);
    const unset = cards.filter((c) => !isConfigured(c)).map((c) => c.name);
    return reply(`${month ? `${monthTitle(month)}の` : '次の'}引き落とし${card ? `（${card.name}）` : ''}`, [
      ...(chosen.length ? [...list(chosen, ({ c, b }) => `${b.paymentDay} ${c.name} ${yen(b.remaining)}${b.confirmed == null ? '（利用の記録からの計算。未確定）' : '（確定額）'}`),
        `合計 ${yen(chosen.reduce((s, x) => s + x.b.remaining, 0))}`] : ['該当する未払いの請求はありません。']),
      ...(unset.length ? [`締め日が未設定で計算できないカード：${unset.join('、')}`] : []),
    ], 'カードの締め日・引き落とし日と、利用・支払いの記録');
  }

  if (/辞め|退職|独立/.test(q)) {
    const base = baseline(data, today, 'personal', 6);
    if (!base) return reply('生活費の記録が足りません', ['個人の支出を1か月度以上記録すると、必要な生活費の目安を出せます。'], null);
    const assets = totalAssets(data, today);
    return reply('辞めるために必要な資金の目安', [`個人の支出の平均は、月 ${yen(base.expense)} です。`, `6か月分：${yen(base.expense * 6)}　12か月分：${yen(base.expense * 12)}`,
      `現在の総資産：${assets.amount == null ? '未入力' : yen(assets.amount)}`, '税金・社会保険料の変化、事業の立ち上げ費用、家族の予定は含みません。それらを教えていただければ、見直す項目を整理できます。'],
    `直近${base.months.length}か月度の個人の支出の平均`);
  }

  if (/貯め|ためたい|ためる|貯金|貯蓄|積立|積み立て|目標/.test(q) && !/残高|いくら(ある|持)/.test(q)) {
    const amount = amountIn(q);
    const base = baseline(data, today, scope);
    if (amount) {
      const months = /毎月|月に|月々/.test(q) ? 1 : 12;
      const need = Math.ceil(amount / months);
      const advice = findings(data, today, scope);
      return reply(`${months === 12 ? '年間' : '毎月'}${yen(amount)}を貯めるには`, [`毎月の必要額は ${yen(need)} です。`,
        base && base.income > 0 ? `直近の毎月の${base.net >= 0 ? '黒字' : '赤字'}は ${yen(Math.abs(base.net))}（収入 ${yen(base.income)}、支出 ${yen(base.expense)}）。` : '収入と支出の記録が足りないため、今の貯蓄ペースは分かりません。',
        ...(base && base.income > 0 ? [need > base.net ? `あと毎月 ${yen(need - base.net)} の支出削減か収入増が必要です。` : '今の黒字を保てば届く計算です。'] : []),
        ...(advice.yearlySaving ? [`見直し候補をすべて実行すると、月 ${yen(advice.monthlySaving)} の削減見込みです（推定）。`] : [])],
      base && base.income > 0 ? `直近${base.months.length}か月度の平均` : '入力された金額');
    }
    const goals = activeGoals(data).map((g) => goalStatus(data, g, today));
    return reply('貯蓄目標の状況', goals.length ? list(goals, (s) => s.saved == null ? `${s.goal.name}：残高が未入力です。`
      : `${s.goal.name}：${yen(s.saved)} ／ ${yen(s.goal.targetAmount)}（${s.percent}%）${s.required ? `、毎月の必要額 ${yen(s.required)}` : ''}`)
      : ['目標がまだありません。「予算・貯蓄目標」で作成してください。', '「年間100万円貯めるには」のように金額を言うと、毎月の必要額を計算します。'], goals.length ? '目標の設定と、口座の残高か積み立ての記録' : null);
  }

  if (/あと(いくら|どのくらい|どれくらい|どれだけ).*|使える|使っていい|残り予算|余裕|お小遣い/.test(q) && !/ローン|負債|借金|返済|貯め/.test(q)) {
    const month = monthContaining(today, data);
    const totals = budgetStatuses(data, month, scope, today).filter((s) => !s.budget.categoryID);
    const view = outlook(data, today);
    const lines = totals.map((s) => `${s.budget.period === 'yearly' ? '年間' : '月間'}予算（${SCOPES[s.budget.scope]}）：残り ${yen(s.remaining)}（使用 ${yen(s.used)} ／ ${yen(s.budget.amount)}）`);
    if (view?.available != null) lines.push(`給料日（${view.payday.day}）まで${view.daysLeft}日。現金・口座から予定の支払いを引くと ${yen(view.available)}、1日あたり ${yen(view.perDay)} が目安です。`);
    if (!lines.length) lines.push('全体の予算か、給料日と口座の残高を設定すると計算できます。');
    return reply('あと使える金額', lines, '予算の設定、記録した支出、口座の残高、登録した支払い予定', totals.length > 0 || view?.available != null);
  }

  if (/無駄|不要|いらない|要らない|見直|節約|削減|減ら|抑え|払い過ぎ|払いすぎ/.test(q)) {
    const advice = findings(data, today, scope);
    const about = /保険/.test(q) ? advice.items.filter((f) => f.type === '保険' || costs('insurance').some((c) => c.id === f.recurringID))
      : /サブスク/.test(q) ? advice.items.filter((f) => f.type === 'サブスク' || f.type === '重複') : advice.items;
    const lines = list(about.slice(0, 6), (f) => `【${f.type}】${f.title}${f.yearlySaving ? `（年 ${yen(f.yearlySaving)}）` : ''}`);
    if (!lines.length) lines.push('今の記録からは、見直し候補は見つかりません。');
    if (/保険/.test(q)) {
      const total = plannedTotal(/車|自動車/.test(q) ? costs('insurance').filter((c) => ['car', 'compulsoryCar'].includes(c.insurance?.type)) : costs('insurance'), today);
      lines.push(`登録している${/車|自動車/.test(q) ? '自動車の' : ''}保険料：年間 ${yen(total.yearly)}`, '保険を見直して節約できる額は、他社の見積もりや保障内容の比較がないと計算できません。');
    }
    return reply('見直しの候補', lines, '記録、契約の登録内容、予算・目標の設定（不要かどうかの判断はあなたに任せます）');
  }

  const contract = [['サブスク|定期購読', 'subscription', 'サブスク'], ['保険', 'insurance', '保険'], ['固定費', 'fixed', '固定費']].find(([p]) => new RegExp(p).test(q));
  if (contract && !/今月.*払った|実績/.test(q)) {
    const [, kind, title] = contract;
    const found = costs(kind);
    const total = plannedTotal(found, today);
    return reply(`${title}の予定額`, found.length ? [`月あたり ${yen(total.monthly)}、年間 ${yen(total.yearly)}（${found.length}件）`,
      ...list(found, (c) => `${c.name}${c.insurance ? `（${INSURANCE[c.insurance.type]}）` : ''}：${c.plannedAmount == null ? '金額未入力' : `月あたり ${monthlyAmount(c) == null ? yen(c.plannedAmount) + '（一括）' : yen(monthlyAmount(c))}`}、次の予定 ${nextUnpaid(data, c, today)?.dueDay ?? 'なし'}`),
      ...(total.unknown ? [`金額が未入力の${total.unknown}件は合計に含みません。`] : [])] : [`${title}はまだ登録されていません。`], '登録した予定額（支払いの実績ではありません）');
  }

  if (/ローン|負債|借金|返済|残債/.test(q)) {
    const debt = liabilities(data);
    return reply('負債の状況', [`合計 ${yen(debt.total)}（カード未払い ${yen(debt.cards)}、ローン残高 ${yen(debt.loans)}）`,
      ...list(costs('loan'), (c) => { const b = loanBalance(data, c); return `${c.name}：残高 ${b ? yen(b.amount) : '未入力'}、次の返済 ${nextUnpaid(data, c, today)?.dueDay ?? 'なし'}`; }),
      ...(debt.unknownLoans ? [`元本残高が未入力のローン${debt.unknownLoans}件は含みません。`] : [])], 'カードの請求と、ローンの登録内容・返済の記録');
  }

  if (/ボーナス|賞与/.test(q) && !/いくら.*(入った|もらった)|収入/.test(q)) {
    const range = { start: today, end: addDays(today, 400) };
    const next = live(data.incomeSources).flatMap((s) => occurrences(s, range)).filter((o) => o.bonusID).sort((a, b) => (a.day < b.day ? -1 : 1))[0];
    if (!next) return reply('次の給料日（賞与）', ['賞与の予定は登録されていません。', '設定の「給料日・締め日と集計期間」で、勤務先の賞与を登録してください。'], null);
    return reply('次の給料日（賞与）', [`${next.day} ${find(data.incomeSources, next.sourceID).name} ${next.expectedAmount == null ? '予定額は未入力' : `予定額 ${yen(next.expectedAmount)}`}`], '登録した賞与の予定（実績ではありません）');
  }

  if (/給料|給与|入金日/.test(q) && !/いくら.*入|収入/.test(q)) {
    const next = nextPayday(data, today);
    if (!next) return reply('給料日が分かりません', ['設定の「給料日・集計期間」で勤務先を登録してください。'], null);
    const source = find(data.incomeSources, next.sourceID);
    return reply('次の給料日', [`${next.day} ${source.name} ${next.expectedAmount == null ? '予定額は未入力' : `予定額 ${yen(next.expectedAmount)}`}`], '勤務先の給料日と休日の扱い（予定であり、入金の実績ではありません）');
  }

  const account = named(live(data.accounts), q);
  if (/総資産|資産|残高|預金|所持金|手元|いくら持|いくらある/.test(q) || (account && /いくら/.test(q))) {
    if (account) {
      const value = balance(data, account, today);
      return reply(`${account.name}の残高`, [value == null ? '初期残高が未入力のため分かりません。' : `${yen(value)}（今日時点の計算）`], '初期残高と記録した入出金');
    }
    const assets = totalAssets(data, today);
    const debt = liabilities(data);
    return reply('資産の状況', [`総資産 ${assets.amount == null ? '未入力' : yen(assets.amount)}`, `負債 ${yen(debt.total)}`,
      ...(assets.amount == null ? [] : [`純資産 ${yen(assets.amount - debt.total)}`]),
      ...list(live(data.accounts).filter((a) => balance(data, a, today) != null), (a) => `${a.name} ${yen(balance(data, a, today))}`),
      ...(assets.unknown ? [`初期残高が未入力の口座${assets.unknown}件は含みません。`] : [])], '初期残高と記録した入出金、カードの請求、ローンの登録');
  }

  if (/予算/.test(q)) {
    const items = budgetStatuses(data, monthContaining(today, data), scope, today);
    return reply('予算の状況', items.length ? list(items, (s) => `${s.budget.period === 'yearly' ? '年間' : '月間'}・${s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体'}（${SCOPES[s.budget.scope]}）：${yen(s.used)} ／ ${yen(s.budget.amount)}、${s.over ? `超過 ${yen(s.over)}` : `残り ${yen(s.remaining)}`}`)
      : ['予算がまだありません。「予算・貯蓄目標」で設定してください。'], items.length ? '予算の設定と記録した支出' : null);
  }

  if (/作戦|軍議|報告|アドバイス|助言|どうすれば|計画/.test(q) && !/収支/.test(q)) {
    const r = report(data, 'monthly', today, scope);
    const pick = ['結論', '今後31日の予定（実績ではありません）', '資金の見通し', '次の作戦'];
    return reply(`${/来月/.test(q) ? '今後' : '今月'}の財務作戦`, r.sections.filter((s) => pick.includes(s.title)).flatMap((s) => [`【${s.title}】`, ...s.lines.slice(0, 8)]), '今月の記録と、今後の予定・見直し候補');
  }

  const words = synonymIn(data, q);
  if (words) {
    const each = words.ids.map((id, i) => ({ name: words.names[i], amount: spent(data, period.range, scope, id) }));
    return reply(`${period.name}の${words.title}`, [`${yen(each.reduce((s, x) => s + x.amount, 0))}（${SCOPES[scope]}）`, ...(each.length > 1 ? each.map((x) => `${x.name} ${yen(x.amount)}`) : []), `対象：${period.label}`], '記録した支出（返金を引いた額）');
  }

  const category = categoryIn(data, q);
  const store = category ? null : storeNames(data).find((n) => q.includes(n));
  if (store) {
    const r = storeTotal(data, period.range, scope, store);
    return reply(`${period.name}の${store}での支払い`, [`${yen(r.amount)}（${r.count}件、${SCOPES[scope]}）`, ...list(r.entries.slice(0, 5), (t) => `${t.day} ${categoryName(data, t.categoryID)} ${yen(t.amount)}`), `対象：${period.label}`], '店名が同じ記録の支出（返金を引いた額）');
  }
  if (category && category.kind === 'expense') {
    const amount = spent(data, period.range, scope, category.id);
    return reply(`${period.name}の${category.name}`, [`${yen(amount)}（${SCOPES[scope]}）`, `対象：${period.label}`], '記録した支出（返金を引いた額）');
  }
  if (category) {
    const amount = live(data.transactions).filter((t) => t.kind === 'income' && t.day >= period.range.start && t.day <= period.range.end && (scope === 'all' || t.scope === scope)
      && (t.categoryID === category.id || find(data.categories, t.categoryID)?.parentID === category.id)).reduce((s, t) => s + t.amount, 0);
    return reply(`${period.name}の${category.name}`, [`${yen(amount)}`, `対象：${period.label}`], '記録した収入');
  }
  if (/AI/i.test(q) && /投資|費|いくら/.test(q)) {
    const group = live(data.categories).find((c) => c.isGroup && c.name === 'AI・事業関連');
    return reply(`${period.name}のAI・事業関連の支出`, [yen(spent(data, period.range, scope, group?.id ?? 'なし')), `対象：${period.label}`], '項目「AI・事業関連」の記録');
  }
  if (/収支|収入|支出|利益|売上|経費|使った|出費|黒字|赤字|いくら使|稼/.test(q)) {
    const sum = summary(data, period.range, scope);
    const business = scope === 'business';
    return reply(`${period.name}の${business ? '事業の' : ''}収支`, [`${business ? '売上' : '収入'} ${yen(sum.income)}`, `${business ? '経費' : '支出'} ${yen(sum.expense)}`,
      `${business ? '利益' : '収支'} ${signed(sum.net)}`, `対象：${period.label}（${SCOPES[scope]}）`], '記録した収入と支出（振替とカード引き落としは数えません）');
  }
  return reply('この質問には答えられません', ['今の相談機能は、記録を計算して答える仕組みで、AIではありません。次のような質問に答えられます。', ...EXAMPLES], null, false);
}

Object.assign(Store.prototype, {
  saveConsultation(question, lines) {
    return this.commit((data) => {
      const time = this.now();
      data.consultations.push({ id: this.uuid(), question: String(question).slice(0, 500), answer: lines.slice(0, 60), createdAt: time, updatedAt: time });
      // 履歴は新しい200件まで。古いものは中身を消す。
      const kept = live(data.consultations);
      for (const old of kept.slice(0, Math.max(0, kept.length - 200))) Object.assign(old, { question: '', answer: [], deletedAt: time, updatedAt: time });
    });
  },
  /** id がなければすべて削除。中身は残さない。 */
  deleteConsultations(id = null) {
    return this.commit((data) => {
      const time = this.now();
      const targets = live(data.consultations).filter((c) => !id || c.id === id);
      if (id && !targets.length) throw new LedgerError('対象の相談が見つかりません。');
      for (const c of targets) Object.assign(c, { question: '', answer: [], deletedAt: time, updatedAt: time });
    });
  },
});
