// ============================================================
// structuredOutput.ts — 结构化输出（LLM 输出的质检车间）
// 文件路径：server/src/core/structuredOutput.ts
// ============================================================
//
// ╔══════════════════════════════════════════════════════════╗
// ║  【豪华情景版注释】                                         ║
// ║  这文件是 LLM 输出的"质检车间"——LLM 返回的 JSON 经常乱的   ║
// ║  不行，这里三层防线把它洗干净、抠出来、校验合格。           ║
// ╚══════════════════════════════════════════════════════════╝
//
// ▼▼▼ 为什么需要这个文件？LLM 输出有多坑？▼▼▼
//
//   场景 1：尾逗号（最常见）
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     { "name": "跑步", "confidence": 0.9, }   ← 末尾多了个逗号
//   JSON.parse → 报错 SyntaxError
//   修复：去掉尾逗号 → { "name": "跑步", "confidence": 0.9 }
//
//   场景 2：单引号
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     { 'name': '跑步' }   ← 用了单引号（JSON 标准要双引号）
//   JSON.parse → 报错
//   修复：单引号 → 双引号 → { "name": "跑步" }
//
//   场景 3：键名不加引号
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     { name: "跑步" }   ← key 没加引号（JS 对象语法，不是 JSON）
//   JSON.parse → 报错
//   修复：加引号 → { "name": "跑步" }
//
//   场景 4：NaN / Infinity
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     { "confidence": NaN }   ← JSON 标准不允许 NaN
//   JSON.parse → 报错
//   修复：NaN → null → { "confidence": null }
//
//   场景 5：markdown 代码块包裹
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     ```json
//     { "name": "跑步" }
//     ```
//   JSON.parse → 报错（前面有 ```json）
//   修复：去掉 ```json 和 ``` → { "name": "跑步" }
//
//   场景 6：JSON 外面裹废话
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     "好的，以下是抽取结果：\n{ \"name\": \"跑步\" }\n希望对你有帮助"
//   JSON.parse → 报错
//   修复：用正则抠出 { ... } 部分 → { "name": "跑步" }
//
//   场景 7：字段缺失或类型错
//   ─────────────────────────────────────────────────
//   LLM 返回：
//     { "name": "跑步" }   ← 缺 confidence 字段
//   validateJSON → 报错"缺少必填字段 confidence"
//   处理：ProfileAgent 用默认值 0.5 兜底
//
// ════════════════════════════════════════════════════════════
//  【三层防线数据流】
// ════════════════════════════════════════════════════════════
//
//   LLM 返回文本（可能是任意乱七八糟的格式）
//        │
//        ▼
//   ① quickFixJSON(text)   ← 第一层：修格式
//      - 去 markdown 代码块
//      - 修尾逗号
//      - 单引号 → 双引号
//      - 无引号 key → 加引号
//      - NaN/Infinity → null
//        │
//        ▼
//   ② extractJSON(text)    ← 第二层：抠 JSON
//      - 先 try JSON.parse（最理想情况）
//      - 失败 → 用正则找最外层 { ... } 块
//        │
//        ▼
//   ③ validateJSON(data, schema)   ← 第三层：校验字段
//      - 检查必填字段
//      - 检查类型（number 不能是 string）
//      - 检查范围（confidence 必须 0-1）
//      - 检查枚举值
//        │
//        ▼
//   合格的 JSON 数据，可以放心用
//
// ════════════════════════════════════════════════════════════
//  【关键 TS 语法点】
// ════════════════════════════════════════════════════════════
//   - interface JsonSchema → 递归类型（schema 的属性本身也是 schema）
//   - 递归函数（_validate 调用自己检查嵌套结构）
//   - 正则表达式（replace 里的 /pattern/g 做全局替换）
//   - unknown 类型（比 any 安全，用前必须断言）
// ============================================================

