// ============================================================
// antiloop.ts — 反循环检测器（防止 Agent 陷入死循环抽风）
// 文件路径：server/src/core/antiloop.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是 Agent 的"防抽风器"——防止 Agent 反复做同一件事。  ║
// ║  LLM 有时候会陷入死循环：                                   ║
// ║    - ProfileAgent 拿不到新信息，反复用同样参数调 LLM         ║
// ║    - MatchAgent 召回同样的候选，反复打分                    ║
// ║    - 连续报错 5 次还不换方法                                ║
// ║  这文件就是检测这些情况，喊停！                             ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 具体情景：ProfileAgent 抽风的两种典型场景 ▼▼▼
//
//   场景 1：参数重复抽风
//   ─────────────────────────────────────────────────
//   小王发了"我喜欢跑步"
//   ProfileAgent 第 1 次调 LLM（输入："我喜欢跑步"）→ 返回画像 patch
//   ProfileAgent 第 2 次调 LLM（输入："我喜欢跑步"）→ 同样的输入！→ 死循环！
//   ProfileAgent 第 3 次调 LLM（输入："我喜欢跑步"）→ 同样的输入！
//   antiloop 检测到：3 次相同操作 → checkLoop() 返回 isLoop:true
//   → BaseAgent 看到 isLoop:true → 停止当前 Agent，降级到规则模式
//
//   场景 2：连续报错抽风
//   ─────────────────────────────────────────────────
//   LLM 服务挂了，每次调都返回 500
//   ProfileAgent 第 1 次调 LLM → 报错 "Error: 500"
//   ProfileAgent 第 2 次调 LLM → 报错 "Error: 500"
//   ... 连续 5 次错误
//   antiloop 检测到：consecutiveErrors >= 5 → isLoop:true
//   → 停止 LLM 调用，降级到规则抽取
//
//   场景 3：原地踏步抽风
//   ─────────────────────────────────────────────────
//   ProfileAgent 调 LLM 返回的内容很短（< 50 字符）
//   10 轮都没什么实质进展
//   antiloop 检测到：roundsWithoutProgress >= 10 → isStuck():true
//   → BaseAgent 提前结束抽取，用现有画像
//
// ════════════════════════════════════════════════════════════
//  【数据流】
// ════════════════════════════════════════════════════════════
//
//   ProfileAgent.run()
//        │
//        ▼
//   loopDetector.recordAction('extract_profile', args, result)
//        │ 内部：
//        │  ① makeArgsKey(args) → 参数指纹字符串
//        │  ② actionLog.push({ toolName, argsKey, count:1 })
//        │  ③ 根据结果长度/是否含 Error 更新计数器
//        │
//        ▼
//   loopDetector.checkLoop()
//        │ 内部：
//        │  ① 遍历 actionLog，看是否有 count >= 3
//        │  ② 检查 consecutiveErrors >= 5
//        │
//        ▼
//   if (isLoop) → 停止 Agent，降级规则模式
//
// ════════════════════════════════════════════════════════════
//  【为什么要"参数指纹"？】
// ════════════════════════════════════════════════════════════
//   不能只看"调用了几次 extract_profile"——
//   小王聊 3 句不同的话，ProfileAgent 调 3 次 extract_profile 是正常的！
//   要看的是"用同样参数调了几次"——
//   所以要把 args 对象序列化成字符串"指纹"，比指纹是否相同
//
//   指纹算法：
//     { name:'跑步', confidence:0.9, evidence:'用户说喜欢' }
//     ① Object.entries → [['name','跑步'], ['confidence',0.9], ['evidence','用户说喜欢']]
//     ② sort → 按 key 字母排：[['confidence',0.9], ['evidence','用户说喜欢'], ['name','跑步']]
//     ③ map → 'confidence=0.9', 'evidence="用户说喜欢"', 'name="跑步"'
//     ④ join('|') → 'confidence=0.9|evidence="用户说喜欢"|name="跑步"'
//   → 同样的对象永远生成同样的指纹（顺序无关）
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface → 定义对象结构
//   - 闭包 → 返回的对象里的函数共享 actionLog 等变量
//   - JSON.stringify(v) → 对象转字符串
//   - Object.entries → 对象转 [key, value] 数组
//   - .slice(0, 80) → 截前 80 字符（防指纹太长）
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型 1】ActionRecord — 每次操作的记录
// ════════════════════════════════════════════════════════════
interface ActionRecord {
  toolName: string   // 操作名（如 'extract_profile'、'recall'、'rank'）
                     //   场景：ProfileAgent 调 'extract_profile'
                     //        MatchAgent 调 'recall'（向量召回）和 'rank'（排序）
                     //
  argsKey: string    // 参数指纹（参数序列化后的字符串）
                     //   作用：比较两次操作的参数是否相同
                     //   示例：'confidence=0.9|name="跑步"'
                     //
  count: number      // 这个"操作+参数"组合被执行了多少次
                     //   >=3 就报警（死循环）
                     //   场景：count=2 还行，count=3 触发 isLoop
}

