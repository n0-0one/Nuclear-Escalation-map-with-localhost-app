import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FILES,verifyArtifact,publish,DATA_BRANCH,FEED_BRANCH} from './publication.mjs';

const revision='a'.repeat(40),sourceSha='b'.repeat(40);
function artifact(change=()=>{}) {
  const data={formatVersion:1,datamineCommit:revision,files:Object.fromEntries(FILES.map(name=>[name,{}]))};
  data.files['datamine-lock.json']={accepted_commit:revision};change(data);
  const payload=Buffer.from(JSON.stringify(data)),sha256=createHash('sha256').update(payload).digest('hex');
  return {payload,manifest:{formatVersion:1,datamineCommit:revision,sha256,bytes:payload.length,pack:`packs/${sha256}.json`}};
}
test('reject corrupt packs and unapproved executable or traversal paths before publication',async()=>{
  for(const value of [artifact(d=>{d.files['main.js']='code';}),artifact(d=>{delete d.files['map_data.json'];d.files['../map_data.json']={};}),artifact(d=>{d.datamineCommit='c'.repeat(40);})]) {
    await assert.rejects(publish(()=>assert.fail('No API calls allowed'),value,sourceSha));
  }
  const corrupt=artifact();corrupt.payload[0]=0;
  assert.throws(()=>verifyArtifact(corrupt.manifest,corrupt.payload),/integrity/);
});
test('an obsolete workflow cannot publish over newer main code',async()=>{
  const calls=[];
  const result=await publish(async(path,method='GET')=>{calls.push({path,method});return {object:{sha:'c'.repeat(40)}};},artifact(),sourceSha);
  assert.equal(result.superseded,true);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});
test('first publication changes only allowlisted source paths and creates the feed separately',async()=>{
  const calls=[];
  const api=async(path,method='GET',body)=>{
    calls.push({path,method,body});
    if(method==='GET') {
      if(path==='/git/ref/heads/main') return {object:{sha:sourceSha}};
      if(path===`/git/commits/${sourceSha}`) return {sha:sourceSha,tree:{sha:'main-tree'}};
      return null;
    }
    if(path==='/git/trees') return {sha:body.base_tree?'source-tree':'feed-tree'};
    return {sha:`object-${calls.length}`};
  };
  const result=await publish(api,artifact(),sourceSha,1234);
  assert.equal(result.feedChanged,true);
  const trees=calls.filter(c=>c.path==='/git/trees');
  assert.equal(trees[0].body.base_tree,'main-tree');
  assert.deepEqual(trees[0].body.tree.map(e=>e.path),FILES.map(name=>`apps/web/public/${name}`));
  assert.equal(trees[1].body.tree.length,2);
  assert(calls.some(c=>c.body?.ref===`refs/heads/${DATA_BRANCH}`));
  assert(calls.some(c=>c.body?.ref===`refs/heads/${FEED_BRANCH}`));
  assert(!calls.some(c=>c.path==='/git/refs/heads/main'));
});
test('unchanged data preserves the feed publication time and uses no forced ref update',async()=>{
  const value=artifact(),calls=[];
  const api=async(path,method='GET',body)=>{
    calls.push({path,method,body});
    if(path.startsWith('/contents/manifest'))return {content:Buffer.from(JSON.stringify({...value.manifest,publishedAt:123})).toString('base64')};
    if(method==='GET'&&path.startsWith('/git/ref/heads/'))return {object:{sha:sourceSha}};
    if(method==='GET'&&path.startsWith('/git/commits/'))return {sha:sourceSha,tree:{sha:'same-tree'}};
    if(path==='/git/trees')return {sha:'same-tree'};
    return {sha:'blob'};
  };
  const result=await publish(api,value,sourceSha,456);
  assert.equal(result.feedChanged,false);assert.equal(result.sourceChanged,false);
  assert(!calls.some(c=>c.path==='/git/commits'&&c.method==='POST'));
  assert(!calls.some(c=>c.body?.force===true));
});
