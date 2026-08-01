'use strict';

/*
 * 领克 H5 - 登录态同步至白虎面板
 *
 * 捕获入口：
 * 1. H5 启动 URL 中同时出现的 token / refreshToken；
 * 2. /auth/login/refresh 返回的 data.centerTokenDto。
 *
 * 两个值分别写入白虎已有的 LYNKCO_TOKEN 与
 * LYNKCO_REFRESH_TOKEN。脚本不会输出完整凭证，也不会创建变量。
 */

const TITLE = '领克登录态同步';
const CACHE_KEY_PREFIX = 'lynkco-baihu-auth-sync:';

if (typeof $request !== 'undefined') {
  main();
}

async function main() {
  try {
    const args = readArguments();
    if (!isEnabled(args.sync_enabled, true)) return;

    const debugEnabled = isEnabled(args.debug_enabled, false);
    const auth = extractAuthPair($request, typeof $response === 'undefined' ? null : $response);
    if (!auth) {
      if (debugEnabled) {
        console.log('[' + TITLE + '] 当前请求未发现完整的 token + refreshToken：' + safeRequestName($request));
      }
      return;
    }

    const panelUrl = normalizePanelUrl(args.baihu_url);
    const apiToken = text(args.baihu_api_token);
    const tokenEnvName = text(args.token_env_name) || 'LYNKCO_TOKEN';
    const refreshEnvName = text(args.refresh_env_name) || 'LYNKCO_REFRESH_TOKEN';
    const baihuNode = text(args.baihu_node) || 'DIRECT';

    if (!apiToken) throw new Error('未填写白虎 OpenAPI Token');
    if (tokenEnvName === refreshEnvName) throw new Error('token 与 refreshToken 不能写入同一个环境变量');

    const environments = await Promise.all([
      loadEnvironment(panelUrl, apiToken, tokenEnvName, baihuNode),
      loadEnvironment(panelUrl, apiToken, refreshEnvName, baihuNode),
    ]);
    const tokenEnv = environments[0];
    const refreshEnv = environments[1];
    const fingerprint = authFingerprint(auth.token, auth.refreshToken);
    const cacheKey = CACHE_KEY_PREFIX + tokenEnvName + ':' + refreshEnvName;

    if (environmentMatches(tokenEnv, auth.token) && environmentMatches(refreshEnv, auth.refreshToken)) {
      writeCache(cacheKey, fingerprint);
      if (debugEnabled) console.log('[' + TITLE + '] 白虎登录态已是最新，无需更新');
      return;
    }

    if (!environmentValueReadable(tokenEnv) && !environmentValueReadable(refreshEnv)) {
      if (readCache(cacheKey) === fingerprint) {
        if (debugEnabled) console.log('[' + TITLE + '] 机密变量不可读，已根据本机指纹跳过重复写入');
        return;
      }
    }

    // refreshToken 先写入，降低第二步失败时丢失可刷新凭证的风险。
    await updateEnvironment(panelUrl, apiToken, refreshEnv, auth.refreshToken, baihuNode);
    await updateEnvironment(panelUrl, apiToken, tokenEnv, auth.token, baihuNode);
    writeCache(cacheKey, fingerprint);

    console.log('[' + TITLE + '] 已从' + auth.source + '更新白虎登录态');
    $notification.post(TITLE, '已更新白虎环境变量', tokenEnvName + ' 与 ' + refreshEnvName + ' 已同步');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log('[' + TITLE + '] ' + safeMessage(message));
    $notification.post(TITLE, '同步失败', safeMessage(message));
  } finally {
    $done({});
  }
}

function extractAuthPair(request, response) {
  const query = queryParameters(request && request.url);
  const queryToken = firstText(query, ['token', 'accessToken']);
  const queryRefreshToken = firstText(query, ['refreshToken']);
  if (queryToken && queryRefreshToken) {
    return { token: queryToken, refreshToken: queryRefreshToken, source: 'H5 启动参数' };
  }

  const json = parseJson(response && response.body);
  const dto = findCenterTokenDto(json);
  const responseToken = dto && firstText(dto, ['token', 'accessToken']);
  const responseRefreshToken = dto && firstText(dto, ['refreshToken']);
  if (responseToken && responseRefreshToken) {
    return { token: responseToken, refreshToken: responseRefreshToken, source: '认证接口响应' };
  }

  return null;
}

