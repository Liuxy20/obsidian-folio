import assert from 'node:assert/strict';
import { generateWithCodex, generateNoteWithCodex, codexStatus } from '../server/codex.js';
import { inspect, validateReplacement, replaceElements } from '../server/documents.js';
if(process.argv[2]==='notes') {
  const {captureNote,validateNoteResult}=await import('../obsidian/notes.js');
  const note='# 合成测试\n\n本周完成了 12 项改进。\n';const start=note.indexOf('本周');const capture=captureNote('合成测试.md',note,start,note.length-1);
  const edit=validateNoteResult(await generateNoteWithCodex({capture,mode:'edit',instruction:'改成“本周已完成 12 项改进。”，只返回这句话。',preserveNumbers:true}),capture,'edit',true);
  assert.equal(edit.replacement,'本周已完成 12 项改进。');
  const answer=validateNoteResult(await generateNoteWithCodex({capture,mode:'ask',instruction:'笔记中完成了多少项改进？请引用原文行号。'}),capture,'ask');
  assert.match(answer.answer,/12/);assert.ok(answer.citations.some(c=>c.startLine===3 && c.endLine===3));
  console.log(JSON.stringify({markdownCodex:true,edit,answer}));process.exit(0);
}
const source = '<!doctype html><html><head><title>合成测试</title><style>h1{font-size:42px;color:#000}</style></head><body><h1>产品观察</h1><p>本周完成了 12 项改进。</p></body></html>';
const doc = inspect(source), block = doc.elements.find(e => e.tag === 'h1');
console.log(JSON.stringify(await codexStatus()));
try {
  const result = await generateWithCodex({ block, instruction: '字号改成30px，文字颜色用深绿色 #286353，保留标题文字。', context: 'Selected h1 computed font-size is 42px and color is black. Parent is body.', preserveNumbers: true, onProgress: message => console.log(message) });
  validateReplacement(result.html, block, true);
  const changed = replaceElements(source, [{ targetId: block.id, expected: block.html, html: result.html }], doc.version);
  assert.match(result.html, /style=/); assert.match(result.html, /30px/); assert.match(result.html, /#286353|rgb\(\s*40\s*,\s*99\s*,\s*83\s*\)/i);
  assert.equal(changed.elements.find(e => e.tag === 'h1').text, block.text);
  assert.equal(changed.elements.find(e => e.tag === 'p').html, doc.elements.find(e => e.tag === 'p').html);
  console.log(JSON.stringify({ success: true, ...result }));
} catch (e) { console.error(JSON.stringify({ success: false, message: e.message })); process.exitCode = 1; }
