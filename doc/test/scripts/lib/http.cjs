const fs=require('node:fs');
const path=require('node:path');
const repo=path.resolve(__dirname,'../../../..');
const request=require(path.join(repo,'node_modules/superagent'));
const base=process.env.HYDRO_TEST_BASE_URL||'http://localhost:8082';
const prefix='/d/'+(process.env.HYDRO_TEST_DOMAIN||'exam');
function credential(role) {
 const label=role==='admin'?'管理员角色':'学生角色';
 const lines=fs.readFileSync(process.env.HYDRO_TEST_CREDENTIALS||path.join(repo,'testuser.txt'),'utf8').split(/\r?\n/);
 const boundary=lines.findIndex(s=>s.includes('生产'));
 const line=(boundary<0?lines:lines.slice(0,boundary)).find(s=>s.trim().startsWith(label));
 if(!line) throw Error('Missing local role');
 const pair=line.slice(line.search(/[:：]/)+1).trim();
 const delimiter=pair.indexOf('/');
 if(delimiter<1) throw Error('Invalid local credentials format');
 return {uname:pair.slice(0,delimiter).trim(),password:pair.slice(delimiter+1).trim()};
}
async function get(agent,path,accept='json') {
 return agent.get(base+path).accept(accept).set('Referer',base+prefix+'/').ok(()=>true).timeout({response:20000,deadline:30000});
}
async function post(agent,path,data,accept='json') {
 return agent.post(base+path).type('form').send(data).accept(accept).set('Origin',base).set('Referer',base+path.split('?')[0]).redirects(0).ok(()=>true).timeout({response:20000,deadline:30000});
}
async function login(role) {
 const agent=request.agent();
 await get(agent,prefix+'/login','html');
 const response=await post(agent,prefix+'/login',credential(role));
 if(response.status!==302 && !(response.status===200 && (response.body.url||response.body.redirect))) {
   const errorName=response.body?.error?.name||response.body?.error?.type||'unknown';
   throw Error(role+' local login returned '+response.status+' '+errorName);
 }
 return {agent,role,status:response.status};
}
module.exports={base,prefix,credential,login,get,post};
if(require.main===module) (async()=> {
 for(const role of ['admin','student']) {
  const session=await login(role);
  console.log(JSON.stringify({role,login:session.status}));
  for(const route of ['/course','/homework','/contest']) {
   const response=await get(session.agent,prefix+route);
   const body=response.body||{};
   const docs=body.tdocs||[];
   console.log(JSON.stringify({role,path:route,status:response.status,keys:Object.keys(body),activities:docs.map(d=>({id:d.docId,title:d.title,rule:d.rule,sourceType:d.sourceType,dagKinds:(d.dag||[]).map(n=>n.kind||'lesson'),practice:d.practice||d.practiceEnabled})).slice(0,8)}));
  }
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
