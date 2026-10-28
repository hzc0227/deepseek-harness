/**
 * Local procurement workbook parsing with source-row identities and cached formula values.
 * File access and byte limits belong to the calling filesystem tool.
 * @author hanzhichao7
 */
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import ExcelJS from 'exceljs'
import { hasBusinessPrecision } from './quantity.ts'

/** One source material; additional procurement columns remain data, never instructions. */
export interface ParsedMaterial {
  /** Stable identity within the source workbook, including its physical row number. */
  id: string
  /** Source material name. */
  name: string
  /** Source brand, or an empty string when unspecified. */
  brand: string
  /** Source model or specification text. */
  model: string
  /** Source procurement unit. */
  unit: string
  /** Positive source quantity. */
  quantity: number
  /** Nonempty source columns not represented by the fields above. */
  attributes: Record<string, string>
}

/** Complete extracted input before recognition or business-rule enrichment. */
export interface ParsedMaterialFile {
  /** Customer master-data number, absent when the source does not declare one. */
  contractNumber?: string
  /** Materials in workbook sheet and physical row order. */
  materials: ParsedMaterial[]
}

type Field = 'name' | 'brand' | 'model' | 'unit' | 'quantity'
const REQUIRED_FIELDS = ['name', 'model', 'unit', 'quantity'] as const
const FIELD_LABELS: Record<Field, string> = {
  name: '物料名称', brand: '品牌', model: '规格参数或型号', unit: '需求单位', quantity: '采购数量',
}
const FIELD_HEADERS: Record<Field, readonly string[]> = {
  name: ['采购物料物资名称', '采购物料名称', '物料名称', '物资名称', '商品名称', 'materialname', 'name'],
  brand: ['品牌', 'brand'],
  model: ['规格参数尽量穷举or型号', '规格参数尽量穷举或型号', '规格参数or型号', '规格参数或型号', '规格型号', '规格参数', '型号', 'model'],
  unit: ['需求单位', '采购单位', '单位', 'unit'],
  quantity: ['采购数量', '需求数量', '数量', 'quantity'],
}

/**
 * Read source values without executing formulas, following hyperlinks, or evaluating embedded text.
 * @param value - ExcelJS cell value, including cached formula results and rich text.
 * @param location - Sheet and cell address included in actionable parse failures.
 * @returns Trimmed scalar text; empty cells produce an empty string.
 */
function cellText(value: ExcelJS.CellValue, location: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return String(value).trim()
  if (value instanceof Date) return value.toISOString()
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined) throw new Error(`${location} 的公式没有缓存结果，请先在表格软件中计算并保存。`)
    return cellText(value.result, location)
  }
  if ('richText' in value) return value.richText.map(part => part.text).join('').trim()
  if ('text' in value) return value.text.trim()
  throw new Error(`${location} 包含表格错误 ${value.error}，请修正后重试。`)
}

/**
 * Match explicit procurement column names while ignoring required markers and formatting punctuation.
 * @param value - Source header text.
 * @returns Its canonical material field, or undefined for an additional attribute column.
 */
function fieldOf(value: string): Field | undefined {
  const normalized = value.replace(/[\s*＊()（）:：]/gu, '').toLowerCase()
  return (Object.keys(FIELD_HEADERS) as Field[]).find(field => FIELD_HEADERS[field].includes(normalized))
}

/**
 * Find the most complete procurement header, rejecting repeated equally complete tables.
 * @param sheet - Parsed worksheet, including metadata and instruction rows.
 * @returns Header row number, or undefined for a worksheet without a material table.
 */
function headerRow(sheet: ExcelJS.Worksheet): number | undefined {
  let best = 0
  let candidates: number[] = []
  sheet.eachRow((row) => {
    const fields = new Set<Field>()
    row.eachCell((cell) => {
      const field = fieldOf(cellText(cell.value, `${sheet.name}!${cell.address}`))
      if (field !== undefined && field !== 'brand') fields.add(field)
    })
    if (fields.size < 2 || fields.size < best) return
    if (fields.size > best) candidates = []
    best = fields.size
    candidates.push(row.number)
  })
  if (candidates.length > 1) throw new Error(`工作表“${sheet.name}”有多个物料表头（第 ${candidates.join('、')} 行），请拆分到不同工作表。`)
  return candidates[0]
}

/**
 * Extract explicitly labeled customer master numbers before the material table.
 * @param sheet - Worksheet containing optional customer metadata.
 * @param endRow - First material header row; metadata-only sheets scan all their rows.
 * @param numbers - Workbook-owned set used to detect conflicting customer declarations.
 */
function readContractNumber(sheet: ExcelJS.Worksheet, endRow: number, numbers: Set<string>): void {
  sheet.eachRow((row) => {
    if (row.number >= endRow) return
    row.eachCell((cell) => {
      const text = cellText(cell.value, `${sheet.name}!${cell.address}`)
      if (!/^(?:客户合同|客户|合同)?主数据(?:号|编号|编码)[：:]?/u.test(text)) return
      const adjacent = row.getCell(Number(cell.col) + 1)
      const declaration = `${text} ${cellText(adjacent.value, `${sheet.name}!${adjacent.address}`)}`
      for (const match of declaration.matchAll(/\b[A-Za-z]{3}-[0-9]{6,}\b/gu)) numbers.add(match[0])
    })
  })
}

