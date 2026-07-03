import { getDB } from './src/db/index.js'
const r = getDB().prepare(`SELECT id, username, display_name FROM users WHERE username IN ('alice_intj','bob_enfp','carol_isfj','david_entp')`).all()
console.log(JSON.stringify(r, null, 2))
