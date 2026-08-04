'use strict';

/*
 * 燕云十六声 - 网易大神/微信小程序登录态同步至白虎面板
 *
 * 本脚本必须从同目录的 yanyun-baihu-token-sync.plugin 安装。它根据请求 URL 分流：
 *
 * 1. GET https://inf-miniapp.ds.163.com/v1/miniapp/base/user/getUserInfo（http-request）
 *    读取请求头中的 gl-uid 和 gl-token，只写回目标 glUid 的 glToken，
 *    不会修改活动字段或其他账号字段。
 * 2. GET https://s3.game.163.com/{projectId}/weixinminiprogram?code=...（http-response）
 *    从请求 URL 提取 wx.login code，写入白虎普通环境变量 YY_MINI_APP_CODE；
 *    从响应体 data.token 提取小程序 access_token，写入 YY_MINI_ACCESS_TOKEN。
 *    只写这两个单账号环境变量，不涉及账号数组，也不保存 uuid。
 */

const TITLE_GL = '燕云登录态同步';
const TITLE_MINI = '燕云小程序同步';
const MINI_URL_PATTERN = /^https:\/\/s3\.game\.163\.com\/[^/?]+\/weixinminiprogram(?:\?|$)/i;

(async () => {
  const requestUrl = text($request && $request.url);
  if (MINI_URL_PATTERN.test(requestUrl)) {
    await handleMiniSync();
  } else {
    await handleGlTokenSync();
  }
})();

async function handleMiniSync() {
  try {
    const args = readArguments();
    if (!isEnabled(args.mini_sync_enabled, true)) return;

    const panelUrl = normalizePanelUrl(args.baihu_url);
    const apiToken = text(args.baihu_api_token);
    const baihuNode = text(args.baihu_node) || 'DIRECT';
    const codeEnvName = text(args.mini_code_env_name) || 'YY_MINI_APP_CODE';
    const tokenEnvName = text(args.mini_token_env_name) || 'YY_MINI_ACCESS_TOKEN';

    if (!apiToken) throw new Error('未填写白虎 OpenAPI Token');

    const requestUrl = text($request && $request.url);
    const httpStatus = Number(typeof $response !== 'undefined' && $response ? $response.status : 0);
    if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
      throw new Error('weixinminiprogram 响应 HTTP ' + httpStatus + '，拒绝同步');
    }
    const code = extractUrlParam(requestUrl, 'code');
    const responseJson = parseJson(typeof $response === 'undefined' ? '' : $response && $response.body);
    const token = firstText(responseJson && responseJson.data, ['token']);

    // 只有「URL 有 code 且响应成功且返回 token」才允许同步任一变量；
    // 否则会留下“新 code + 旧 token”的不可用组合。
    if (!code) throw new Error('weixinminiprogram 请求中未发现 code');
    if (!isSuccessResponse(responseJson)) throw new Error('weixinminiprogram 响应异常，拒绝同步 code');
    if (!token) throw new Error('weixinminiprogram 响应中未发现 data.token，拒绝同步 code');

    // 先读取并校验两个环境变量，全部通过后再开始写入，避免配置错误导致部分更新。
    const codeEnv = await loadEnvironment(panelUrl, apiToken, codeEnvName, baihuNode);
    const tokenEnv = await loadEnvironment(panelUrl, apiToken, tokenEnvName, baihuNode);

    // 先写 token 再写 code：token 约 60 天才变化，若写入失败要等很久才有机会重写；
    // code 每次打开小程序都会重新同步，晚一轮即可补齐。
    const updated = [];
    const tokenChange = plainEnvChange(tokenEnv, token);
    if (tokenChange.changed) {
      await putJson(panelUrl + '/env/' + encodeURIComponent(tokenEnv.id), apiToken, tokenChange.payload, baihuNode);
      updated.push(tokenEnvName);
    }
    const codeChange = plainEnvChange(codeEnv, code);
    if (codeChange.changed) {
      await putJson(panelUrl + '/env/' + encodeURIComponent(codeEnv.id), apiToken, codeChange.payload, baihuNode);
      updated.push(codeEnvName);
    }

    if (updated.length > 0) {
      $notification.post(TITLE_MINI, '已更新白虎环境变量', updated.join('、') + ' 已刷新');
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log('[' + TITLE_MINI + '] ' + message);
    $notification.post(TITLE_MINI, '同步失败', safeMessage(message));
  } finally {
    $done({});
  }
}