/**
 * Extract one table only after its required columns are unambiguously identified.
 * @param sheet - Source worksheet.
 * @param rowNumber - Header row previously selected from source labels.
 * @param materials - Accumulated workbook materials; appended only for complete, valid rows.
 * @param maxRows - Maximum material count across the complete workbook.
 */
function readMaterials(sheet: ExcelJS.Worksheet, rowNumber: number, materials: ParsedMaterial[], maxRows: number): void {
  const columns = new Map<Field, number>()
  const attributes = new Map<string, number>()
  sheet.getRow(rowNumber).eachCell((cell) => {
    const label = cellText(cell.value, `${sheet.name}!${cell.address}`)
    if (!label) return
    const field = fieldOf(label)
    if (field !== undefined) {
      if (columns.has(field)) throw new Error(`工作表“${sheet.name}”的“${FIELD_LABELS[field]}”存在重复映射，请保留一列。`)
      columns.set(field, Number(cell.col))
    } else {
      if (attributes.has(label)) throw new Error(`工作表“${sheet.name}”的附加列“${label}”重名，请重命名。`)
      attributes.set(label, Number(cell.col))
    }
  })
  const missing = REQUIRED_FIELDS.filter(field => !columns.has(field))
  if (missing.length) throw new Error(`工作表“${sheet.name}”缺少必要列：${missing.map(field => FIELD_LABELS[field]).join('、')}。`)
  sheet.eachRow((row) => {
    if (row.number <= rowNumber) return
    const values = { name: '', brand: '', model: '', unit: '', quantity: '' }
    for (const [field, column] of columns) {
      const cell = row.getCell(column)
      values[field] = cellText(cell.value, `${sheet.name}!${cell.address}`)
    }
    const extraEntries: [string, string][] = []
    for (const [label, column] of attributes) {
      const cell = row.getCell(column)
      const value = cellText(cell.value, `${sheet.name}!${cell.address}`)
      if (value) extraEntries.push([label, value])
    }
    const extra = Object.fromEntries(extraEntries)
    if (Object.values(values).every(value => !value) && Object.keys(extra).length === 0) return
    if (materials.length >= maxRows) throw new Error(`物料数量超过 ${maxRows} 条，请拆分文件。`)
    const empty = REQUIRED_FIELDS.filter(field => !values[field])
    if (empty.length) throw new Error(`工作表“${sheet.name}”第 ${row.number} 行缺少：${empty.map(field => FIELD_LABELS[field]).join('、')}。`)
    const quantity = Number(values.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity >= 1e10 || !hasBusinessPrecision(quantity)) {
      throw new Error(`工作表“${sheet.name}”第 ${row.number} 行采购数量必须为正数，整数最多10位、小数最多4位。`)
    }
    materials.push({
      id: `${sheet.name}:${row.number}`, name: values.name, brand: values.brand,
      model: values.model, unit: values.unit, quantity, attributes: extra,
    })
  })
}

/**
 * Parse local XLSX or UTF-8 CSV procurement input without altering the source file.
 * Metadata may precede the header, brands may be blank, and stable identities retain physical rows.
 * Missing required columns or values, conflicting customer numbers, invalid quantities, ambiguous
 * headers, unsupported formats and material counts above maxRows reject the complete parse.
 * @param bytes - Complete file bytes read under the caller's filesystem and size policy.
 * @param fileName - Source filename; its extension selects XLSX or CSV decoding.
 * @param maxRows - Positive maximum material count across all worksheets.
 * @returns Customer metadata and complete validated source materials, with no inferred values.
 */
export async function parseMaterialFile(bytes: Uint8Array, fileName: string, maxRows: number): Promise<ParsedMaterialFile> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('物料行数限制必须为正整数。')
  const workbook = new ExcelJS.Workbook()
  const extension = extname(fileName).toLowerCase()
  if (extension === '.xlsx') {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  } else if (extension === '.csv') {
    await workbook.csv.read(Readable.from([Buffer.from(bytes)]), {
      sheetName: 'CSV', map: (value: string): string => value,
    })
  } else {
    throw new Error('请选择 .xlsx 或 UTF-8 .csv 物料文件。')
  }
  const materials: ParsedMaterial[] = []
  const contractNumbers = new Set<string>()
  for (const sheet of workbook.worksheets) {
    const header = headerRow(sheet)
    readContractNumber(sheet, header ?? sheet.rowCount + 1, contractNumbers)
    if (header !== undefined) readMaterials(sheet, header, materials, maxRows)
  }
  if (contractNumbers.size > 1) throw new Error('文件包含多个不同的客户主数据号，请明确本次提报客户后重试。')
  if (materials.length === 0) throw new Error('未找到物料数据，请检查表头是否包含物料名称、规格型号、需求单位和采购数量。')
  const contractNumber = contractNumbers.values().next().value
  return { ...(contractNumber !== undefined ? { contractNumber } : {}), materials }
}
