import {readFileSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const REPOSITORY = 'n0-0one/Nuclear-Escalation-map-with-localhost-app';
export const DATA_BRANCH = 'automation/datamine-update';
export const FEED_BRANCH = 'codex/windows-data-v1';
export const FILES = ['map_data.json','map_data_mirror.json','map_data_city.json','map_data_city_mirror.json','mission_logic.json','mission_logic_mirror.json','mission_logic_city.json','mission_logic_city_mirror.json','presets.json','unit_specs.json','unit_display_names.json','datamine-lock.json'];

export function verifyArtifact(manifest, payload) {
  if(manifest.formatVersion!==1 || !/^[a-f0-9]{40}$/.test(manifest.datamineCommit) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || manifest.pack!==`packs/${manifest.sha256}.json`) throw new Error('Invalid data manifest');
  if(!Number.isSafeInteger(manifest.bytes) || manifest.bytes<1 || manifest.bytes>32*1024*1024 || payload.length!==manifest.bytes || createHash('sha256').update(payload).digest('hex')!==manifest.sha256) throw new Error('Data artifact failed integrity validation');
  const data=JSON.parse(payload);
  if(data.formatVersion!==1 || data.datamineCommit!==manifest.datamineCommit || data.files?.['datamine-lock.json']?.accepted_commit!==manifest.datamineCommit || Object.keys(data.files||{}).length!==FILES.length || !FILES.every(name=>Object.hasOwn(data.files,name))) throw new Error('Unexpected data files or provenance');
  return {manifest:{...manifest},payload,files:data.files};
}

export function readArtifact(root) {
  const manifestPath=`${root}/manifest.json`;
  if(statSync(manifestPath).size>16384) throw new Error('Manifest exceeds its size limit');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(!/^packs\/[a-f0-9]{64}\.json$/.test(manifest.pack)) throw new Error('Unexpected data pack path');
  const packPath=`${root}/${manifest.pack}`;
  if(statSync(packPath).size>32*1024*1024) throw new Error('Data pack exceeds its size limit');
  return verifyArtifact(manifest,readFileSync(packPath));
}

async function commitTree(api, branch, head, baseTree, entries, message, initialParent) {
  const tree=await api('/git/trees','POST',{...(baseTree?{base_tree:baseTree}:{}),tree:entries});
  if(head?.tree.sha===tree.sha) return false;
  const commit=await api('/git/commits','POST',{message,tree:tree.sha,parents:head?[head.sha]:initialParent?[initialParent]:[]});
  if(head) await api(`/git/refs/heads/${branch}`,'PATCH',{sha:commit.sha,force:false});
  else await api('/git/refs','POST',{ref:`refs/heads/${branch}`,sha:commit.sha});
  return true;
}

export async function publish(api, artifact, sourceSha, now=Date.now()) {
  // Recheck the artifact before any write, including when called independently of CI.
  const {manifest,payload,files}=verifyArtifact(artifact.manifest,artifact.payload);
  if(!/^[a-f0-9]{40}$/.test(sourceSha) || !Number.isSafeInteger(now) || now<1) throw new Error('Invalid publication context');
  const main=await api('/git/ref/heads/main');
  if(main.object.sha!==sourceSha) return {superseded:true,sourceChanged:false,feedChanged:false};
  const source=await api(`/git/commits/${sourceSha}`);
  const branch=await api(`/git/ref/heads/${DATA_BRANCH}`);
  const branchHead=branch?await api(`/git/commits/${branch.object.sha}`):null;
  const entries=[];
  for(const name of FILES) {
    const blob=await api('/git/blobs','POST',{content:JSON.stringify(files[name],null,2)+'\n',encoding:'utf-8'});
    entries.push({path:`apps/web/public/${name}`,mode:'100644',type:'blob',sha:blob.sha});
  }
  // Start from main's reviewed code; only the twelve generated JSON paths are replaced.
  // Keep the existing automation history and use an ordinary fast-forward update.
  const sourceChanged=await commitTree(api,DATA_BRANCH,branchHead,source.tree.sha,entries,`Update validated datamine ${manifest.datamineCommit.slice(0,12)}`,sourceSha);
  const head=await api(`/git/ref/heads/${FEED_BRANCH}`);
  const previous=head?await api(`/contents/manifest.json?ref=${encodeURIComponent(FEED_BRANCH)}`):null;
  if(previous && JSON.parse(Buffer.from(previous.content,'base64').toString()).sha256===manifest.sha256) return {sourceChanged,feedChanged:false,revision:manifest.datamineCommit};
  manifest.publishedAt=now;
  const dataBlob=await api('/git/blobs','POST',{content:payload.toString('base64'),encoding:'base64'});
  const manifestBlob=await api('/git/blobs','POST',{content:JSON.stringify(manifest,null,2)+'\n',encoding:'utf-8'});
  const current=head?await api(`/git/commits/${head.object.sha}`):null;
  const feedChanged=await commitTree(api,FEED_BRANCH,current,current?.tree.sha,[{path:manifest.pack,mode:'100644',type:'blob',sha:dataBlob.sha},{path:'manifest.json',mode:'100644',type:'blob',sha:manifestBlob.sha}],`Publish validated Windows datamine ${manifest.datamineCommit.slice(0,12)}`);
  return {sourceChanged,feedChanged,revision:manifest.datamineCommit};
}
