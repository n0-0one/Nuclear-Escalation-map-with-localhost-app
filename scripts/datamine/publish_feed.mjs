// This write step runs only after web, Rust and native Windows checks succeed.
import {REPOSITORY,readArtifact,publish} from './publication.mjs';
const artifact=readArtifact('.local/windows-feed');
if(process.argv[2]==='--verify-only') {
  console.log(`Verified publication artifact ${artifact.manifest.datamineCommit} (${artifact.manifest.bytes} bytes).`);
} else {
  if(process.env.GITHUB_REPOSITORY!==REPOSITORY || process.env.GITHUB_REF!=='refs/heads/main' || process.env.GITHUB_EVENT_NAME==='pull_request') throw new Error('Unexpected publication context');
  const token=process.env.GITHUB_TOKEN;if(!token)throw new Error('Missing workflow token');
  async function api(path,method='GET',body) {
    const response=await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===404&&method==='GET')return null;
    if(!response.ok)throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status===204?null:response.json();
  }
  console.log(JSON.stringify(await publish(api,artifact,process.env.GITHUB_SHA)));
}
