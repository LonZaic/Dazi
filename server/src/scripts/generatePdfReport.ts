/**
 * generatePdfReport.ts — 从 latest-report.html 生成白纸黑字黑框 PDF
 * 用法：npx tsx src/scripts/generatePdfReport.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const REPORT_HTML = path.resolve(__dirname, '../../reports/latest-report.html')
const PDF_OUT = path.resolve(__dirname, '../../reports/MatchMate-测试报告.pdf')
const STYLE_OUT = path.resolve(__dirname, '../../reports/formal-report.html')

function cleanHtml(html: string): string {
  return html
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/class="mbti-badge[^"]*"/gi, 'style="display:inline-block;padding:2px 8px;border:1px solid #000;font-size:11px;font-weight:700;background:#fff"')
    .replace(/class="highlight /gi, 'class="')
    .replace(/class="meta"/gi, 'style="font-size:12px;color:#000;margin:8px 0"')
    .replace(/class="timeline"/gi, 'style="display:none"')
    .replace(/style="color:#10b981"/gi, 'style="color:#000"')
    .replace(/style="color:#888"/gi, 'style="color:#555"')
    .replace(/background: #10b98115/gi, 'background: #f0f0f0')
}

function buildFormalHtml(originalHtml: string): string {
  const bodyStart = originalHtml.indexOf('<body>')
  const bodyEnd = originalHtml.indexOf('</body>')
  const body = bodyStart >= 0 && bodyEnd > bodyStart
    ? originalHtml.slice(bodyStart + 6, bodyEnd)
    : originalHtml

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>MatchMate 系统测试报告</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "SimSun", sans-serif;
    font-size: 13px;
    color: #000;
    background: #fff;
    margin: 20px 30px;
    line-height: 1.6;
  }
  h1 { font-size: 22px; text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; }
  h2 { font-size: 16px; border-bottom: 1.5px solid #000; padding-bottom: 4px; margin-top: 30px; }
  h3 { font-size: 14px; margin-top: 20px; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0 20px 0;
    font-size: 12px;
  }
  th, td {
    border: 1.5px solid #000;
    padding: 6px 8px;
    text-align: center;
  }
  th { background: #000; color: #fff; font-weight: 700; }
  tr:nth-child(even) { background: #f8f8f8; }
  pre {
    font-size: 11px;
    background: #f5f5f5;
    border: 1px solid #000;
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  small { color: #555; }
  .timeline { display: none; }
  @page { size: A4; margin: 15mm; }
</style>
</head>
${body}
</html>`
}

async function main() {
  const html = fs.readFileSync(REPORT_HTML, 'utf-8')
  const formal = buildFormalHtml(html)
  fs.writeFileSync(STYLE_OUT, formal, 'utf-8')
  console.log(`📄 格式化 HTML 已生成：${STYLE_OUT}`)

  // 用 Edge 无头模式转 PDF
  const edgeCandidates = [
    '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
    '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
  ]

  let edgePath = ''
  for (const ep of edgeCandidates) {
    try {
      execSync(`if exist ${ep} (exit 0) else (exit 1)`, { shell: 'cmd' })
      edgePath = ep
      break
    } catch { /* not found */ }
  }

  if (!edgePath) {
    console.log('⚠ Edge 未找到，用 Chrome 尝试...')
    edgePath = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
  }

  const fileUrl = `file:///${STYLE_OUT.replace(/\\/g, '/')}`
  const cmd = `${edgePath} --headless --disable-gpu --print-to-pdf="${PDF_OUT}" --no-pdf-header-footer "${fileUrl}"`

  try {
    execSync(cmd, { shell: 'cmd', stdio: 'pipe', timeout: 30000 })
    console.log(`✅ PDF 已生成：${PDF_OUT}`)
  } catch (err: any) {
    console.log(`⚠ Edge 转 PDF 失败：${err.message}`)
    console.log(`   HTML 报告可用：${STYLE_OUT}（请在浏览器打开后 Ctrl+P 另存为 PDF）`)
  }
}

main().catch(console.error)