function queryParameters(url) {
  const result = {};
  const raw = String(url || '');
  const queryStart = raw.indexOf('?');
  if (queryStart < 0) return result;

  const hashStart = raw.indexOf('#', queryStart);
  const query = raw.slice(queryStart + 1, hashStart < 0 ? raw.length : hashStart);
  query.split('&').forEach((part) => {
    if (!part) return;
    const separator = part.indexOf('=');
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    const key = decode(rawKey);
    if (!key) return;
    result[key] = decode(rawValue);
  });
  return result;
}

function decode(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
  } catch (_) {
    return String(value || '');
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

function findCenterTokenDto(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.data && json.data.centerTokenDto) return json.data.centerTokenDto;
  if (json.result && json.result.centerTokenDto) return json.result.centerTokenDto;
  if (json.centerTokenDto) return json.centerTokenDto;
  return null;
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

function readArguments() {
  if (typeof $argument === 'object' && $argument) return $argument;

  const result = {};
  const raw = String(typeof $argument === 'undefined' ? '' : $argument);
  raw.split('&').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = decode(part.slice(0, index));
    result[key] = decode(part.slice(index + 1));
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

async function loadEnvironment(panelUrl, apiToken, envName, baihuNode) {
  const response = await requestJson(
    'get',
    panelUrl + '/env?name=' + encodeURIComponent(envName) + '&page=1&page_size=100',
    apiToken,
    undefined,
    baihuNode,
  );
  const data = response.data;
  const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
  const env = list.find((item) => item && item.name === envName);

  if (!env) throw new Error('白虎中未找到环境变量 ' + envName + '，请先在变量机密中创建');
  if (!env.id) throw new Error('白虎环境变量 ' + envName + ' 缺少 id，无法更新');
  return env;
}

function updateEnvironment(panelUrl, apiToken, env, value, baihuNode) {
  const payload = {
    id: env.id,
    name: env.name,
    value: value,
    remark: env.remark || '',
    type: env.type || 'secret',
    hidden: env.hidden !== false,
    enabled: env.enabled !== false,
    tags: env.tags || '',
  };
  return requestJson(
    'put',
    panelUrl + '/env/' + encodeURIComponent(env.id),
    apiToken,
    payload,
    baihuNode,
  );
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
      if (!json || Number(json.code) !== 200) {
        return reject(new Error('白虎拒绝请求：' + safeMessage(json && (json.msg || json.message))));
      }
      resolve(json);
    });
  });
}

function environmentValueReadable(env) {
  const value = text(env && env.value);
  if (!value) return false;
  return !/^\*+$/.test(value) && !/^<[^>]*secret[^>]*>$/i.test(value) && value !== '******';
}

function environmentMatches(env, expected) {
  return environmentValueReadable(env) && text(env.value) === expected;
}

function authFingerprint(token, refreshToken) {
  const raw = token + '\u0000' + refreshToken;
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ('00000000' + (hash >>> 0).toString(16)).slice(-8) + ':' + raw.length;
}

function readCache(key) {
  if (typeof $persistentStore === 'undefined') return '';
  return text($persistentStore.read(key));
}

function writeCache(key, value) {
  if (typeof $persistentStore === 'undefined') return;
  $persistentStore.write(value, key);
}

function safeRequestName(request) {
  const raw = String((request && request.url) || '未知请求');
  return raw.replace(/([?&](?:token|accessToken|refreshToken)=)[^&#]*/gi, '$1<redacted>');
}

function safeMessage(value) {
  const raw = text(value) || '未知错误';
  const redacted = raw.replace(/((?:token|refreshToken)[^:=]{0,12}[:=]\s*)[^\s,，}]+/gi, '$1<redacted>');
  return redacted.length > 160 ? redacted.slice(0, 157) + '…' : redacted;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractAuthPair,
    queryParameters,
    findCenterTokenDto,
    authFingerprint,
    environmentValueReadable,
    environmentMatches,
    safeRequestName,
  };
}
