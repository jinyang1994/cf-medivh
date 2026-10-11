// Keep unknown upstream diagnostic details intact; translate application-owned notices.
const english: Record<string, string> = {
  '启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，日志费用仅从可用记录估算':
    'Workers Logs older than 7 days before startup are beyond retention; historical log costs are estimated from available records.',
  '启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，费用仅从可用记录估算':
    'Workers Logs older than 7 days before startup are beyond retention; historical costs are estimated from available records.',
  '部分历史用量来自官方账单回填，该部分差值不代表独立核验':
    'Some historical usage was backfilled from official bills; those differences are not an independent reconciliation.',
  当前账单周期尚未更新: 'The current billing cycle has not been updated yet.',
  服务用量尚未完整: 'Service usage is incomplete.',
  本轮未取得当前日期的有效实时采样:
    'No valid real-time sample for today was obtained in this round.',
  采集未完成: 'Collection incomplete.',
};
export function englishDiagnostic(message: string): string {
  if (Object.hasOwn(english, message)) return english[message]!;
  if (message.startsWith('账单周期：'))
    return `Billing cycle: ${englishDiagnostic(message.slice(5))}`;
  const usage = message.match(/^(\d{4}-\d{2}-\d{2}) 用量：(.*)$/s);
  if (usage) return `${usage[1]} usage: ${englishDiagnostic(usage[2]!)}`;
  return message;
}
