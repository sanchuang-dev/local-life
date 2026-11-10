import {
  externalOfferImportItemSchema, type ExternalOfferImportItem,
} from '@sanchuang-dev/local-life-contracts'

const HEADER = ['活动名称', '平台', '分类', '简介', '外部HTTPS链接', '排序', '截止时间'] as const
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_SHEET_BYTES = 3 * 1024 * 1024

export interface PreviewOfferRow {
  rowNumber: number
  title: string
  item?: ExternalOfferImportItem
  error?: string
}

function decode(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes)
}

function requireXml(content: string): XMLDocument {
  const document = new DOMParser().parseFromString(content, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) {
    throw new Error('Excel XML 格式不正确')
  }
  return document
}

/** Extract only required OOXML entries; reject large or malformed ZIP input. */
async function readZipEntry(zip: Uint8Array, filename: string): Promise<string | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('无效的 Excel 文件（未找到 ZIP 目录）')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Excel ZIP 文件目录损坏')
    }
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const plainSize = view.getUint32(offset + 24, true)
    const nameSize = view.getUint16(offset + 28, true)
    const extraSize = view.getUint16(offset + 30, true)
    const commentSize = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decode(zip.subarray(offset + 46, offset + 46 + nameSize))
    offset += 46 + nameSize + extraSize + commentSize
    if (name !== filename) continue
    if (plainSize > MAX_SHEET_BYTES) throw new Error('Excel 工作表过大')
    if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('Excel ZIP 数据块损坏')
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > zip.length) throw new Error('Excel 数据块越界')
    const compressed = zip.slice(dataStart, dataStart + compressedSize)
    let output: Uint8Array
    if (method === 0) {
      output = compressed
    } else if (method === 8) {
      const stream = new Blob([compressed.buffer as ArrayBuffer]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
      const reader = stream.getReader()
      const parts: Uint8Array[] = []
      let total = 0
      while (true) {
        const part = await reader.read()
        if (part.done) break
        total += part.value.length
        if (total > MAX_SHEET_BYTES) {
          await reader.cancel()
          throw new Error('Excel 解压后超出大小限制')
        }
        parts.push(part.value)
      }
      output = new Uint8Array(total)
      let cursor = 0
      for (const part of parts) { output.set(part, cursor); cursor += part.length }
    } else {
      throw new Error('不支持的 Excel 压缩格式')
    }
    if (output.length !== plainSize) throw new Error('Excel 解压大小不匹配')
    return decode(output)
  }
  return null
}

function excelDate(value: string): string | null {
  if (!value.trim()) return null
  let raw = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += ' 23:59'
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    // Excel serial numbers represent local wall-clock time; interpret as China time.
    const serial = Number(raw)
    const date = new Date(Math.round((serial - 25569) * 86400000))
    if (!Number.isFinite(date.getTime())) throw new Error('截止时间无效')
    raw = date.toISOString().slice(0, 16).replace('T', ' ')
  }
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    throw new Error('截止时间请填写 YYYY-MM-DD HH:mm')
  }
  const date = new Date(raw.replace(' ', 'T').slice(0, 16) + ':00+08:00')
  if (!Number.isFinite(date.getTime())) throw new Error('截止时间无效')
  return date.toISOString()
}

function readCells(xml: string, shared: string[]): string[][] {
  const doc = requireXml(xml)
  const rows = Array.from(doc.getElementsByTagNameNS('*', 'row'))
  return rows.map((row) => {
    const values: string[] = Array(8).fill('')
    for (const cell of Array.from(row.getElementsByTagNameNS('*', 'c'))) {
      const ref = cell.getAttribute('r') ?? ''
      const column = /^[A-Z]+/.exec(ref)?.[0] ?? ''
      if (column.length !== 1) continue
      const idx = column.charCodeAt(0) - 65
      if (idx < 0 || idx >= values.length) continue
      const type = cell.getAttribute('t')
      const v = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? ''
      if (type === 's') values[idx] = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') values[idx] =
        Array.from(cell.getElementsByTagNameNS('*', 't')).map((part) => part.textContent ?? '').join('')
      else values[idx] = v
    }
    return values
  })
}

