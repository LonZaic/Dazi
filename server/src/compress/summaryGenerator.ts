// ============================================================
// summaryGenerator.ts — 会话摘要生成器（LLM 调用）
// 文件路径：server/src/compress/summaryGenerator.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这个文件调 DeepSeek 把一段对话压缩成摘要。                  ║
// ║                                                            ║
// ║  ▼▼▼ 为啥要 LLM 生成摘要，不用规则提取？ ▼▼▼                ║
// ║    - 规则提取会丢语义（"我们聊了运动"丢失具体内容）         ║
// ║    - LLM 摘要保语义保关键信息（"用户喜欢晨跑，每周 3 次"）  ║
// ║    - 一次 LLM 调用成本远低于每轮重发全历史                  ║
// ║                                                            ║
// ║  ▼▼▼ 情景：50 轮对话怎么摘要 ▼▼▼                            ║
// ║                                                            ║
// ║    输入（前 40 轮对话，8000 字）：                           ║
// ║      User: 你好                                            ║
// ║      AI: 你好啊，我是搭子助手...                            ║
// ║      User: 我想找跑步搭子                                  ║
// ║      AI: 太好了！你喜欢晨跑还是夜跑？                       ║
// ║      ...（40 轮省略）                                       ║
// ║                                                            ║
// ║    LLM 摘要输出（300 字）：                                 ║
// ║      "用户小王，喜欢晨跑每周 3 次，配速 6 分。               ║
// ║       想找有跑步基础的搭子，prefer 周末奥森公园。            ║
// ║       性格内向，聊天偏好深入交流。                          ║
// ║       AI 已推荐 2 个候选（小李/小张），                      ║
// ║       用户对小李兴趣较高。"                                 ║
// ║                                                            ║
// ║    省 7700 字 ≈ 5133 token                                 ║
// ║    摘要调用本身花 ~8000 input + ~300 output ≈ ¥0.0086      ║
// ║    但后续每轮省 5133 input ≈ ¥0.005/轮                     ║
// ║    10 轮就回本，50 轮省 ¥0.025                             ║
// ╚══════════════════════════════════════════════════════════╝
//
// ════════════════════════════════════════════════════════════
//  【设计要点（呼应 Reasonix 省钱策略）】
// ════════════════════════════════════════════════════════════
//   - system prompt 固定不变（命中缓存）
//   - 摘要任务的 user 消息只放对话文本（一次性，不复用缓存）
//   - 低温度（0.2）保稳定
//   - maxTokens 限制 500（摘要不该太长）
//
// ════════════════════════════════════════════════════════════
//  【谁调用它 / 它调用谁】
// ════════════════════════════════════════════════════════════
//   调用它：
//   - compress/autoCompact.ts（触发 auto 时调）
//
//   它调用：
//   - ../services/llmClient.js → chatOnce（非流式一次性返回）
//   - ../core/tracer.js → addStep
// ============================================================

import { chatOnce, llmEnabled, type ChatMessage } from '../services/llmClient.js'
import { addStep } from '../core/tracer.js'

// 摘要任务的固定 system prompt（保持不变以命中缓存）
//   注意：这是摘要任务的 system，和主对话的 system 不同
const SUMMARY_SYSTEM_PROMPT = `你是会话摘要专家。把一段搭子聊天历史压缩成简洁摘要。

要求：
1. 摘要长度 ≤ 300 字
2. 保留关键信息：用户名/兴趣/偏好/已推荐候选/用户反馈
3. 保留时间地点等具体细节
4. 用第三人称叙述（"用户..."、"AI..."）
5. 不要编造，只总结原文出现的信息
6. 不要分段，输出一段连续文本

示例输出：
"用户小王，喜欢晨跑每周3次，配速6分。想找有跑步基础的搭子，prefer周末奥森公园。性格内向，偏好深入交流。AI已推荐2个候选（小李/小张），用户对小李兴趣较高。"`

/**
 * generateSummary() — 调 LLM 生成会话摘要
 * 文件路径：server/src/compress/summaryGenerator.ts → generateSummary()
 *
 * @param messages - 要摘要的消息数组（前 N 条历史对话）
 * @returns 摘要文本（≤300 字）
 *
 * 流程：
 *   1. 拼 system + user（user 放对话原文）
 *   2. 调 chatOnce（非流式，一次性返回）
 *   3. 返回摘要文本
 *
 * 失败处理：
 *   - 无 API Key → 降级到规则摘要（取每条 user 消息拼起来）
 *   - LLM 失败 → 抛错，让调用方决定是否重试或降级
 */
export async function generateSummary(
  messages: readonly ChatMessage[],
): Promise<string> {
  if (messages.length === 0) return ''

  addStep('llm_call', {
    phase: 'summary-gen',
    msgCount: messages.length,
    llmEnabled,
  })

  // 无 API Key 降级：取每条 user 消息拼起来（粗暴但能跑）
  if (!llmEnabled) {
    return fallbackSummary(messages)
  }

  // 拼对话文本
  const dialogText = messages
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
    .join('\n')

  const userMsg: ChatMessage = {
    role: 'user',
    content: `请把以下聊天历史压缩成摘要（≤300字）：\n\n${dialogText}`,
  }

  // 调 DeepSeek（chatOnce 非流式）
  const result = await chatOnce(
    [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, userMsg],
    { maxTokens: 500, temperature: 0.2 },   // 低温度，要稳定的摘要
  )

  return result.text.trim() || fallbackSummary(messages)
}

/**
 * fallbackSummary() — 无 LLM 时的降级摘要（规则提取）
 * 文件路径：server/src/compress/summaryGenerator.ts → fallbackSummary()
 *
 * 规则：取每条 user 消息的前 30 字符，拼起来
 *   场景：无 API Key 或 LLM 失败，至少能跑
 *
 * 缺点：丢失 AI 回复信息，但总比崩了强
 */
function fallbackSummary(messages: readonly ChatMessage[]): string {
  const userMsgs = messages.filter(m => m.role === 'user')
  if (userMsgs.length === 0) return '[无用户消息]'

  const parts = userMsgs.map(m => m.content.slice(0, 30))
  return `[降级摘要-仅用户消息] ${parts.join(' | ')}`
}
