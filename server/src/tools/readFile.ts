// ============================================================
// readFile.ts — 文件读取工具
// ============================================================
import { basename } from 'path'

// 文本文件扩展名
const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'pyw', 'java', 'kt', 'kts',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  'go', 'rs', 'rb', 'php', 'swift', 'scala',
  'sql', 'prisma', 'graphql', 'gql',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'sh', 'bash', 'zsh', 'bat', 'ps1',
  'vue', 'svelte', 'astro', 'env', 'dockerfile', 'makefile', 'r',
])

// ─── 工具定义（OpenAI/DeepSeek function calling schema）───
export const readFileDef = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: '读取用户上传的文件内容，支持代码/文档/简历/笔记等文本文件。用这个工具来了解用户文件中写了什么、做过什么项目、有什么技能等。',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名，如 resume.md 或 project.ts' },
      },
      required: ['fileName'],
    },
  },
}

// ─── 内存缓存：userId::fileName → content ───
const cache = new Map<string, string>()

export function cacheFile(userId: string, fileName: string, content: string) {
  cache.set(`${userId}::${fileName}`, content)
}

export function clearUserCache(userId: string) {
  for (const k of cache.keys()) if (k.startsWith(`${userId}::`)) cache.delete(k)
}

// ─── 执行 ───
// 不再截断：让 AI 能完整读取并原样输出文件内容
// 大文件保护：单文件 > 200000 字符时才分段提示
const MAX_CHARS = 200000
export async function executeReadFile(args: { fileName: string }, userId: string): Promise<string> {
  const name = basename(args.fileName)
  const key = `${userId}::${name}`

  const content = cache.get(key)
  if (!content) {
    const list = [...cache.keys()]
      .filter(k => k.startsWith(`${userId}::`))
      .map(k => k.split('::')[1])
      .join(', ')
    return `文件 "${name}" 未上传。当前已上传的文件：${list || '无'}`
  }

  if (content.length > MAX_CHARS) {
    const head = content.slice(0, MAX_CHARS)
    return `[${name}，${content.length}字符（已截取前${MAX_CHARS}字符，如需后续内容请说明）]\n${head}`
  }
  return `[${name}，${content.length}字符]\n${content}`
}

export function isTextFile(name: string): boolean {
  const ext = (name || '').split('.').pop()?.toLowerCase() || ''
  return TEXT_EXTS.has(ext)
}
