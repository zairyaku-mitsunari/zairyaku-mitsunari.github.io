// 三成の回答の窓口。今は「規則と計算による回答」（無料・端末の中）だけ。
// 将来、生成AIを使う場合の接続点。外部のAIは、利用者の同意がなければ呼ばず、渡すのは下の要約と質問だけにする。
// 金額の計算はこのアプリが行い、AIの推測には頼らない。
import { answer, periodOf, followUp } from './consult.js';
import { summary, expenseByCategory, categoryName } from './ledger.js';
import { budgetStatuses, goalStatus, activeGoals, SCOPES } from './planning.js';
import { diagnose } from './diagnosis.js';
import { monthContaining } from './finance.js';

export const RULES = { id: 'rules', title: '規則と計算による回答（無料・端末の中）', external: false, respond: ({ data, question, today, scope, history = [] }) => {
  // 「先月は？」のような続きの質問は、直前までの質問と合わせて解釈し、そのことを回答に示す
  const context = history.reduce((previous, q) => followUp(q, previous), null);
  const full = followUp(question, context);
  const result = answer(data, full, today, scope);
  return full === question ? result : { ...result, lines: [`前の質問の続きとして「${full}」に答えます。`, ...result.lines] };
} };
const providers = new Map([[RULES.id, RULES]]);

export function register(provider) {
  if (!provider?.id || typeof provider.respond !== 'function' || typeof provider.external !== 'boolean') throw new Error('接続先の形式が正しくありません。');
  providers.set(provider.id, provider);
}
export const unregister = (id) => { if (id !== RULES.id) providers.delete(id); };
export const list = () => [...providers.values()].map(({ id, title, external }) => ({ id, title, external }));

/**
 * 外部のAIに渡してよい最小限の要約。店舗名・メモ・口座名・カード名・契約者などは入れない。
 * 目標の名前は番号にする。金額はこのアプリで計算した値。
 */
export function context(data, question, today, scope = 'all') {
  const { range, name } = periodOf(data, question, today);
  const sum = summary(data, range, scope);
  const month = monthContaining(today, data);
  return {
    period: { name, start: range.start, end: range.end }, scope: SCOPES[scope], totals: sum,
    categories: expenseByCategory(data, range, scope).slice(0, 15).map((x) => ({ category: categoryName(data, x.categoryID), amount: x.amount })),
    budgets: budgetStatuses(data, month, scope, today).map((s) => ({ target: s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体', amount: s.budget.amount, used: s.used })),
    goals: activeGoals(data).map((g, i) => { const s = goalStatus(data, g, today); return { goal: `目標${i + 1}`, target: g.targetAmount, saved: s.saved, targetDay: g.targetDay ?? null }; }),
    diagnosis: diagnose(data, today, scope).metrics.filter((m) => m.level !== 'unknown').map((m) => ({ title: m.title, value: m.value })),
  };
}

export async function respond({ data, question, today, scope = 'all', history = [] }, { provider = RULES.id, consent = false } = {}) {
  const chosen = providers.get(provider);
  if (!chosen) throw new Error('接続先が見つかりません。');
  if (!chosen.external) return chosen.respond({ data, question, today, scope, history }); // 過去の質問は外部に渡さない
  if (!consent) throw new Error('外部のAIに送るには、同意が必要です。');
  return chosen.respond({ question, context: context(data, question, today, scope) }); // 記録そのものは渡さない
}
