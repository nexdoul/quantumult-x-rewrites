/* 小黑盒 Quantumult X 本地采集 + 已实测 WebView 只读签名。
 * 默认任务只查询账号和任务列表，不发起签到。iOS nativeHkey 仍未实现。
 * 无第三方签名服务，无账号硬编码，不修改被抓取的 App 响应。
 */
'use strict';
var STORE_KEY = 'heybox.local.context.v1';
var SUCCESS_KEY = 'heybox.local.success.v1';
var API = 'https://api.xiaoheihe.cn';
var SIGN_PATH = '/task/sign_v3/sign';
var STATE_PATH = '/task/sign_v3/get_sign_state';
var CAPTURE_PATHS = ['/account/info/', SIGN_PATH, STATE_PATH];

function parseUrl(url) {
  var m = /^https:\/\/api\.xiaoheihe\.cn(\/[^?#]*)(?:\?([^#]*))?$/.exec(String(url || ''));
  if (!m) throw new Error('不支持的请求地址');
  var pairs = (m[2] || '').split('&').filter(Boolean).map(function (part) {
    var i = part.indexOf('=');
    function dec(s) { return decodeURIComponent(s.replace(/\+/g, ' ')); }
    return [dec(i < 0 ? part : part.slice(0, i)), dec(i < 0 ? '' : part.slice(i + 1))];
  });
  return { path: m[1], pairs: pairs };
}
function lastValue(pairs, key) {
  var value = '';
  pairs.forEach(function (p) { if (p[0] === key) value = p[1]; });
  return value;
}
function headerValue(headers, key) {
  var found = Object.keys(headers || {}).filter(function (name) {
    return name.toLowerCase() === key.toLowerCase();
  });
  return found.length ? String(headers[found[0]]) : '';
}
function cookieValue(cookie, key) {
  var parts = String(cookie || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim(), at = part.indexOf('=');
    if (at >= 0 && part.slice(0, at).trim() === key) return part.slice(at + 1).trim();
  }
  return '';
}
function basePairs(pairs) {
  return pairs.filter(function (p) { return ['_time', 'nonce', 'hkey', '_rnd'].indexOf(p[0]) < 0; });
}
function decodeJson(raw) {
  try { return JSON.parse(raw); } catch (_) { throw new Error('接口未返回有效 JSON'); }
}
function chinaDay(ms) { return Math.floor((ms / 1000 + 8 * 3600) / 86400); }
function isConfirmed(payload, now) {
  var r = payload && payload.result;
  // 抓包证据：state=ok 且 signed_date=北京时间的 Unix 日序号。
  return payload && payload.status === 'ok' && r && r.state === 'ok' &&
    r.signed_date !== undefined && r.signed_date !== null && r.signed_date !== '' &&
    Number(r.signed_date) === chinaDay(now);
}
function capture(env, request, response, now) {
  var parsed = parseUrl(request.url);
  if (CAPTURE_PATHS.indexOf(parsed.path) < 0 || String(request.method || 'GET').toUpperCase() !== 'GET') return false;
  var pairs = parsed.pairs, uid = lastValue(pairs, 'heybox_id');
  if (!/^\d+$/.test(uid) || lastValue(pairs, 'os_type') !== 'iOS') return false;
  var cookie = headerValue(request.headers, 'Cookie');
  if (/\r|\n/.test(cookie) || !cookieValue(cookie, 'pkey') || !cookieValue(cookie, 'x_xhh_tokenid')) return false;
  // 登录失效时不覆盖有效缓存；不输出任何原始响应、Cookie 或完整 URL。
  var payload = decodeJson(response.body);
  if (payload.status !== 'ok') return false;
  var old = {};
  try { old = JSON.parse(env.get(STORE_KEY) || '{}'); } catch (_) {}
  var same = old.heyboxId === uid && cookieValue(old.cookie, 'pkey') === cookieValue(cookie, 'pkey') &&
    cookieValue(old.cookie, 'x_xhh_tokenid') === cookieValue(cookie, 'x_xhh_tokenid');
  var headers = {};
  ['User-Agent', 'Accept', 'Accept-Language', 'Referer'].forEach(function (key) {
    var value = headerValue(request.headers, key);
    if (value && !/\r|\n/.test(value)) headers[key] = value;
  });
  var samples = same && Array.isArray(old.samples) ? old.samples.slice() : [];
  var t = lastValue(pairs, '_time'), nonce = lastValue(pairs, 'nonce'), hk = lastValue(pairs, 'hkey');
  if (/^\d+$/.test(t) && /^[A-Za-z0-9]{32}$/.test(nonce) && /^[a-f0-9]{8}$/.test(hk)) {
    if (!samples.some(function (x) { return x.path === parsed.path && x.time === t && x.nonce === nonce; })) {
      samples.push({path: parsed.path, time: t, nonce: nonce, hkey: hk, query: basePairs(pairs)});
    }
  }
  var data = {schema: 1, heyboxId: uid, cookie: cookie, headers: headers,
    query: basePairs(pairs), capturedAt: now, samples: samples.slice(-8)};
  if (!env.set(JSON.stringify(data), STORE_KEY)) throw new Error('Quantumult X 本地存储失败');
  if (!same) env.remove(SUCCESS_KEY);
  if (isConfirmed(payload, now)) {
    env.set(JSON.stringify({heyboxId: uid, pkey: cookieValue(cookie, 'pkey'), day: chinaDay(now)}), SUCCESS_KEY);
  }
  if (!same) env.notify('小黑盒', '本地凭证已采集', '未展示凭证；默认任务只做 WebView 只读鉴权验证，不发起签到。');
  env.log('已采集 ' + parsed.path + '；缓存签名样本 ' + data.samples.length + ' 条');
  return true;
}


// Web signer: official website index-CbCRlKJg.js, selector g (time + 1).
// Successful on account/info and task/list_v2; NOT proven on sign_v3.
var TASK_LIST_PATH = '/task/list_v2/';
var READ_ONLY_PATHS = ['/account/info/', TASK_LIST_PATH, STATE_PATH];
function md5Ascii(text) {
  var bytes = [], i, j;
  for (i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) throw new Error('MD5 helper accepts ASCII only');
    bytes.push(text.charCodeAt(i));
  }
  var bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (i = 0; i < 8; i++) bytes.push(Math.floor(bitLength / Math.pow(256, i)) & 255);
  var shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  var state = [0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  for (i = 0; i < bytes.length; i += 64) {
    var words = [];
    for (j = 0; j < 16; j++) {
      var k = i + j * 4;
      words[j] = bytes[k] | bytes[k+1]<<8 | bytes[k+2]<<16 | bytes[k+3]<<24;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3];
    for (j = 0; j < 64; j++) {
      var f, g, section = Math.floor(j/16);
      if (section === 0) { f = (b & c) | (~b & d); g = j; }
      else if (section === 1) { f = (d & b) | (~d & c); g = (5*j+1)%16; }
      else if (section === 2) { f = b ^ c ^ d; g = (3*j+5)%16; }
      else { f = c ^ (b | ~d); g = (7*j)%16; }
      var sum = (a + f + words[g] + (Math.floor(Math.abs(Math.sin(j+1))*4294967296) | 0)) | 0;
      var shift = shifts[section*4+j%4];
      var next = (b + ((sum << shift) | (sum >>> (32-shift)))) | 0;
      a=d; d=c; c=b; b=next;
    }
    state[0]=(state[0]+a)|0; state[1]=(state[1]+b)|0;
    state[2]=(state[2]+c)|0; state[3]=(state[3]+d)|0;
  }
  var hex = '';
  state.forEach(function (word) {
    for (var n=0;n<4;n++) hex += ('0'+((word >>> (n*8)) & 255).toString(16)).slice(-2);
  });
  return hex;
}
function webHkey(path, time, nonce) {
  var alphabet = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
  function map(text, chars) {
    var result=''; text=String(text);
    for(var i=0;i<text.length;i++) result+=chars[text.charCodeAt(i)%chars.length];
    return result;
  }
  function xtime(x) { return ((x << 1) ^ ((x & 128) ? 27 : 0)) & 255; }
  function pc(x) { return xtime(x)^x; }
  function sf(x) { return pc(xtime(x)); }
  function bh(x) { return sf(pc(xtime(x))); }
  function sg(x) { return bh(x)^sf(x)^pc(x); }
  var strings = [map(Number(time)+1,alphabet.slice(0,-2)),
    map('/'+path.split('/').filter(Boolean).join('/')+'/',alphabet),map(nonce,alphabet)];
  var interleaved='';
  for(var i=0;i<Math.max.apply(null,strings.map(function(s){return s.length;}));i++) {
    strings.forEach(function(s){if(i<s.length)interleaved+=s[i];});
  }
  var digest=md5Ascii(interleaved.slice(0,20));
  var e=digest.slice(-6).split('').map(function(c){return c.charCodeAt(0);});
  var mixed=[sg(e[0])^bh(e[1])^sf(e[2])^pc(e[3]),
    pc(e[0])^sg(e[1])^bh(e[2])^sf(e[3]),sf(e[0])^pc(e[1])^sg(e[2])^bh(e[3]),
    bh(e[0])^sf(e[1])^pc(e[2])^sg(e[3]),e[4],e[5]];
  var checksum=mixed.reduce(function(a,b){return a+b;},0)%100;
  return map(digest.slice(0,5),alphabet.slice(0,-4))+('0'+checksum).slice(-2);
}
function readWebContext(env) {
  var context;
  try { context=JSON.parse(env.get(STORE_KEY)||'null'); } catch (_) {}
  if(!context || context.schema!==1 || !Array.isArray(context.query) ||
    !/^\d+$/.test(context.heyboxId) || lastValue(context.query,'heybox_id')!==context.heyboxId ||
    lastValue(context.query,'os_type')!=='iOS' || /[\r\n]/.test(context.cookie) ||
    !cookieValue(context.cookie,'pkey') || !cookieValue(context.cookie,'x_xhh_tokenid')) {
    throw new Error('请先在 App 打开个人资料页，采集有效的本地登录上下文');
  }
  return context;
}
function buildWebRequest(context, path, now, random) {
  if(READ_ONLY_PATHS.indexOf(path)<0) throw new Error('Web 模式只允许只读白名单；禁止发起签到');
  var uid=String(context.heyboxId||''), pkey=cookieValue(context.cookie,'pkey');
  var token=cookieValue(context.cookie,'x_xhh_tokenid');
  if(!/^\d+$/.test(uid)||!pkey||!token||/[\r\n]/.test(context.cookie)) throw new Error('本地凭证不完整');
  var version=lastValue(context.query,'version');
  if(!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('缺少采集的 App 版本');
  var time=String(Math.floor(now/1000));
  var nonce=md5Ascii(time+String(now)+makeNonce(random)).toUpperCase();
  var query=[['app','heybox'],['os_type','web'],['x_app','heybox'],['x_client_type','web'],
    ['x_os_type','iOS'],['x_client_version',version],['version','999.0.4'],['heybox_id',uid],
    ['_time',time],['nonce',nonce],['hkey',webHkey(path,time,nonce)]];
  var cookie='pkey='+pkey+'; x_pkey='+pkey+'; x_heybox_id='+uid+'; x_xhh_tokenid='+token;
  var ua=headerValue(context.headers,'User-Agent');
  if(!ua || /[\r\n]/.test(ua)) throw new Error('缺少有效的 App User-Agent');
  return {url:API+path+'?'+query.map(function(p){return encodeURIComponent(p[0])+'='+encodeURIComponent(p[1]);}).join('&'),
    method:'GET',headers:{'User-Agent':ua,Accept:'application/json',
      Referer:'https://www.xiaoheihe.cn/',Origin:'https://www.xiaoheihe.cn',Cookie:cookie},
    opts:{redirection:false,'skip-cert-verify':false,'auto-cookie':false}};
}
async function runWebReadOnlyTask(env, options) {
  var context=readWebContext(env); options=options||{};
  async function get(path, allowRejected) {
    var response;
    try { response=await env.fetch(buildWebRequest(context,path,env.now(),env.random)); }
    catch (_) { throw new Error('只读请求失败；未记录带凭据的 URL 或底层异常'); }
    if(Number(response.statusCode)!==200) throw new Error('只读接口 HTTP 状态异常');
    var data=decodeJson(response.body);
    if(['login','relogin'].indexOf(data.status)>=0) throw new Error('当前 WebView 登录上下文未通过鉴权，请重新采集');
    if(data.status!=='ok'&&!allowRejected) throw new Error('只读接口拒绝当前签名或客户端参数');
    return data;
  }
  var account=await get('/account/info/');
  var r=account.result||{};
  if(String((r.account_detail||{}).userid||'')!==context.heyboxId &&
    String((r.profile||{}).heybox_id||'')!==context.heyboxId) throw new Error('返回账号与采集账号不一致');
  var tasks=await get(TASK_LIST_PATH);
  if(!tasks.result || String((tasks.result.user||{}).userid||'')!==context.heyboxId ||
    !Array.isArray(tasks.result.task_list)) throw new Error('任务列表未通过账号及结构校验');
  var result={authenticated:true,taskGroups:tasks.result.task_list.length,signStateAvailable:false};
  if(options.includeSignState) {
    var state=await get(STATE_PATH,true);
    result.signStateAvailable=state.status==='ok'&&!!state.result;
  }
  env.log('WebView 新签名鉴权通过；只读任务组 '+result.taskGroups+'；未发起签到');
  env.notify('小黑盒','Web 只读验证通过','账号及任务列表已验证。签到接口尚未打通，未发起签到。');
  return result;
}

function nativeHkey(path, time, nonce, context) {
  // 唯一待实现的签名入口。必须复算通过真实抓包样本后才允许发请求。
  // 不要使用旧 hkey，不要仅替换 _time，不要混入未经验证的 Web 签名。
  return null;
}
function validateSigner(context, signer) {
  if (!Array.isArray(context.samples) || context.samples.length < 2) throw new Error('需要至少两条不同的 iOS 抓包签名样本');
  if (!context.samples.some(function (s) { return s.path === SIGN_PATH; }) ||
      !context.samples.some(function (s) { return s.path === STATE_PATH; })) {
    throw new Error('需要同时采集 sign 和 get_sign_state 的签名样本');
  }
  context.samples.forEach(function (sample) {
    var sampleContext = Object.assign({}, context, {query: sample.query});
    var computed = signer(sample.path, sample.time, sample.nonce, sampleContext);
    if (!computed) throw new Error('当前尚未实现 iOS 本地动态签名；未发送任何签到请求');
    if (computed !== sample.hkey) throw new Error('本地签名与抓包不吻合；为避免无效请求已停止');
  });
}
function makeNonce(random) {
  var alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', result = '';
  for (var i = 0; i < 32; i++) result += alphabet[Math.floor(random() * alphabet.length)];
  return result;
}
function buildRequest(context, path, signer, now, random) {
  if (path !== SIGN_PATH && path !== STATE_PATH) throw new Error('任务仅允许访问签到及状态接口');
  var time = String(Math.floor(now / 1000)), nonce = makeNonce(random), hkey = signer(path, time, nonce, context);
  if (!/^[a-f0-9]{8}$/.test(String(hkey || ''))) throw new Error('iOS 签名格式不匹配');
  var query = basePairs(context.query).concat([['_time', time], ['nonce', nonce], ['hkey', hkey]]);
  var encoded = query.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
  var headers = Object.assign({}, context.headers, {Cookie: context.cookie, Accept: 'application/json'});
  // 防止重定向导致账号 Cookie 发往其他域名；不使用第三方服务，不禁用证书检查。
  return {url: API + path + '?' + encoded, method: 'GET', headers: headers,
    opts: {redirection: false, 'skip-cert-verify': false, 'auto-cookie': false}};
}
async function runTask(env, signer) {
  var context;
  try { context = JSON.parse(env.get(STORE_KEY) || 'null'); } catch (_) { throw new Error('本地凭证损坏，请重新采集'); }
  if (!context || context.schema !== 1 || !Array.isArray(context.query) || !context.headers ||
      !context.heyboxId || !cookieValue(context.cookie, 'pkey') || !cookieValue(context.cookie, 'x_xhh_tokenid') ||
      lastValue(context.query, 'heybox_id') !== context.heyboxId || lastValue(context.query, 'os_type') !== 'iOS') {
    throw new Error('请先启用 rewrite 并在小黑盒打开签到页面采集凭证');
  }
  signer = signer || nativeHkey;
  validateSigner(context, signer); // 必须先验证，失败时绝不触网。
  var day = chinaDay(env.now());
  var saved = {};
  try { saved = JSON.parse(env.get(SUCCESS_KEY) || '{}'); } catch (_) {}
  if (saved.heyboxId === context.heyboxId && saved.pkey === cookieValue(context.cookie, 'pkey') && saved.day === day) {
    env.notify('小黑盒', '今日已确认签到', '跳过重复请求。');
    return 'cached';
  }
  async function fetchJson(path) {
    var request = buildRequest(context, path, signer, env.now(), env.random);
    var response;
    try { response = await env.fetch(request); } catch (_) { throw new Error('请求失败，请检查网络；未记录底层异常以避免泄露 URL'); }
    if (Number(response.statusCode) !== 200) throw new Error('签到接口 HTTP 状态异常');
    var payload = decodeJson(response.body);
    if (['login', 'relogin'].indexOf(payload.status) >= 0) throw new Error('登录状态失效，请在 App 重新登录并采集');
    if (payload.status !== 'ok') throw new Error('服务端拒绝请求；需核查动态签名、客户端参数和登录状态');
    return payload;
  }
  function confirmed(payload) {
    env.set(JSON.stringify({heyboxId: context.heyboxId, pkey: cookieValue(context.cookie, 'pkey'), day: chinaDay(env.now())}), SUCCESS_KEY);
    var r = payload.result;
    env.notify('小黑盒', '今日签到已确认', 'H币 ' + String(r.sign_in_coin === undefined ? '未知' : r.sign_in_coin) +
      '；经验 ' + String(r.sign_in_exp === undefined ? '未知' : r.sign_in_exp) +
      '；连续 ' + String(r.sign_in_streak === undefined ? '未知' : r.sign_in_streak) + ' 天。');
    return 'confirmed';
  }
  var before = await fetchJson(STATE_PATH);
  if (isConfirmed(before, env.now())) return confirmed(before);
  // 只发起一次签到。HTTP 200、status=ok、空 state、waiting 均不是已签到证明。
  await fetchJson(SIGN_PATH);
  for (var i = 0; i < 3; i++) {
    await env.sleep(1500);
    var state = await fetchJson(STATE_PATH);
    if (isConfirmed(state, env.now())) return confirmed(state);
  }
  throw new Error('已发起签到，但轮询未确认今天成功；不会误报成功，也不会重复提交');
}
function qxEnvironment() {
  return {
    get: function (key) { return $prefs.valueForKey(key); },
    set: function (value, key) { return $prefs.setValueForKey(value, key); },
    remove: function (key) { return $prefs.removeValueForKey(key); },
    notify: function (title, subtitle, message) { $notify(title, subtitle, message); },
    log: function (message) { console.log('[小黑盒] ' + message); },
    fetch: function (request) { return $task.fetch(request); },
    now: function () { return Date.now(); }, random: Math.random,
    sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {parseUrl: parseUrl, capture: capture, runTask: runTask, nativeHkey: nativeHkey,
    validateSigner: validateSigner, buildRequest: buildRequest, chinaDay: chinaDay, isConfirmed: isConfirmed,
    STORE_KEY: STORE_KEY, SUCCESS_KEY: SUCCESS_KEY, webHkey: webHkey, md5Ascii: md5Ascii,
    buildWebRequest: buildWebRequest, runWebReadOnlyTask: runWebReadOnlyTask};
} else if (typeof $request !== 'undefined') {
  try {
    if (typeof $response !== 'undefined') capture(qxEnvironment(), $request, $response, Date.now());
  } catch (_) {
    console.log('[小黑盒] 采集未完成；请核查配置。原始请求和响应保持不变。');
  } finally { $done({}); }
} else {
  runWebReadOnlyTask(qxEnvironment()).catch(function (error) {
    $notify('小黑盒', '任务尚未完成', error.message);
  }).then(function () { $done(); });
}
