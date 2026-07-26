'use strict';

/*
 * 燕云十六声 - 网易大神登录态同步至白虎面板
 *
 * 本脚本必须从同目录的 yanyun-baihu-token-sync.plugin 安装。
 * 它只读取 conf/get 请求头中的 gl-uid 和 gl-token，且只写回
 * 目标 glUid 的 glToken，不会修改活动字段或其他账号字段。
 */

const TITLE = '燕云登录态同步';

(async () => {
  try {
    const args = readArguments();
    if (!isEnabled(args.sync_enabled, true)) return;

    const panelUrl = normalizePanelUrl(args.baihu_url);
    const apiToken = text(args.baihu_api_token);
    const envName = text(args.env_name) || 'YY_BLINDBOX_ACCOUNTS';
    const glUid = headerValue($request.headers, 'gl-uid');
    const glToken = headerValue($request.headers, 'gl-token');

    if (!apiToken) throw new Error('未填写白虎 OpenAPI Token');
    if (!glUid || !glToken) throw new Error('网易大神请求中缺少 gl-uid 或 gl-token');

    const env = await loadEnvironment(panelUrl, apiToken, envName);
    const result = updateAccountToken(env, glUid, glToken);

    if (!result.changed) return;

    await putJson(panelUrl + '/env/' + encodeURIComponent(env.id), apiToken, result.payload);
    $notification.post(TITLE, '已更新白虎环境变量', '账号 ' + abbreviate(glUid) + ' 的 glToken 已刷新');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log('[' + TITLE + '] ' + message);
    $notification.post(TITLE, '同步失败', safeMessage(message));
  } finally {
    $done({});
  }
})();

function readArguments() {
  if (typeof $argument === 'object' && $argument) return $argument;

  const result = {};
  const raw = String(typeof $argument === 'undefined' ? '' : $argument);
  raw.split('&').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = decodeURIComponent(part.slice(0, index));
    const value = decodeURIComponent(part.slice(index + 1));
    result[key] = value;
  });
  return result;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function isEnabled(value, fallback) {
  const raw = text(value);
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function normalizePanelUrl(value) {
  const url = text(value).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) throw new Error('白虎地址必须以 https:// 开头');
  return /\/open2api\/v1$/i.test(url) ? url : url + '/open2api/v1';
}

function headerValue(headers, targetName) {
  const target = targetName.toLowerCase();
  const key = Object.keys(headers || {}).find((name) => String(name).toLowerCase() === target);
  return key ? text(headers[key]) : '';
}

async function loadEnvironment(panelUrl, apiToken, envName) {
  const response = await getJson(
    panelUrl + '/env?name=' + encodeURIComponent(envName) + '&page=1&page_size=100',
    apiToken,
  );
  const data = response.data;
  const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
  const env = list.find((item) => item && item.name === envName);

  if (!env) throw new Error('白虎中未找到普通环境变量 ' + envName);
  if (!env.id) throw new Error('白虎环境变量缺少 id，无法更新');
  if (env.type && env.type !== 'normal') throw new Error(envName + ' 必须是普通环境变量，不能是机密');
  if (typeof env.value !== 'string') throw new Error(envName + ' 未返回可读取的 JSON 值');
  return env;
}

function updateAccountToken(env, glUid, glToken) {
  let source;
  try {
    source = JSON.parse(env.value);
  } catch (_) {
    throw new Error(env.name + ' 不是有效 JSON');
  }

  const isArray = Array.isArray(source);
  const accounts = isArray ? source : [source];
  const account = accounts.find((item) => item && text(item.glUid).toLowerCase() === glUid.toLowerCase());
  if (!account) throw new Error('未在 ' + env.name + ' 中找到 glUid 为 ' + abbreviate(glUid) + ' 的账号');

  if (text(account.glToken) === glToken) return { changed: false };

  account.glToken = glToken;
  const payload = {
    id: env.id,
    name: env.name,
    value: JSON.stringify(isArray ? accounts : accounts[0]),
    remark: env.remark || '',
    type: env.type || 'normal',
    hidden: Boolean(env.hidden),
    enabled: env.enabled !== false,
    tags: env.tags || '',
  };
  return { changed: true, payload: payload };
}

function getJson(url, apiToken) {
  return requestJson('get', url, apiToken);
}

function putJson(url, apiToken, body) {
  return requestJson('put', url, apiToken, body);
}

function requestJson(method, url, apiToken, body) {
  return new Promise((resolve, reject) => {
    const options = {
      url: url,
      timeout: 25,
      headers: {
        Authorization: 'Bearer ' + apiToken,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) options.body = JSON.stringify(body);

    $httpClient[method](options, (error, response, data) => {
      if (error) return reject(new Error('白虎请求失败：' + error));
      if (!response || response.status < 200 || response.status >= 300) {
        return reject(new Error('白虎返回 HTTP ' + (response ? response.status : '未知状态')));
      }

      let json;
      try {
        json = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (_) {
        return reject(new Error('白虎返回了无法解析的数据'));
      }
      if (!json || json.code !== 200) return reject(new Error('白虎拒绝请求：' + safeMessage(json && json.msg)));
      resolve(json);
    });
  });
}

function abbreviate(value) {
  const raw = text(value);
  return raw.length <= 10 ? raw : raw.slice(0, 6) + '…' + raw.slice(-4);
}

function safeMessage(value) {
  const raw = text(value) || '未知错误';
  return raw.length > 120 ? raw.slice(0, 117) + '…' : raw;
}