// ════════════════════════════════════════════════════════════
//  【类型】JsonSchema — JSON 校验规则（递归类型）
// ════════════════════════════════════════════════════════════
//   这是项目的"轻量版 JSON Schema 标准"，不是完整实现，只支持需要的子集
//   递归类型：JsonSchema 的 properties 字段又是 Record<string, JsonSchema>
interface JsonSchema {
  type?: string | string[]           // 类型：'string' | 'number' | 'object' | 'array' | ...
                                      //   场景：schema.type = 'string' 要求字段是字符串
                                      //   可以是数组：['string', 'null'] 表示可以是字符串或 null
                                      //
  properties?: Record<string, JsonSchema>  // 对象的属性定义
                                      //   Record<string, JsonSchema> = { [属性名: string]: JsonSchema }
                                      //   场景：{ name: { type:'string' }, confidence: { type:'number' } }
                                      //
  required?: string[]                // 必填字段列表
                                      //   场景：required: ['name', 'confidence']
                                      //   → 缺这两个字段任何一个 → 校验失败
                                      //
  additionalProperties?: boolean | JsonSchema  // 是否允许额外属性
                                      //   false = 不允许额外字段
                                      //   场景：LLM 多返回了个 'foo' 字段，schema 没定义 → 报错
                                      //
  items?: JsonSchema                 // 数组元素的 schema
                                      //   场景：{ type:'array', items: { type:'string' } }
                                      //   → 数组每个元素必须是字符串
                                      //
  enum?: unknown[]                   // 枚举值（只能取这几个值之一）
                                      //   场景：enum: ['extrovert', 'introvert', 'ambivert']
                                      //   → socialStyle.energy 只能是这三个之一
                                      //
  anyOf?: JsonSchema[]               // 满足其中任意一个 schema 即可
                                      //   场景：anyOf: [{ type:'string' }, { type:'null' }]
                                      //   → 可以是字符串或 null
                                      //
  pattern?: string                   // 正则表达式（字符串格式校验）
                                      //   场景：pattern: '^[a-z]+$' → 只允许小写字母
                                      //
  minLength?: number                 // 最小长度
  maxLength?: number                 // 最大长度
  minimum?: number                   // 最小值
  maximum?: number                   // 最大值
  minItems?: number                  // 数组最小元素数
  maxItems?: number                  // 数组最大元素数
}

// ════════════════════════════════════════════════════════════
//  【函数 1】validateJSON — 校验 JSON 数据是否符合 schema
// ════════════════════════════════════════════════════════════
//   调用方：ProfileAgent.extractViaLLM() 拿到 LLM 返回的 JSON 后调
//   场景：LLM 返回 { name:'跑步', confidence:0.9 }
//        schema 要求 confidence 必须 0-1，且必须有 evidence 字段
//        validateJSON(data, schema) → { valid: false, errors: ['缺少 evidence'] }
//
//   参数：
//     data: unknown → 要校验的数据（unknown 因为来自 LLM，类型不确定）
//     schema: JsonSchema → 规则
//   返回值：{ valid: true/false, errors: 错误列表 }
// 文件路径：server/src/core/structuredOutput.ts → validateJSON()
export function validateJSON(data: unknown, schema: JsonSchema): { valid: boolean; errors: string[] } {
  const errors: string[] = []       // 错误列表（初始为空）
  // 调用递归校验函数，从根路径 '$' 开始
  //   '$' 是 JSON 路径约定，表示"根"（类似文件系统的 /）
  _validate(data, schema, '$', errors)
  // errors.length === 0 表示没错误 → valid: true
  return { valid: errors.length === 0, errors }
}

