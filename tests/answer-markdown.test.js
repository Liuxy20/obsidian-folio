import test from 'node:test';
import assert from 'node:assert/strict';
import { answerHTML } from '../obsidian/answer-markdown.js';

test('回答渲染 Markdown：标题、强调、列表、引用、表格和代码块',()=>{
  const html=answerHTML('# 标题\n\n**加粗**、*强调*、`code`\n\n1. 第一项\n2. 第二项\n\n> 引用\n\n| 技能 | 用途 |\n| --- | --- |\n| search | 检索 |\n\n```js\nconst count = 12;\n```');
  for(const tag of ['h1','strong','em','code','ol','li','blockquote','table','pre'])assert.match(html,new RegExp('<'+tag+'[ >]'));
  assert.match(html,/const count = 12;/);assert.doesNotMatch(html,/\*\*加粗\*\*/);
});

test('回答只展示内容：HTML 转义、图片不加载、危险链接不生效、代码不执行',()=>{
  const html=answerHTML('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n![image](https://example.com/image.png)\n\n[危险](javascript:alert(1)) [本地](file:///tmp/file) [协议](obsidian://open) [正常](https://example.com)\n\n```dataviewjs\nalert(1)\n```');
  assert.doesNotMatch(html,/<(?:img|script|iframe)\b/i);
  assert.doesNotMatch(html,/href="(?:javascript|file|obsidian):/i);
  assert.match(html,/&lt;img/);assert.match(html,/rel="noopener noreferrer"/);
  assert.match(html,/<pre><code class="language-dataviewjs">alert\(1\)/);
});
