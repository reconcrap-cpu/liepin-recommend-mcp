import { DEFAULT_DEBUG_PORT, LIEPIN_URLS } from "../constants.js";
import { connectToChrome, discoverLiepinPages } from "../chrome.js";
import { normalizeText } from "../utils.js";

export async function runChromeDiscovery({ port = DEFAULT_DEBUG_PORT } = {}) {
  const connection = await connectToChrome({ port });
  if (!connection.ok) return connection;
  const pages = await discoverLiepinPages({ port: connection.port });
  const loginOk = Boolean(pages.recommend || pages.search || pages.chat || pages.resumeDetail);
  const riskBlocked = Boolean(pages.riskPage && !loginOk);
  return {
    ok: true,
    port: connection.port,
    browserURL: connection.browserURL,
    pages: {
      recommend: simplifyPage(pages.recommend),
      search: simplifyPage(pages.search),
      chat: simplifyPage(pages.chat),
      resumeDetail: simplifyPage(pages.resumeDetail),
      riskPage: simplifyPage(pages.riskPage),
      total: pages.all.length
    },
    riskPageDetected: Boolean(pages.riskPage),
    riskBlocked,
    loginOk,
    guidance: loginOk
      ? null
      : {
          debugPort: connection.port,
          recommendUrl: LIEPIN_URLS.recommend,
          searchUrl: LIEPIN_URLS.search,
          chatUrl: LIEPIN_URLS.chat
        }
  };
}

function simplifyPage(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    url: normalizeText(entry.url),
    title: normalizeText(entry.title),
    kind: entry.kind
  };
}