// ════════════════════════════════════════════════════════════
//  【递归函数】_validate — 核心校验逻辑
// ════════════════════════════════════════════════════════════
//   为什么是递归？因为 JSON 是树状结构：
//     对象 → 属性 → 属性的属性 → ...
//   每一层都调 _validate 检查，路径逐渐变深
//
//   示例路径演化：
//     根 → '$'
//     对象 → '$.interests'
//     数组元素 → '$.interests[0]'
//     元素属性 → '$.interests[0].name'
//
//   参数：
//     data: unknown → 当前层级的数据
//     schema: JsonSchema → 当前层级的规则
//     path: string → 当前路径（debug 用，错误信息里显示）
//     errors: string[] → 错误列表（往里面塞错误信息）
function _validate(data: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  // ① 枚举校验：data 必须是枚举值之一
  //   场景：schema.enum = ['extrovert', 'introvert', 'ambivert']
  //        data = 'unknown' → 不在枚举里 → 报错
  if (schema.enum) {
    // some：数组方法，至少有一个满足条件就返回 true
    //   JSON.stringify(v) === JSON.stringify(data)：用字符串比较（防引用比较失败）
    if (!schema.enum.some(v => JSON.stringify(v) === JSON.stringify(data))) {
      errors.push(`${path}: 值不在允许范围内`)
    }
    return  // 枚举通过/不通过都不继续往下校验
  }

  // ② anyOf 校验：data 必须满足 anyOf 数组中至少一个 schema
  //   场景：anyOf: [{ type:'string' }, { type:'null' }]
  //        data = 'hello' → 满足第一个
  //        data = null → 满足第二个
  //        data = 123 → 都不满足 → 报错
  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => {
      const sub: string[] = []               // 子错误列表（临时，不污染主 errors）
      _validate(data, s, path, sub)          // 递归校验
      return sub.length === 0                // 子校验没错误 → 这个 schema 满足
    })
    if (!ok) errors.push(`${path}: 不满足 anyOf`)  // 没有任何一个 schema 满足
    return
  }

  // ③ 类型校验：data 的实际类型是否匹配 schema.type
  //   场景：schema.type = 'number'，data = 'abc' → 类型不对 → 报错
  if (schema.type) {
    // type 可以是单个字符串或数组（如 'string' 或 ['string','null']）
    //   Array.isArray(schema.type) ? schema.type : [schema.type]
    //   → 统一转成数组处理
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    // 判断实际类型
    //   data === null → 'null'（JS 的 typeof null 是 'object'，坑！要单独判）
    //   Array.isArray(data) → 'array'（typeof 数组也是 'object'，要单独判）
    //   其他 → typeof data
    const actual = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data
    if (!types.includes(actual)) {
      // types.join('|')：['string','null'] → 'string|null'
      errors.push(`${path}: 期望 ${types.join('|')}, 实际 ${actual}`)
      return  // 类型都错了，不往下校验（无意义）
    }
  }

  // ④ 字符串校验（长度、正则）
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      errors.push(`${path}: 过短（最小 ${schema.minLength}）`)
    if (schema.maxLength !== undefined && data.length > schema.maxLength)
      errors.push(`${path}: 过长（最大 ${schema.maxLength}）`)
    if (schema.pattern) {
      // RegExp：正则表达式对象
      //   场景：pattern: '^[a-z]+$' → 只允许小写字母
      //   new RegExp(pattern).test(data) → 测试 data 是否匹配
      try { if (!new RegExp(schema.pattern).test(data)) errors.push(`${path}: 不匹配正则`) }
      catch { /* 正则语法错误，忽略（不卡死校验流程） */ }
    }
  }

  // ⑤ 数字校验（范围）
  else if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum)
      errors.push(`${path}: 小于最小值 ${schema.minimum}`)
    if (schema.maximum !== undefined && data > schema.maximum)
      errors.push(`${path}: 大于最大值 ${schema.maximum}`)
  }

  // ⑥ 数组校验（每个元素递归 + 数组长度）
  else if (Array.isArray(data) && schema.items) {
    if (schema.minItems !== undefined && data.length < schema.minItems)
      errors.push(`${path}: 数组元素太少（最少 ${schema.minItems}）`)
    if (schema.maxItems !== undefined && data.length > schema.maxItems)
      errors.push(`${path}: 数组元素太多（最多 ${schema.maxItems}）`)
    // 对每个元素递归校验
    //   路径演化：'$.interests' → '$.interests[0]', '$.interests[1]', ...
    for (let i = 0; i < data.length; i++)
      _validate(data[i], schema.items, `${path}[${i}]`, errors)
  }

  // ⑦ 对象校验（每个属性递归 + 必填检查 + 多余属性检查）
  else if (typeof data === 'object' && data !== null && schema.properties) {
    // as 断言：告诉 TS "我知道 data 是对象，把它当 Record<string, unknown> 用"
    //   因为前面已经判过 typeof === 'object' 且 !== null，所以这里安全
    const obj = data as Record<string, unknown>

    // 必填字段检查
    //   schema.required 可能是 undefined → || [] 兜底成空数组
    for (const key of schema.required || []) {
      // undefined 或 null 都算"缺字段"
      if (obj[key] === undefined || obj[key] === null)
        errors.push(`${path}: 缺少必填字段 "${key}"`)
    }

    // 每个属性递归校验
    //   Object.entries：把 {a:1, b:2} 变成 [['a',1], ['b',2]]
    //   解构 [k, s]：k 是属性名，s 是属性 schema
    for (const [k, s] of Object.entries(schema.properties)) {
      if (obj[k] !== undefined)
        // 路径演化：'$' → '$.name', '$.confidence', ...
        _validate(obj[k], s, `${path}.${k}`, errors)
    }

    // 多余属性检查
    //   additionalProperties === false 时不允许额外字段
    if (schema.additionalProperties === false) {
      // Set：集合，快速查"有没有"
      const known = new Set(Object.keys(schema.properties))
      for (const k of Object.keys(obj))
        if (!known.has(k))
          errors.push(`${path}: 不允许的额外属性 "${k}"`)
    }
  }
}

