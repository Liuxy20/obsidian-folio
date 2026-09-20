import { captureNote, validateNoteResult } from './notes.js';
import { hash, UserError, MAX_DOCUMENT_BYTES } from '../server/documents.js';

// A quote may move; it must never silently bind to an ambiguous duplicate.
export function relocateCapture(capture, source) {
  if (!capture?.expected || typeof source !== 'string') throw new UserError('这段原文已删除，请重新关联选区。', 409);
  if (hash(source) === capture.version && source.slice(capture.start, capture.end) === capture.expected) return capture;
  // Old captures cannot prove uniqueness outside their saved context.
  if (capture.ambiguous === undefined) {
    const context = (capture.context || []).map(line => line.text).join(capture.newline || '\n');
    const first = context.indexOf(capture.expected);
    if (capture.partial || first < 0 || context.indexOf(capture.expected, first + 1) !== -1) throw new UserError('旧留言无法唯一匹配原文，请重新关联选区。', 409);
  }
  if (capture.ambiguous && !capture.prefix && !capture.suffix) throw new UserError('原文无法唯一匹配，请重新关联选区。', 409);
  const matches = [];
  let from = 0, at;
  while ((at = source.indexOf(capture.expected, from)) !== -1) {
    matches.push(at); from = at + 1;
    if (matches.length > 1000) throw new UserError('原文重复过多，请重新关联选区。', 409);
  }
  let candidates = matches;
  if ((matches.length > 1 || capture.ambiguous) && (capture.prefix || capture.suffix)) candidates = matches.filter(start =>
    (!capture.prefix || source.slice(0, start).endsWith(capture.prefix)) &&
    (!capture.suffix || source.slice(start + capture.expected.length).startsWith(capture.suffix)));
  if (candidates.length !== 1) throw new UserError(matches.length ? '原文有多处匹配，请重新关联选区。' : '这段原文已改变，请重新关联选区。', 409);
  return captureNote(capture.path, source, candidates[0], candidates[0] + capture.expected.length);
}
export function recordCapture(record, source) { if(record.removed)throw new UserError('原文已删除，请重新关联选区。',409); return relocateCapture(record.anchor || record.capture, source); }

export function planNoteChanges(source, records) {
  if (!Array.isArray(records) || !records.length || records.length > 30) throw new UserError('请选择 1–30 条待采用的修改。');
  const path = records[0].capture.path, seen = new Set();
  const changes = records.map(record => {
    if (seen.has(record.id) || record.capture.path !== path || record.mode !== 'edit' || record.state !== 'ready') throw new UserError('修改清单包含重复、跨文档或已处理的建议。');
    seen.add(record.id);
    const capture = relocateCapture(record.capture, source);
    const result = validateNoteResult(record.result, capture, 'edit', record.preserveNumbers);
    return { record, capture, replacement: result.replacement };
  }).sort((a, b) => a.capture.start - b.capture.start);
  for (let i = 1; i < changes.length; i++) if (changes[i].capture.start < changes[i - 1].capture.end) throw new UserError('所选修改范围重叠，请只保留其中一条。', 409);
  let next = source;
  for (const c of [...changes].reverse()) next = next.slice(0, c.capture.start) + c.replacement + next.slice(c.capture.end);
  if (Buffer.byteLength(next) > MAX_DOCUMENT_BYTES) throw new UserError('修改后笔记超过 5 MB。');
  let shift = 0;
  for (const c of changes) {
    const start = c.capture.start + shift;
    c.anchor = c.replacement.trim() ? captureNote(path, next, start, start + c.replacement.length) : null;
    shift += c.replacement.length - (c.capture.end - c.capture.start);
  }
  return { path, version: hash(source), next, changes };
}

export function reviewContext(source) {
  if (!source?.trim() || Buffer.byteLength(source) > 60_000) throw new UserError('审稿支持 60 KB 内的笔记；较长内容请分成独立笔记后审阅。');
  return source.split('\n').map((text, i) => ({ line: i + 1, text: text.replace(/\r$/, '') }));
}
export function validateReview(result, path, source) {
  reviewContext(source);
  if (!Array.isArray(result?.issues) || result.issues.length > 5) throw new UserError('审稿结果格式不正确，请重试。');
  const seen = new Set();
  return result.issues.map(issue => {
    const { quote, startLine, endLine, title, comment, category } = issue;
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 6000 || typeof title !== 'string' || !title.trim() || title.length > 120 || typeof comment !== 'string' || !comment.trim() || comment.length > 2000 || !['clarity','repetition','evidence','structure'].includes(category) || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) throw new UserError('审稿结果包含无效意见。');
    const lines = source.split(/(?<=\n)/);
    if (endLine > lines.length) throw new UserError('审稿意见引用了不存在的行。');
    const offset = lines.slice(0, startLine - 1).join('').length;
    const region = lines.slice(startLine - 1, endLine).join('');
    const normalized = quote.replace(/\r\n|\r|\n/g, source.includes('\r\n') ? '\r\n' : '\n');
    const start = region.indexOf(normalized);
    if (start < 0 || region.indexOf(normalized, start + 1) !== -1) throw new UserError('审稿意见无法唯一对应原文，已拦截。');
    const capture = captureNote(path, source, offset + start, offset + start + normalized.length);
    if (seen.has(capture.start + ':' + capture.end)) throw new UserError('审稿意见重复，请重试。');
    seen.add(capture.start + ':' + capture.end);
    return { capture, title, comment, category };
  });
}

export function conversationHistory(record) {
  if (!record) return [];
  const turns = [...(record.turns || [])];
  if (record.result) turns.push({ message: record.message, mode: record.mode, result: record.result, quote:record.quote });
  // Newest turns first for budgeting; restore chronological order for the model.
  let bytes = 0; const selected = [];
  for (const turn of turns.slice(-8).reverse()) {
    const clean = { message: String(turn.message || '').slice(0, 2000), mode: turn.mode, response: String(turn.result?.answer || turn.result?.replacement || turn.result?.summary || '').slice(0, 5000) };
    if(turn.quote)clean.quotedAnswer={round:turn.quote.turnIndex+1,text:String(turn.quote.text||'').slice(0,2000)};
    const size = Buffer.byteLength(JSON.stringify(clean)); if (bytes + size > 16_000) break;
    bytes += size; selected.unshift(clean);
  }
  return selected;
}
