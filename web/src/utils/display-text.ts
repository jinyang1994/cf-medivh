import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';

// Canonical API labels stay unchanged in routes, cache keys and stored data.
const labels: Record<string, MessageDescriptor> = {
  当日趋势加载失败: msg`当日趋势加载失败`,
  加载失败: msg`加载失败`,
  该日期不在当前账期内或尚未到来: msg`该日期不在当前账期内或尚未到来`,
  当日服务明细加载失败: msg`当日服务明细加载失败`,
  '账期已变化，请刷新页面': msg`账期已变化，请刷新页面`,
  每日核对: msg`每日核对`,
  服务明细: msg`服务明细`,
  周期: msg`周期`,
  语言: msg`语言`,
  当前账单: msg`当前账单`,
  订阅: msg`订阅`,
  固定订阅费: msg`固定订阅费`,
  请求: msg`请求`,
  'CPU 时间': msg`CPU 时间`,
  构建时间: msg`构建时间`,
  日志事件: msg`日志事件`,
  计算请求: msg`计算请求`,
  计算时长: msg`计算时长`,
  'SQL 读取行数': msg`SQL 读取行数`,
  'SQL 写入行数': msg`SQL 写入行数`,
  'SQL 存储': msg`SQL 存储`,
  'KV 读取单位': msg`KV 读取单位`,
  'KV 写入单位': msg`KV 写入单位`,
  'KV 删除请求': msg`KV 删除请求`,
  'KV 存储': msg`KV 存储`,
  标准操作: msg`标准操作`,
  '低频存储 A 类操作': msg`低频存储 A 类操作`,
  '低频存储 B 类操作': msg`低频存储 B 类操作`,
  低频存储: msg`低频存储`,
  低频存储数据检索: msg`低频存储数据检索`,
  'A 类操作': msg`A 类操作`,
  'B 类操作': msg`B 类操作`,
  标准存储: msg`标准存储`,
  内存: msg`内存`,
  磁盘: msg`磁盘`,
  北美及欧洲出站流量: msg`北美及欧洲出站流量`,
  '大洋洲、韩国及台湾出站流量': msg`大洋洲、韩国及台湾出站流量`,
  其他地区出站流量: msg`其他地区出站流量`,
  读取行数: msg`读取行数`,
  写入行数: msg`写入行数`,
  存储: msg`存储`,
  读取: msg`读取`,
  写入: msg`写入`,
  列举: msg`列举`,
  删除: msg`删除`,
  账单响应格式错误: msg`账单响应格式错误`,
  趋势响应格式错误: msg`趋势响应格式错误`,
  资源用量响应格式错误: msg`资源用量响应格式错误`,
  资源费用响应格式错误: msg`资源费用响应格式错误`,
  '趋势请求超时，请重试': msg`趋势请求超时，请重试`,
  '账单请求超时，请重试': msg`账单请求超时，请重试`,
  '资源费用请求超时，请重试': msg`资源费用请求超时，请重试`,
  '资源用量请求超时，请重试': msg`资源用量请求超时，请重试`,
  趋势加载失败: msg`趋势加载失败`,
  账单加载失败: msg`账单加载失败`,
  资源用量加载失败: msg`资源用量加载失败`,
  资源费用加载失败: msg`资源费用加载失败`,
  '资源明细仅有小时采样；10 分钟汇总使用已保存的采集快照。': msg`资源明细仅有小时采样；10 分钟汇总使用已保存的采集快照。`,
  '固定订阅费没有分时用量。': msg`固定订阅费没有分时用量。`,
  '部分费用缺少对应的资源用量或时段尚未结束，显示为未归属；不会按已有资源比例放大补齐。': msg`部分费用缺少对应的资源用量或时段尚未结束，显示为未归属；不会按已有资源比例放大补齐。`,
  '最近时段的费用尚不可用，资源合计保留最后一次可用的累计估算。': msg`最近时段的费用尚不可用，资源合计保留最后一次可用的累计估算。`,
  '尚无可用的本地费用记录，请等待后台采集完成。': msg`尚无可用的本地费用记录，请等待后台采集完成。`,
  '服务汇总有缺失或未完成时段，合计仅包含已有计费项记录。': msg`服务汇总有缺失或未完成时段，合计仅包含已有计费项记录。`,
  '启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，费用仅从可用记录估算': msg`启动前超过 7 天的 Workers Logs 已超出保留期；历史日志量不完整，费用仅从可用记录估算`,
  '部分历史用量来自官方账单回填，该部分差值不代表独立核验': msg`部分历史用量来自官方账单回填，该部分差值不代表独立核验`,
  当前账单周期尚未更新: msg`当前账单周期尚未更新`,
  '资源用量采集失败，将在下一轮自动重试。': msg`资源用量采集失败，将在下一轮自动重试。`,
  '暂时未能取得资源用量。': msg`暂时未能取得资源用量。`,
  '部分时段尚未采集或采集失败，图中保留断线；合计仅包含已采集的用量。': msg`部分时段尚未采集或采集失败，图中保留断线；合计仅包含已采集的用量。`,
  '资源用量尚未采集，请等待后台采集完成。': msg`资源用量尚未采集，请等待后台采集完成。`,
  '所选账期已超出 Cloudflare 资源明细的可查询范围。': msg`所选账期已超出 Cloudflare 资源明细的可查询范围。`,
  '未能取得所选时间范围的资源用量，请查看下方数据说明或稍后重试。': msg`未能取得所选时间范围的资源用量，请查看下方数据说明或稍后重试。`,
  '部分资源用量数值无效，图中保留空缺。': msg`部分资源用量数值无效，图中保留空缺。`,
  '部分时间段查询失败，图中保留空缺；窗口合计仅包含已取得的数据。': msg`部分时间段查询失败，图中保留空缺；窗口合计仅包含已取得的数据。`,
  'R2 存储按每天峰值折算 GB-months，资源图按日展示。': msg`R2 存储按每天峰值折算 GB-months，资源图按日展示。`,
  '存储用量按小时折算 GB-months，资源图按小时展示。': msg`存储用量按小时折算 GB-months，资源图按小时展示。`,
  '固定订阅费用没有具体资源用量。': msg`固定订阅费用没有具体资源用量。`,
  'Cloudflare 的构建用量统计没有提供按 Worker 拆分的维度，暂时只能查看服务汇总。': msg`Cloudflare 的构建用量统计没有提供按 Worker 拆分的维度，暂时只能查看服务汇总。`,
  'Cloudflare 的此项用量统计没有提供具体资源维度，暂时只能查看服务汇总。': msg`Cloudflare 的此项用量统计没有提供具体资源维度，暂时只能查看服务汇总。`,
  小时: msg`小时`,
  日采集: msg`日`,
};
export function displayText(value: string | null | undefined): string {
  if (!value) return '';
  if (Object.hasOwn(labels, value)) return i18n._(labels[value]);
  // HTTP status details remain intact while the application-owned message is translated.
  const status = value.match(/^(.*)（(\d{3})）$/);
  if (status && Object.hasOwn(labels, status[1]))
    return `${i18n._(labels[status[1]])} (${status[2]})`;
  let match = value.match(/^(.*)尚无资源用量记录，相应费用保留为未归属。$/);
  if (match) return t`${{ name: displayText(match[1]) }}尚无资源用量记录，相应费用保留为未归属。`;
  match = value.match(/^(.*)资源用量按(小时|日)采集，仅使用费用观察时已结束的时段。$/);
  if (match)
    return t`${{ name: displayText(match[1]) }}资源用量按${{ interval: displayText(match[2] === '日' ? '日采集' : match[2]) }}采集，仅使用费用观察时已结束的时段。`;
  match = value.match(/^最近一次资源采集未完成，保留已保存的用量：(.*)$/);
  if (match)
    return t`最近一次资源采集未完成，保留已保存的用量：${{ reason: displayText(match[1]) }}`;
  match = value.match(/^无法读取资源用量：(.*)$/);
  if (match) return t`无法读取资源用量：${{ reason: displayText(match[1]) }}`;
  match = value.match(
    /^Cloudflare 此项资源明细仅保留最近 (\d+) 天，图表从 (.*?) 起展示可查询的数据。$/,
  );
  if (match)
    return t`Cloudflare 此项资源明细仅保留最近 ${{ days: match[1] }} 天，图表从 ${{ date: match[2] }} 起展示可查询的数据。`;
  match = value.match(/^(\d{4}-\d{2}-\d{2}) 资源用量未取得：(.*)$/);
  if (match) return t`${{ date: match[1] }} 资源用量未取得：${{ reason: displayText(match[2]) }}`;
  return value;
}
