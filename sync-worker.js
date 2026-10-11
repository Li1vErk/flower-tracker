/*
 * 花园复活追踪 · 云同步 Worker
 *
 * 一份「整份快照 + 版本号」存在 KV 里，多设备通过它对齐数据：
 *   GET  /snapshot   → { rev, updatedAt, device, payload }   （云端为空时 { rev: 0, payload: null }）
 *   PUT  /snapshot   → body { baseRev, device, payload }
 *                       baseRev 与云端一致 → 保存，rev+1，返回 { rev, updatedAt }
 *                       不一致（别的设备先写入了）→ 409，返回云端当前完整快照，由用户决定谁覆盖谁
 *
 * 部署（全程在 Cloudflare 面板点鼠标，不用装任何东西）：
 *   1. Workers & Pages → Create → Worker → 随便起名（如 flower-sync）→ Deploy
 *   2. 点 Edit code，把本文件全部代码粘贴进去，替换原有内容 → Deploy
 *   3. Storage & Databases → KV → Create namespace，名字随意（如 flower-sync）
 *   4. 回到 Worker → Settings → Bindings → Add → KV namespace：
 *        Variable name 填 SYNC_KV，选刚建的 namespace
 *   5. Settings → Variables and Secrets → Add → Secret：
 *        Variable name 填 SYNC_TOKEN，Value 填一段只有自己知道的口令
 *   6. 回到 Worker 的域名（如 https://flower-sync.xxx.workers.dev/），
 *      浏览器直接打开应显示「flower-tracker sync worker is running」，部署完成。
 *
 * 客户端（花园复活追踪网页 → 备份与同步 → 云同步）里填：
 *   同步地址 = 第 6 步的 Worker 域名
 *   同步口令 = 第 5 步的 SYNC_TOKEN
 */

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Token",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 浏览器直接打开域名时用来确认部署成功
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response("flower-tracker sync worker is running", {
        headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders },
      });
    }

    if (url.pathname !== "/snapshot") {
      return json({ error: "not found" }, 404);
    }

    // 口令校验：Worker 绑定的 SYNC_TOKEN 与客户端填的「同步口令」必须一致
    const token = request.headers.get("X-Sync-Token") || "";
    if (!env.SYNC_TOKEN) {
      return json({ error: "worker not configured", hint: "SYNC_TOKEN 未设置" }, 500);
    }
    if (token !== env.SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    if (request.method === "GET") {
      const raw = await env.SYNC_KV.get("snapshot");
      if (!raw) return json({ rev: 0, payload: null });
      // 原样透传（里面就是 { rev, updatedAt, device, payload }）
      return new Response(raw, {
        headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
      });
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const payload = body && body.payload;
      if (!payload || typeof payload !== "object") {
        return json({ error: "missing payload" }, 400);
      }
      const payloadSize = JSON.stringify(payload).length;
      if (payloadSize > MAX_PAYLOAD_BYTES) {
        return json({ error: "payload too large", size: payloadSize }, 413);
      }

      const curRaw = await env.SYNC_KV.get("snapshot");
      const cur = curRaw ? JSON.parse(curRaw) : { rev: 0 };

      // 乐观锁：baseRev 对不上说明别的设备先写入了，把云端当前快照还给客户端去决策
      const baseRev = typeof body.baseRev === "number" ? body.baseRev : 0;
      if (baseRev !== cur.rev) {
        return json(
          { error: "conflict", rev: cur.rev, updatedAt: cur.updatedAt || null, device: cur.device || null, payload: cur.payload || null },
          409
        );
      }

      const next = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        device: String(body.device || "").slice(0, 40) || null,
        payload,
      };
      await env.SYNC_KV.put("snapshot", JSON.stringify(next));
      return json({ rev: next.rev, updatedAt: next.updatedAt });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
