import MarkdownIt from 'markdown-it';

// Answers are model output, not vault documents: don't run Obsidian code-block
// processors or load embedded notes/images while displaying them.
const markdown=new MarkdownIt({html:false,linkify:false,breaks:false}).disable('image');
const defaultLink=markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open=(tokens,index,options,env,self)=>{
  const token=tokens[index],href=token.attrGet('href')||'';
  if(!/^(https?:\/\/|mailto:)/i.test(href))token.attrs=token.attrs?.filter(([key])=>key!=='href');
  else {token.attrSet('target','_blank');token.attrSet('rel','noopener noreferrer');}
  return defaultLink?defaultLink(tokens,index,options,env,self):self.renderToken(tokens,index,options);
};

export function answerHTML(answer){return markdown.render(answer);}
export function renderAnswer(container,answer){
  container.classList.add('folio-answer-markdown');
  container.innerHTML=answerHTML(answer);
}