export async function previewExternalOffersExcel(file: File): Promise<PreviewOfferRow[]> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('请选择 .xlsx 格式的 Excel 文件')
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过5MB，请拆分导入')
  const zip = new Uint8Array(await file.arrayBuffer())
  const workbook = await readZipEntry(zip, 'xl/workbook.xml')
  if (!workbook) throw new Error('缺少 Excel 工作簿信息')
  const sheets = Array.from(requireXml(workbook).getElementsByTagNameNS('*', 'sheet'))
  if (sheets[0]?.getAttribute('name') !== '导入数据') {
    throw new Error('第一张工作表必须名为「导入数据」，请先下载标准模板')
  }
  const sharedXml = await readZipEntry(zip, 'xl/sharedStrings.xml')
  const shared = sharedXml
    ? Array.from(requireXml(sharedXml).getElementsByTagNameNS('*', 'si'))
      .map((node) => Array.from(node.getElementsByTagNameNS('*', 't'))
        .map((part) => part.textContent ?? '').join(''))
    : []
  const sheet = await readZipEntry(zip, 'xl/worksheets/sheet1.xml')
  if (!sheet) throw new Error('缺少第一张工作表')
  const rows = readCells(sheet, shared)
  if (!HEADER.every((name, index) => rows[0]?.[index]?.trim() === name)) {
    throw new Error('导入列名或列序不正确，请使用系统模板')
  }
  const dataRows = rows.slice(1).map((cells, i) => ({ cells, rowNumber: i + 2 }))
    .filter(({ cells }) => cells.slice(0, 7).some((cell) => cell.trim()))
  if (!dataRows.length) throw new Error('Excel 中没有可导入的活动')
  if (dataRows.length > 100) throw new Error('单次最多导入100条，请拆分文件')
  const keys = new Set<string>()
  return dataRows.map(({ cells, rowNumber }) => {
    const title = cells[0].trim()
    try {
      const candidate = externalOfferImportItemSchema.safeParse({
        title, platform: cells[1].trim(), category: cells[2].trim(),
        description: cells[3].trim() || null,
        url: cells[4].trim(), sortOrder: cells[5].trim() === '' ? 0 : Number(cells[5].trim()),
        expiresAt: excelDate(cells[6]),
      })
      if (!candidate.success) {
        return { rowNumber, title, error: candidate.error.issues.map((issue) => issue.message).join('；') }
      }
      const item = candidate.data
      const key = item.platform.toLowerCase() + '\n' + item.url
      if (keys.has(key)) return { rowNumber, title, error: '文件中「平台＋链接」重复' }
      keys.add(key)
      return { rowNumber, title, item }
    } catch (cause) {
      return { rowNumber, title, error: cause instanceof Error ? cause.message : '解析失败' }
    }
  })
}

function esc(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sheetXml(rows: string[][]) {
  const data = rows.map((row, i) =>
    '<row r="' + (i + 1) + '">' + row.map((value, col) => {
      const ref = String.fromCharCode(65 + col) + (i + 1)
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(value) + '</t></is></c>'
    }).join('') + '</row>',
  ).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetData>' + data + '</sheetData></worksheet>'
}

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let k = 0; k < 8; k += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function makeZip(files: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()
  for (const [name, content] of files) {
    const filename = enc.encode(name)
    const body = enc.encode(content)
    const crc = crc32(body)
    const local = new Uint8Array(30 + filename.length + body.length)
    const l = new DataView(local.buffer)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, 20, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, body.length, true)
    l.setUint32(22, body.length, true)
    l.setUint16(26, filename.length, true)
    local.set(filename, 30)
    local.set(body, 30 + filename.length)
    chunks.push(local)
    const central = new Uint8Array(46 + filename.length)
    const c = new DataView(central.buffer)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, body.length, true)
    c.setUint32(24, body.length, true)
    c.setUint16(28, filename.length, true)
    c.setUint32(42, offset, true)
    central.set(filename, 46)
    directory.push(central)
    offset += local.length
  }
  const dirSize = directory.reduce((n, bytes) => n + bytes.length, 0)
  const eocd = new Uint8Array(22)
  const e = new DataView(eocd.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, files.length, true)
  e.setUint16(10, files.length, true)
  e.setUint32(12, dirSize, true)
  e.setUint32(16, offset, true)
  const result = new Uint8Array(offset + dirSize + eocd.length)
  let pos = 0
  for (const chunk of [...chunks, ...directory, eocd]) {
    result.set(chunk, pos)
    pos += chunk.length
  }
  return result
}

export function downloadExternalOffersTemplate() {
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="导入数据" sheetId="1" r:id="rId1"/>'
    + '<sheet name="使用说明" sheetId="2" r:id="rId2"/></sheets></workbook>'
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
    + '</Relationships>'
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>'
  const instructions = [
    ['列名', '填报要求'],
    ...HEADER.map((name, i) => [name, [
      '必填，最多80字', '必填，例如美团或淘宝闪购', '必填，例如餐饮外卖或购物零售',
      '可空，最多300字', '完整HTTPS网页地址，不可用HTTP、tbopen://、小程序路径',
      '可空，0-10000整数', '可空，使用YYYY-MM-DD HH:mm（北京时间）',
    ][i]]),
    ['导入说明', '只导入有效行，全部默认下架；需核验后手动启用；一次最多100条'],
  ]
  const zipped = makeZip([
    ['[Content_Types].xml', types], ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', rels],
    ['xl/worksheets/sheet1.xml', sheetXml([Array.from(HEADER)])],
    ['xl/worksheets/sheet2.xml', sheetXml(instructions)],
  ])
  const blob = new Blob([zipped.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '本地生活_精选优惠导入模板.xlsx'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
