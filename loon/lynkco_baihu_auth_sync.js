'use strict';

/*
 * 领克 H5/Cordova - 登录态同步至白虎面板
 *
 * 捕获入口：
 * 1. Cordova 签到状态请求头中的 token；
 * 2. /auth/login/refresh 返回的 data.centerTokenDto（H5 兼容入口）。
 *
 * Cordova 不向网页暴露 refreshToken，因此实际 App 请求只更新
 * LYNKCO_TOKEN，不会清空或覆盖 LYNKCO_REFRESH_TOKEN。
 */

const TITLE = '领克登录态同步';
const CACHE_KEY_PREFIX = 'lynkco-baihu-auth-sync:';
const DEFAULT_TASK_ID = 'd8plp22ikd0c73e3sup0';

if (typeof $request !== 'undefined') {
  main();
}

async function main() {
  try {
    const args = readArguments();
    if (!isEnabled(args.sync_enabled, true)) return;

    const debugEnabled = isEnabled(args.debug_enabled, false);
    const auth = extractAuthCredentials(
      $request,
      typeof $response === 'undefined' ? null : $response,
    );
    if (!auth) {
      if (debugEnabled) {
        console.log('[' + TITLE + '] 当前请求未发现 token：' + safeRequestName($request));
      }
      return;
    }

    const panelUrl = normalizePanelUrl(args.baihu_url);
    const apiToken = text(args.baihu_api_token);
    const tokenEnvName = text(args.token_env_name) || 'LYNKCO_TOKEN';
    const refreshEnvName = text(args.refresh_env_name) || 'LYNKCO_REFRESH_TOKEN';
    const baihuNode = text(args.baihu_node) || 'DIRECT';
    const taskId = text(args.task_id) || DEFAULT_TASK_ID;

    if (!apiToken) throw new Error('未填写白虎 OpenAPI Token');
    if (auth.refreshToken && tokenEnvName === refreshEnvName) {
      throw new Error('token 与 refreshToken 不能写入同一个环境变量');
    }

    const tokenEnv = await loadEnvironment(panelUrl, apiToken, tokenEnvName, baihuNode);
    const targets = [{ env: tokenEnv, value: auth.token }];
    if (auth.refreshToken) {
      const refreshEnv = await loadEnvironment(
        panelUrl,
        apiToken,
        refreshEnvName,
        baihuNode,
      );
      // refreshToken 先写入，降低第二步失败时丢失可刷新凭证的风险。
      targets.unshift({ env: refreshEnv, value: auth.refreshToken });
    }

    const fingerprint = authFingerprint(auth.token, auth.refreshToken || '');
    const cacheKey =
      CACHE_KEY_PREFIX + tokenEnvName + (auth.refreshToken ? ':' + refreshEnvName : '');
    let loginStateUpdated = false;

    const environmentsAlreadyCurrent = targets.every((target) =>
      environmentMatches(target.env, target.value),
    );
    if (environmentsAlreadyCurrent) {
      writeCache(cacheKey, fingerprint);
      if (debugEnabled) console.log('[' + TITLE + '] 白虎登录态已是最新，无需更新');
    } else if (targets.every((target) => !environmentValueReadable(target.env))) {
      if (readCache(cacheKey) === fingerprint) {
        if (debugEnabled) console.log('[' + TITLE + '] 机密变量不可读，已根据本机指纹跳过重复写入');
      } else {
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index];
          await updateEnvironment(panelUrl, apiToken, target.env, target.value, baihuNode);
        }
        writeCache(cacheKey, fingerprint);
        loginStateUpdated = true;
      }
    } else {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        await updateEnvironment(panelUrl, apiToken, target.env, target.value, baihuNode);
      }
      writeCache(cacheKey, fingerprint);
      loginStateUpdated = true;
    }

    let taskResult;
    try {
      taskResult = await executeTaskOncePerDay(
        panelUrl,
        apiToken,
        taskId,
        baihuNode,
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.log('[' + TITLE + '] 登录态已确认，但任务触发失败：' + safeMessage(message));
      $notification.post(TITLE, '白虎任务触发失败', safeMessage(message));
      return;
    }

    if (loginStateUpdated) {
      console.log('[' + TITLE + '] 已从' + auth.source + '更新白虎登录态');
      $notification.post(
        TITLE,
        '已更新白虎环境变量',
        (auth.refreshToken
          ? tokenEnvName + ' 与 ' + refreshEnvName + ' 已同步'
          : tokenEnvName + ' 已同步；本次请求未提供 refreshToken') +
          '；' + taskResult.message,
      );
    } else if (debugEnabled) {
      console.log('[' + TITLE + '] ' + taskResult.message);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.log('[' + TITLE + '] ' + safeMessage(message));
    $notification.post(TITLE, '同步失败', safeMessage(message));
  } finally {
    $done({});
  }
}

function extractAuthCredentials(request, response) {
  const json = parseJson(response && response.body);
  const dto = findCenterTokenDto(json);
  const responseToken = dto && firstText(dto, ['token', 'accessToken']);
  const responseRefreshToken = dto && firstText(dto, ['refreshToken']);
  if (responseToken && responseRefreshToken) {
    return { token: responseToken, refreshToken: responseRefreshToken, source: '认证接口响应' };
  }

  const requestToken = isCordovaTokenCaptureRequest(request && request.url)
    ? firstText(request && request.headers, ['token', 'accessToken', 'access-token'])
    : '';
  if (requestToken) {
    return { token: requestToken, refreshToken: '', source: 'Cordova 签到请求头' };
  }

  return null;
}

function isCordovaTokenCaptureRequest(url) {
  return /^https:\/\/app-api-gw-toc\.lynkco\.com\/up\/api\/v1\/user\/sign\/day\/info(?:\?.*)?$/i.test(
    String(url || ''),
  );
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

async function executeTaskOncePerDay(panelUrl, apiToken, taskId, baihuNode, now) {
  const dateKey = shanghaiDateKey(now);
  const cacheKey = CACHE_KEY_PREFIX + 'task-executed:' + taskId;
  if (readCache(cacheKey) === dateKey) {
    return { executed: false, message: '白虎任务今天已触发，跳过重复执行' };
  }

  await requestJson(
    'post',
    panelUrl + '/execute/task/' + encodeURIComponent(taskId),
    apiToken,
    undefined,
    baihuNode,
  );
  writeCache(cacheKey, dateKey);
  return { executed: true, message: '已触发白虎任务（今日首次）' };
}

function shanghaiDateKey(now) {
  const source = now instanceof Date ? now : new Date();
  // 中国标准时间固定为 UTC+8，按 UTC 字段读取可避开设备所在时区的影响。
  const shanghai = new Date(source.getTime() + 8 * 60 * 60 * 1000);
  return shanghai.toISOString().slice(0, 10);
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
    extractAuthCredentials,
    extractAuthPair: extractAuthCredentials,
    isCordovaTokenCaptureRequest,
    findCenterTokenDto,
    authFingerprint,
    shanghaiDateKey,
    executeTaskOncePerDay,
    environmentValueReadable,
    environmentMatches,
    safeRequestName,
  };
}