// ════════════════════════════════════════════════════════════
//  【类型 2】LoopDetector — 反循环器的接口（能做什么）
// ════════════════════════════════════════════════════════════
// 文件路径：server/src/core/antiloop.ts
export interface LoopDetector {
  // 记录一次正常操作
  //   参数：name=操作名, args=参数对象, result=结果字符串
  //   场景：ProfileAgent 调 LLM 后调
  //        recordAction('extract_profile', {prompt:'我喜欢跑步'}, '画像 patch JSON')
  recordAction(name: string, args: Record<string, unknown>, result: string): void

  // 记录一次错误（不影响正常操作计数）
  //   场景：LLM 调用 500 错误时调
  //        recordError('LLM 调用失败：500')
  recordError(msg: string): void

  // 检查是否出现循环
  //   返回：{ isLoop: true/false, message: 警告信息 }
  //   场景：BaseAgent 每轮结束调一次，isLoop=true 就停止
  checkLoop(): { isLoop: boolean; message: string }

  // 判断是否"卡住了"（太久没进展或错太多）
  //   场景：连续 10 轮没进展 → 提前结束，用现有结果
  isStuck(): boolean

  // 重置（清空所有记录）
  //   场景：用户开始新对话时清空
  reset(): void
}

// ════════════════════════════════════════════════════════════
//  【工厂函数】createLoopDetector — 造一个新的反循环器
// ════════════════════════════════════════════════════════════
//   谁调用：orchestrator.ts 的 getSession() 里给新用户发一个
//   返回值：实现了 LoopDetector 接口的对象
// 文件路径：server/src/core/antiloop.ts → createLoopDetector()
export function createLoopDetector(): LoopDetector {
  // ① 操作日志数组：每做一次操作就记一条 ActionRecord
  //   场景：recordAction 调 5 次 → actionLog 最多 5 条
  const actionLog: ActionRecord[] = []

  // ② 连续出错次数（>5 次报循环）
  //   场景：LLM 500 错误连发 5 次 → consecutiveErrors=5 → isLoop
  let consecutiveErrors = 0

  // ③ 连续无进展轮数（>10 次判定卡住）
  //   场景：LLM 返回内容都很短，10 轮都没新信息 → isStuck
  let roundsWithoutProgress = 0

  // ──────────────────────────────────────────────────────
  // 【辅助函数】makeArgsKey — 把参数对象变成"指纹"字符串
  // ──────────────────────────────────────────────────────
  //   为什么需要指纹？看上面"为什么要参数指纹"部分
  //
  //   示例：
  //     输入：{ name:'跑步', confidence:0.9, evidence:'用户说喜欢' }
  //     输出：'confidence=0.9|evidence="用户说喜欢"|name="跑步"'
  function makeArgsKey(args: Record<string, unknown>): string {
    return Object.entries(args)
      // Object.entries：把对象转成 [key, value] 数组
      //   {a:1, b:2} → [['a',1], ['b',2]]
      .sort(([a], [b]) => a.localeCompare(b))
      // sort：按 key 字母排序，保证顺序一致
      //   [a] 解构：取数组第一个元素（key 名）
      //   localeCompare：字符串比较（'a' < 'b' 返回 -1）
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
      // map：把每个 [key, value] 格式化成 "key=value"
      // JSON.stringify：把 value 转字符串（'跑步' → '"跑步"'，0.9 → '0.9'）
      // .slice(0, 80)：截前 80 字符（防 evidence 太长导致指纹太长）
      .join('|')
      // join：用 | 连起来
  }

  // ──────────────────────────────────────────────────────
  // 【方法 1】recordAction — 记录一次正常操作
  // ──────────────────────────────────────────────────────
  //   调用方：ProfileAgent 每次调 LLM 后调
  //            MatchAgent 每次召回/排序后调
  //   场景：ProfileAgent 调 LLM 抽画像
  //        recordAction('extract_profile', {prompt:'我喜欢跑步'}, '{"interests":[...]}')
  function recordAction(toolName: string, args: Record<string, unknown>, result: string) {
    // ① 生成操作指纹：操作名 + 参数指纹
    //   场景：toolName='extract_profile' + argsKey='prompt="我喜欢跑步"'
    //        → 'extract_profile:prompt="我喜欢跑步"'
    const key = `${toolName}:${makeArgsKey(args)}`

    // ② 查日志：这个"操作+参数"组合之前做过没？
    //   find：数组方法，返回第一个满足条件的元素，找不到返回 undefined
    const existing = actionLog.find(a => a.argsKey === key)

    if (existing) {
      // ③ 做过 → 次数 +1
      //   场景：第 2 次用同样参数调 extract_profile → existing.count 从 1 变 2
      existing.count++
    } else {
      // ④ 没做过 → 新增一条记录
      actionLog.push({ toolName, argsKey: key, count: 1 })
    }

    // ⑤ 根据结果判断是否有进展
    //   "进展"的判断标准：
    //   - 结果内容够长（>50 字符）→ 算有进展
    //   - 结果含 "Error" 或 "错误" → 算出错
    //   - 其他 → 算无进展
    if (result && result.length > 50) {
      // 结果够长 → 有进展，重置计数器
      //   场景：LLM 返回 200 字符的画像 JSON → 重置 roundsWithoutProgress=0
      roundsWithoutProgress = 0
      consecutiveErrors = 0
    } else if (result.includes('Error') || result.includes('错误')) {
      // 结果含错误字样 → 出错了
      //   场景：LLM 返回 "Error: rate limit exceeded"
      consecutiveErrors++
      roundsWithoutProgress++
    } else {
      // 结果很短且没错误 → 可能没实质进展
      //   场景：LLM 返回 "{}"（空对象，2 字符）
      roundsWithoutProgress++
    }

    // ⑥ 日志最多保留 20 条，超过就删最早的
    //   防止日志无限增长占内存
    //   shift：删除数组第一个元素（最早的记录）
    if (actionLog.length > 20) actionLog.shift()
  }

  // ──────────────────────────────────────────────────────
  // 【方法 2】recordError — 记录一次错误
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent.run() 的 try-catch 块里调
  //   场景：LLM 调用抛异常 → recordError('LLM 调用失败：500')
  function recordError(_msg: string) {
    // _msg 前面加下划线：TS 约定"这个参数在函数里没用"
    //   好处：TS 不会报 unused parameter 警告
    //   为什么没用？只关心出错次数，不关心具体错误信息
    //   （错误信息由 tracer.ts 另行记录）
    consecutiveErrors++      // 连续错误 +1
    roundsWithoutProgress++  // 无进展轮数 +1
  }

  // ──────────────────────────────────────────────────────
  // 【方法 3】checkLoop — 检查是否出现循环
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 每轮执行后调
  //   场景：ProfileAgent 抽完一次画像后调
  //        const { isLoop, message } = loopDetector.checkLoop()
  //        if (isLoop) → 停止 Agent
  function checkLoop(): { isLoop: boolean; message: string } {
    // ① 遍历日志：有没有同一个操作被做了 3 次以上？
    for (const a of actionLog) {
      if (a.count >= 3) {
        // 触发条件：count >= 3
        //   场景：3 次用同样参数调 extract_profile
        return {
          isLoop: true,
          message: `检测到循环：${a.toolName} 被连续调用 ${a.count} 次（相同参数）。请换一个角度继续。`,
        }
      }
    }
    // ② 连续出错超过 5 次 → 也视为循环
    if (consecutiveErrors >= 5) {
      // 触发条件：consecutiveErrors >= 5
      //   场景：LLM 服务挂了，5 次都 500 错误
      return {
        isLoop: true,
        message: `连续 ${consecutiveErrors} 次出错。请停止当前方向，分析根因或降级到规则模式。`,
      }
    }
    // ③ 都没问题
    return { isLoop: false, message: '' }
  }

  // ──────────────────────────────────────────────────────
  // 【方法 4】isStuck — 判断是否卡住了
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 在主循环里调
  //   场景：连续 10 轮 LLM 返回都很短 → 提前结束，别浪费时间
  function isStuck(): boolean {
    // 触发条件：roundsWithoutProgress >= 10 或 consecutiveErrors >= 10
    //   场景 1：10 轮都没新进展 → 用现有画像结果
    //   场景 2：10 次连续报错 → 放弃 LLM，降级规则模式
    return roundsWithoutProgress >= 10 || consecutiveErrors >= 10
  }

  // ──────────────────────────────────────────────────────
  // 【方法 5】reset — 重置所有记录
  // ──────────────────────────────────────────────────────
  //   调用方：BaseAgent 主动降级时调，清空历史重新开始
  //   场景：ProfileAgent 检测到循环 → 降级规则模式 → reset() → 用规则模式重试
  function reset() {
    actionLog.length = 0     // 日志数组清空
    consecutiveErrors = 0    // 错误计数器归零
    roundsWithoutProgress = 0  // 无进展计数器归零
  }

  // 返回对象，暴露 5 个方法给外面用
  //   闭包：这些方法共享 actionLog / consecutiveErrors / roundsWithoutProgress
  return { recordAction, recordError, checkLoop, isStuck, reset }
}
