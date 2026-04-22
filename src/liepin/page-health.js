import { isCdpRuntimeTimeoutError } from "../chrome.js";

export const PAGE_RUNTIME_UNRESPONSIVE_CODE = "PAGE_RUNTIME_UNRESPONSIVE";

export async function assertPageRuntimeResponsive(client, {
  pageName = "页面",
  timeoutMs = 5000
} = {}) {
  try {
    return await client.evaluateWithTimeout(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState
    }), [], {
      timeoutMs
    });
  } catch (error) {
    const runtimeTimeout = isCdpRuntimeTimeoutError(error);
    const wrapped = new Error(runtimeTimeout
      ? `${pageName} Runtime 不响应，已停止本次后台操作以避免长时间卡住；请检查该 Chrome tab 是否已卡死。`
      : `${pageName} Runtime 健康检查失败：${error?.message || String(error)}`);
    wrapped.code = PAGE_RUNTIME_UNRESPONSIVE_CODE;
    wrapped.cause = error;
    wrapped.pageName = pageName;
    wrapped.runtimeTimeout = runtimeTimeout;
    throw wrapped;
  }
}

export function isPageRuntimeUnresponsiveError(error) {
  return error?.code === PAGE_RUNTIME_UNRESPONSIVE_CODE;
}
