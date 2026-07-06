// ============================================================
// registry.ts — 工具注册中心 + function calling 调度器
// ============================================================
import { readFileDef, executeReadFile } from './readFile.js'
import { addStep } from '../core/tracer.js'
import type { ChatMessage } from '../services/llmClient.js'

// ─── 工具注册表 ───
export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const ALL_TOOLS: ToolDef[] = [readFileDef]

// ─── 工具调用结果 ───
export interface ToolCallResult {
  role: 'tool'
  tool_call_id: string
  content: string
}

/**
 * dispatchToolCall()
 * 根据 function name 分发到对应的 execute 函数
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  userId: string,
): Promise<string> {
  addStep('tool_call', { tool: name, args }, 0)

  switch (name) {
    case 'read_file':
      return await executeReadFile(args as { fileName: string }, userId)
    default:
      return `[错误] 未知工具: ${name}`
  }
}

/**
 * handleFunctionCalling()
 * 核心循环：发消息给 LLM → LLM 返回 tool_calls → 执行工具 → 把结果拼回去 → 再发给 LLM
 * 最多循环 3 轮，防止死循环
 */
export async function handleFunctionCalling(
  messages: ChatMessage[],
  doChat: (msgs: ChatMessage[], tools?: ToolDef[]) => Promise<{
    text: string
    reasoning: string
    toolCalls: Array<{ id: string; name: string; args: string }>
  }>,
  userId: string,
  onDelta: (text: string) => void,
  onReasoning?: (text: string) => void,
): Promise<{ text: string; reasoning: string }> {
  let fullText = ''
  let fullReasoning = ''

  for (let round = 0; round < 3; round++) {
    const result = await doChat(messages, round === 0 ? ALL_TOOLS : undefined)

    fullReasoning = result.reasoning || fullReasoning

    if (result.toolCalls.length === 0) {
      // 没有工具调用 → 正常回复
      fullText = result.text
      // 把 AI 回复追加到 messages
      messages.push({ role: 'assistant', content: result.text })
      break
    }

    // 有工具调用 → 执行工具，追加结果
    addStep('info', { event: 'function_calling', round, count: result.toolCalls.length })

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: result.text || null as unknown as string,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    }
    messages.push(assistantMsg)

    // 执行每个工具调用
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.args) } catch { /* */ }
      const toolResult = await dispatchToolCall(tc.name, args, userId)
      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: tc.id,
      })
    }

    // 再调一次 LLM，让它基于工具结果生成最终回复
    // 第二轮不用传 tools（避免再触发调用）
    const finalResult = await doChat(messages, undefined)

    fullText = finalResult.text
    fullReasoning = finalResult.reasoning || fullReasoning

    // 把最终回复追加
    messages.push({ role: 'assistant', content: finalResult.text })
    break
  }

  return { text: fullText, reasoning: fullReasoning }
}
