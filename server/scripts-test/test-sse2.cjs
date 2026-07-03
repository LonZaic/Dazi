// 端到端 SSE 验证 V2：打印所有事件类型+时间戳，长超时
const http = require('http')

function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'e2etest1', password: 'Test1234' })
    const req = http.request({
      hostname: 'localhost', port: 8787, path: '/api/auth/login',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const cookie = res.headers['set-cookie']?.[0]?.split(';')[0] || ''
      let d = ''
      res.on('data', (c) => d += c)
      res.on('end', () => resolve(cookie))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function sendChat(cookie) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: '你好呀，我周末喜欢跑步' })
    const req = http.request({
      hostname: 'localhost', port: 8787, path: '/api/chat/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookie,
      },
      timeout: 120000,
    }, (res) => {
      console.log(`[${ts()}] Status: ${res.statusCode}`)
      let buf = ''
      let eventCount = 0
      let deltaText = ''
      let reasoningText = ''
      res.on('data', (chunk) => {
        buf += chunk.toString()
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''
        for (const part of parts) {
          const lines = part.split('\n')
          let evt = '', data = ''
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue
          eventCount++
          let j
          try { j = JSON.parse(data) } catch { j = { raw: data } }
          console.log(`[${ts()}] event=${evt} data=${JSON.stringify(j).slice(0, 120)}`)
          if (evt === 'delta' && j.text) deltaText += j.text
          if (evt === 'reasoning' && j.text) reasoningText += j.text
        }
      })
      res.on('end', () => {
        console.log(`\n[${ts()}] === END ===`)
        console.log(`事件数: ${eventCount}`)
        console.log(`AI正文(${deltaText.length}): ${deltaText}`)
        console.log(`思考(${reasoningText.length}): ${reasoningText.slice(0, 200)}`)
        resolve()
      })
      res.on('error', (e) => {
        console.log(`[${ts()}] ERROR: ${e.message}`)
        resolve()
      })
    })
    req.on('error', (e) => { console.log(`[${ts()}] REQ ERROR: ${e.message}`); resolve() })
    req.on('timeout', () => { console.log(`[${ts()}] TIMEOUT`); req.destroy() })
    req.write(body)
    req.end()
  })
}

function ts() { return new Date().toISOString().slice(11, 23) }

async function main() {
  console.log(`[${ts()}] 登录...`)
  const cookie = await login()
  console.log(`[${ts()}] 登录成功, cookie=${cookie.slice(0, 30)}...`)
  console.log(`[${ts()}] 发消息...`)
  await sendChat(cookie)
}

main().catch(e => console.error(e))