// ════════════════════════════════════════════════════════════
//  【函数 2】extractJSON — 从 LLM 的"垃圾输出"里把 JSON 抠出来
// ════════════════════════════════════════════════════════════
//   调用方：ProfileAgent.extractViaLLM() 在 quickFixJSON 之后调
//   场景：LLM 返回 '好的，以下是结果：\n{ "name":"跑步" }\n希望有帮助'
//        extractJSON → 抠出 { "name":"跑步" } → 解析成对象
//
//   两步策略：
//   1. 先 try JSON.parse（万一 LLM 这次很乖，输出纯净 JSON）
//   2. 失败 → 用正则找最外层 { ... } 块
//
//   返回值：unknown（解析成功）或 null（彻底失败）
// 文件路径：server/src/core/structuredOutput.ts → extractJSON()
export function extractJSON(text: string): unknown | null {
  // 第一步：直接 try JSON.parse
  //   场景：LLM 输出纯净 JSON '{ "name":"跑步" }'
  //   text.trim()：去首尾空格（防 '\n{...}\n' 解析失败）
  try { return JSON.parse(text.trim()) } catch { /* 失败走第二步 */ }

  // 第二步：用正则从文本里找最外层的 { ... } 块
  //   场景：LLM 输出 '好的，以下是结果：\n{ "name":"跑步" }\n希望有帮助'
  //
  //   正则解释：/\{[\s\S]*\}/
  //   - \{ → 匹配字面量 {（{ 在正则里有特殊含义，要转义）
  //   - [\s\S]* → 匹配任意字符（包括换行）
  //     为什么不用 . ？因为 . 默认不匹配换行符
  //     \s 是空白字符，\S 是非空白字符，[\s\S] 合起来 = 任意字符
  //   - * → 0 次或多次（贪婪，尽量多匹配）
  //   - \} → 匹配字面量 }
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    // m[0] 是匹配到的第一个结果（完整的大括号块）
    //   match 返回数组，[0] 是完整匹配，[1] 是第一个捕获组...
    try { return JSON.parse(m[0]) } catch { /* 还是失败，放弃 */ }
  }

  return null  // 彻底失败
}