async function handleGlTokenSync() {
  try {
    const args = readArguments();
    if (!isEnabled(args.sync_enabled, true)) return;

    const panelUrl = normalizePanelUrl(args.baihu_url);
    const apiToken = text(args.baihu_api_token);
    const envName = text(args.env_name) || 'YY_BLINDBOX_ACCOUNTS';
    const baihuNode = text(args.baihu_node) || 'DIRECT';
    const glUid = headerValue($request.headers, 'gl-uid');
    const glToken = headerValue($request.headers, 'gl-token');

    if (!apiToken) throw new Error('未填写白虎 OpenAPI Token');
    if (!glUid || !glToken) throw new Error('网易大神请求中缺少 gl-uid 或 gl-token');

    const env = await loadEnvironment(panelUrl, apiToken, envName, baihuNode);
    const result = updateAccountToken(env, glUid, glToken);

    if (!result.changed) return;

    await putJson(panelUrl + '/env/' + encodeURIComponent(env.id), apiToken, result.payload, baihuNode);
    $notification.post(TITLE_GL, '已更新白虎环境变量', '账号 ' + abbreviate(glUid) + ' 的 glToken 已刷新');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log('[' + TITLE_GL + '] ' + message);
    $notification.post(TITLE_GL, '同步失败', safeMessage(message));
  } finally {
    $done({});
  }
}

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

function extractUrlParam(url, name) {
  const match = String(url || '').match(new RegExp('[?&]' + name + '=([^&#]+)'));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function firstText(object, keys) {
  if (!object || typeof object !== 'object') return '';
  const names = Object.keys(object);
  for (let index = 0; index < keys.length; index += 1) {
    const target = keys[index].toLowerCase();
    const name = names.find((candidate) => String(candidate).toLowerCase() === target);
    if (name) {
      const value = text(object[name]);
      if (value) return value;
    }
  }
  return '';
}

function isSuccessResponse(responseJson) {
  if (!responseJson || typeof responseJson !== 'object') return false;
  if (responseJson.code !== undefined && Number(responseJson.code) !== 200) return false;
  if (responseJson.success === false || responseJson.status === false) return false;
  return true;
}

async function loadEnvironment(panelUrl, apiToken, envName, baihuNode) {
  const response = await getJson(
    panelUrl + '/env?name=' + encodeURIComponent(envName) + '&page=1&page_size=100',
    apiToken,
    baihuNode,
  );
  const data = response.data;
  const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
  const env = list.find((item) => item && item.name === envName);

  if (!env) throw new Error('白虎中未找到普通环境变量 ' + envName);
  if (!env.id) throw new Error('白虎环境变量缺少 id，无法更新');
  if (env.type && env.type !== 'normal') throw new Error(envName + ' 必须是普通环境变量，不能是机密');
  if (typeof env.value !== 'string') throw new Error(envName + ' 未返回可读取的值');
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
  return { changed: true, payload: buildEnvPayload(env, JSON.stringify(isArray ? accounts : accounts[0])) };
}

function plainEnvChange(env, nextValue) {
  if (text(env.value) === text(nextValue)) return { changed: false };
  return { changed: true, payload: buildEnvPayload(env, nextValue) };
}

function buildEnvPayload(env, value) {
  return {
    id: env.id,
    name: env.name,
    value: value,
    remark: env.remark || '',
    type: env.type || 'normal',
    hidden: Boolean(env.hidden),
    enabled: env.enabled !== false,
    tags: env.tags || '',
  };
}

function getJson(url, apiToken, baihuNode) {
  return requestJson('get', url, apiToken, undefined, baihuNode);
}

function putJson(url, apiToken, body, baihuNode) {
  return requestJson('put', url, apiToken, body, baihuNode);
}

function requestJson(method, url, apiToken, body, baihuNode) {
  return new Promise((resolve, reject) => {
    const options = {
      url: url,
      timeout: 25000,
      headers: {
        Authorization: 'Bearer ' + apiToken,
        'Content-Type': 'application/json',
      },
      node: baihuNode,
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
