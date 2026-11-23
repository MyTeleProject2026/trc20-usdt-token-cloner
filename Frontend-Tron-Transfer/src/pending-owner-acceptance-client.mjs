const API = String(import.meta.env?.VITE_RESOURCE_API_URL || 'https://tron-transfer-resource-api.onrender.com').replace(/\/+$/,'')
const ROOT = API + '/api/pending-owner'
function csrfCookie() {
  const match=String(typeof document==='undefined'?'':document.cookie).match(/(?:^|;\s*)tron_pending_owner_csrf=([^;]+)/)
  try{return match?decodeURIComponent(match[1]):''}catch{return ''}
}
export function createPendingOwnerAcceptanceClient({fetchImpl=fetch}={}) {
  let csrfToken=''
  async function request(path,{method='GET',body,csrf=false}={}) {
    const headers={accept:'application/json'}
    if(body!==undefined)headers['content-type']='application/json'
    if(csrf){const token=csrfToken||csrfCookie();if(!token)throw new Error('PENDING_OWNER_CSRF_MISSING');headers['x-csrf-token']=token}
    const response=await fetchImpl(ROOT+path,{method,headers,credentials:'include',cache:'no-store',...(body!==undefined?{body:JSON.stringify(body)}:{})})
    const payload=await response.json().catch(()=>({}))
    if(!response.ok)throw Object.assign(new Error(payload.error||'PENDING_OWNER_REQUEST_FAILED'),{status:response.status,code:payload.error})
    if(payload.csrfToken)csrfToken=payload.csrfToken
    return payload
  }
  return Object.freeze({
    state:()=>request('/state'),
    challenge:address=>request('/challenge',{method:'POST',body:{address}}),
    verify:(address,nonce,signature)=>request('/verify',{method:'POST',body:{address,nonce,signature}}),
    session:()=>request('/session'),
    prepare:input=>request('/prepare',{method:'POST',body:input,csrf:true}),
    confirm:input=>request('/confirm',{method:'POST',body:input,csrf:true}),
    status:id=>request('/operations/'+encodeURIComponent(id)),
    logout:()=>request('/logout',{method:'POST',body:{},csrf:true}).finally(()=>{csrfToken=''}),
  })
}