// ════════════════════════════════════════════════════════════
//  【函数 3】quickFixJSON — 给 JSON 打补丁（修常见格式问题）
// ════════════════════════════════════════════════════════════
//   调用方：ProfileAgent.extractViaLLM() 第一步先调这个修格式
//   场景：LLM 返回 '```json\n{ name: "跑步", }\n```'
//        quickFixJSON → '{ "name": "跑步" }'
//
//   处理顺序（很重要！）：
//   1. 去掉 markdown 代码块（```json ... ```）
//   2. 修尾逗号
//   3. 单引号 → 双引号
//   4. 无引号 key → 加引号
//   5. NaN/Infinity → null
//
//   为什么顺序重要？
//   - 必须先去 markdown 包裹，否则正则匹配不到内部 JSON
//   - 必须先修单引号再修无引号 key，否则会误伤
// 文件路径：server/src/core/structuredOutput.ts → quickFixJSON()
export function quickFixJSON(text: string): string {
  let f = text.trim()
    // ① 去掉 markdown 代码块包裹
    //   场景：```json\n{...}\n``` → {...}
    //   ^```：行首的 ```
    //   (?:json)?：可选的 'json'（?: 表示非捕获组）
    //   \s*\n?：可选的空格和换行
    //   i 标志：不区分大小写（防 ```JSON）
    .replace(/^```(?:json)?\s*\n?/i, '')
    // $：行尾
    .replace(/\n?```$/i, '')

    // ② 修尾逗号：,(空格)后面跟着 } 或 ] → 删掉逗号
    //   场景：{ "name":"跑步", } → { "name":"跑步" }
    //   正则：/,(\s*[}\]])/g
    //   - , → 字面量逗号
    //   - \s* → 0 个或多个空格
    //   - [}\]] → } 或 ]（注意 ] 在字符类里不用转义）
    //   - g 标志：全局替换（不只替换第一个）
    //   - $1 → 第一个括号匹配的内容（即 \s*[}\]]）
    .replace(/,(\s*[}\]])/g, '$1')

    // ③ 单引号 key → 双引号 key
    //   场景：{ 'name':'跑步' } → { "name":"跑步" }
    //   正则：/'([^']+)'(\s*):/g
    //   - ' → 字面量单引号
    //   - ([^']+) → 一个或多个非单引号字符（捕获组 1，即 key 内容）
    //   - ' → 字面量单引号
    //   - (\s*) → 可选空格（捕获组 2）
    //   - : → 字面量冒号
    //   替换："$1"$2: → 用双引号包 key
    .replace(/'([^']+)'(\s*):/g, '"$1"$2:')

    // ④ 无引号的 key → 加双引号
    //   场景：{ name: "跑步" } → { "name": "跑步" }
    //   正则：/([{,]\s*)([a-zA-Z_]\w*)\s*:/g
    //   - ([{,]\s*) → { 或 , 加空格（捕获组 1）
    //   - ([a-zA-Z_]\w*) → 字母/下划线开头 + 字母数字下划线（捕获组 2，即 key 名）
    //   - \s* → 可选空格
    //   - : → 冒号
    //   替换：$1"$2": → 保留前缀，给 key 加双引号
    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')

    // ⑤ NaN → null（JSON 不认 NaN）
    //   场景：{ "confidence": NaN } → { "confidence": null }
    //   \bNaN\b：\b 是单词边界（防止匹配 NaNxxx 这种）
    .replace(/\bNaN\b/g, 'null')

    // ⑥ Infinity → null（JSON 不认 Infinity）
    .replace(/\bInfinity\b/g, 'null')

  return f.trim()
}
