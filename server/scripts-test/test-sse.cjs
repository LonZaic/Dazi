// 端到端 SSE 验证：登录 → 发消息 → 读取 SSE 流
const Database = require('better-sqlite3')

async function main() {
  // 1. 登录拿 cookie
  const loginResp = await fetch('http://localhost:8787/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2etest1', password: 'Test1234' }),
  })
  const cookie = loginResp.headers.get('set-cookie')
  const token = cookie ? cookie.split(';')[0] : ''
  console.log('登录:', loginResp.status, token ? '有 token' : '无 token')

  const loginJson = await loginResp.json()
  console.log('用户:', loginJson.user.username)

  // 2. 发消息读 SSE 流
  console.log('\n--- 发消息 ---')
  const resp = await fetch('http://localhost:8787/api/chat/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': token,
    },
    body: JSON.stringify({ content: '你好呀，我周末喜欢跑步，也打羽毛球' }),
  })
  console.log('Status:', resp.status, 'CT:', resp.headers.get('content-type'))

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let fullText = ''
  let buf = ''
  let eventCount = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventCount++
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        try {
          const j = JSON.parse(data)
          if (j.text) {
            fullText += j.text
            process.stdout.write(j.text)
          } else if (eventCount > 0) {
            console.log('\n[meta/done]', JSON.stringify(j).slice(0, 200))
          }
        } catch { /* skip */ }
      }
    }
  }
  console.log('\n--- 完成 ---')
  console.log('事件数:', eventCount, 'AI 回复长度:', fullText.length)
  console.log('AI 回复全文:', fullText)

  // 3. 查 DB 确认消息保存
  const db = new Database('./server/data/matchmate.db')
  const rows = db.prepare(`
    SELECT role, substr(content,1,100) as preview FROM conversations
    WHERE user_id = (SELECT id FROM users WHERE username = 'e2etest1')
    ORDER BY id DESC LIMIT 4
  `).all()
  console.log('\n--- DB 最近消息 ---')
  for (const r of rows) console.log(`[${r.role}] ${r.preview}`)
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })
