const http = require('http')
const fs = require('fs')
const API = 'http://127.0.0.1:4082'
const jar = {}
function request(method, path, body) {
  const url = new URL(path, API)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const headers = { accept: 'application/json' }
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length }
  const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  if (cookies) headers.cookie = cookies
  if (jar.ll_csrf) headers['x-csrf-token'] = jar.ll_csrf
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        for (const raw of res.headers['set-cookie'] || []) {
          const [pair] = raw.split(';'); const i = pair.indexOf('=')
          jar[pair.slice(0, i)] = pair.slice(i + 1)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null; try { json = text ? JSON.parse(text) : null } catch {}
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
;(async () => {
  const password = fs.readFileSync('/tmp/ll-mvp-006-ui/admin-pass.txt', 'utf8').trim()
  await request('GET', '/auth/csrf')
  const login = await request('POST', '/auth/login', { username: 'verify.admin', password })
  if (login.status !== 200) { console.error('LOGIN FAILED', login.status, login.text); process.exit(1) }
  console.log(JSON.stringify({ role: login.json.staff.role, username: login.json.staff.username }))
  fs.writeFileSync('/tmp/ll-mvp-006-ui/admin-session.json', JSON.stringify(jar))
  console.log('session cookies saved (not printed)')
})()
