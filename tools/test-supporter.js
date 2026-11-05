// Run: node tools/test-supporter.js. No network or real payments.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
function harness(config) {
  let user = { success: true, uuid: 'account-a' };
  let rows = [];
  let failure = null;
  let loginEvent;
  const urls = [];
  const context = {
    DejaVuSupporterConfig: Object.assign({storeId:'123',packageIds:[42],salesEnabled:true,allowPreview:true},config),
    location:{hostname:'extension-id'}, console, Promise, Date, AbortController,
    setTimeout, clearTimeout, setInterval(){}, window:{addEventListener(){}},
    overwolf:{profile:{
      getCurrentUser:cb=>cb(user),
      generateUserSessionToken:cb=>cb({success:true,token:'test-token'}),
      onLoginStateChanged:{addListener:cb=>loginEvent=cb}
    },utils:{openUrlInDefaultBrowser:url=>urls.push(url)}},
    fetch:async (url,options)=>{
      assert(url.startsWith('https://subscriptions-api.overwolf.com/subscriptions/123?'));
      assert.equal(options.headers.Authorization,'Bearer test-token');
      if(failure) return {ok:false,status:failure};
      return {ok:true,json:async()=>rows};
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root,'src/common/supporter.js'),'utf8'),context);
  return {api:context.DejaVuSupporter,urls,setUser:v=>user=v,setRows:v=>rows=v,setFailure:v=>failure=v,login:()=>loginEvent()};
}
(async()=>{
  const h=harness();
  await h.api.refresh(); assert.equal(h.api.hasAccess(),false);
  assert.equal(h.api.snapshot().canPurchase,true);
  assert.equal(h.api.previewAllowed(),false);
  await h.api.checkout(); assert.equal(h.urls.length,1);
  assert(h.urls[0].includes('/checkout/123/42?extensionId=extension-id&userId=account-a'));
  assert.equal(h.api.hasAccess(),false,'checkout alone must not unlock');
  h.setRows([{userId:'other-account',packageId:42,state:'ACTIVE'}]);
  await h.api.refresh(); assert.equal(h.api.hasAccess(),false);
  h.setRows([{userId:'account-a',packageId:999,state:'ACTIVE'}]);
  await h.api.refresh(); assert.equal(h.api.hasAccess(),false);
  h.setRows([{userId:'account-a',packageId:42,state:'ACTIVE'}]);
  await h.api.refresh(); assert.equal(h.api.hasAccess(),true);
  await h.api.checkout(); assert.equal(h.urls.length,1,'owners cannot repurchase');
  h.setFailure(503); await h.api.refresh(); assert.equal(h.api.hasAccess(),true,'same-session outage grace');
  h.setFailure(401); await h.api.refresh(); assert.equal(h.api.hasAccess(),false,'denial revokes access');
  h.setFailure(null);h.setRows([{userId:'account-a',packageId:42,state:'ACTIVE'}]);
  await h.api.refresh(); h.setUser({success:true,uuid:'account-b'});
  await h.api.refresh(); assert.equal(h.api.hasAccess(),false,'account switch cannot inherit ownership');
  h.setUser({success:false}); await h.api.refresh();assert.equal(h.api.snapshot().status,'login');
  const setup=harness({storeId:'',packageIds:[],salesEnabled:false});
  await setup.api.refresh();assert.equal(setup.api.snapshot().status,'setup');
  assert.equal(await setup.api.checkout(),false);assert.equal(setup.urls.length,0);
  assert.equal(setup.api.previewAllowed(),true);
  console.log('PASS: setup gating, checkout URL, no redirect unlock, account/package matching, duplicate purchase prevention, outage grace, denial, account switch, logout.');
})().catch(error=>{console.error(error);process.exitCode=1;});