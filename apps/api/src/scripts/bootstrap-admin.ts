import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { createDatabase } from '../db/client.js'
import { auditLogs, staffAccounts, users } from '../db/schema.js'
import { loadConfig } from '../config.js'
import { hashPassword } from '../auth/security.js'

function question(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    terminal.question(prompt, (answer) => {
      terminal.close()
      resolve(answer.trim())
    })
  })
}

function hiddenQuestion(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('请在交互式终端运行，以便隐藏输入密码'))
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    let value = ''
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          process.stdin.setRawMode(false)
          process.stdin.off('data', onData)
          process.stdin.pause()
          reject(new Error('已取消'))
          return
        }
        if (character === '\r' || character === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.off('data', onData)
          process.stdin.pause()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  const username = (await question('管理员登录名（3-32 位）: ')).toLowerCase()
  const displayName = await question('管理员显示名称: ')
  const password = await hiddenQuestion('初始密码（至少 12 位，不回显）: ')
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new Error('登录名格式不正确')
  if (!displayName || displayName.length > 40) throw new Error('显示名称格式不正确')
  if (password.length < 12 || password.length > 128) throw new Error('密码长度必须为 12-128 位')

  const config = loadConfig(process.env)
  const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
  const { db, sqlite } = createDatabase(config.databasePath, migrationsFolder)

  try {
    if (db.select().from(staffAccounts).where(eq(staffAccounts.role, 'admin')).get()) {
      throw new Error('管理员账户已存在；请由现有管理员在后台创建后续账户')
    }
    if (db.select().from(staffAccounts).where(eq(staffAccounts.username, username)).get()) {
      throw new Error('该登录名已存在')
    }

    const now = new Date()
    const userId = randomUUID()
    const staffId = randomUUID()
    const passwordHash = await hashPassword(password)
    db.transaction((tx) => {
      tx.insert(users)
        .values({ id: userId, displayName, createdAt: now, updatedAt: now })
        .run()
      tx.insert(staffAccounts)
        .values({
          id: staffId,
          userId,
          username,
          passwordHash,
          role: 'admin',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      tx.insert(auditLogs)
        .values({
          id: randomUUID(),
          actorUserId: userId,
          event: 'staff.bootstrap_admin',
          targetId: staffId,
          metadata: null,
          createdAt: now,
        })
        .run()
    })
    process.stdout.write('管理员账户创建成功。请妥善保管密码；本命令不会再次显示。\n')
  } finally {
    sqlite.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`管理员初始化失败：${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
})
