const brochures = {
  "AI電話対応ツール": "ai-phone.pdf",
  "AI営業ロープレツール": "sales-roleplay.pdf",
  "両方": ["ai-phone.pdf", "sales-roleplay.pdf"],
};

function reply(status, error) {
  return Response.json(error ? { error } : { ok: true }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function send(env, key, email) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ from: env.RESEND_FROM, ...email }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
}

async function handle(request, env) {
  if (new URL(request.url).pathname !== "/api/request") return reply(404, "ページが見つかりません。");
  if (request.method !== "POST") return reply(405, "送信方法が正しくありません。");
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return reply(403, "送信元を確認できません。");
  }

  const invalid = "入力内容をご確認ください。";
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply(400, invalid);
  const { success } = await env.REQUEST_LIMIT.limit({
    key: request.headers.get("CF-Connecting-IP") || "unknown",
  });
  if (!success) return reply(429, "時間をおいて再度お試しください。");

  // Bound the body before decoding it.
  const reader = request.body?.getReader();
  if (!reader) return reply(400, invalid);
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      return reply(413, invalid);
    }
    body += decoder.decode(value, { stream: true });
  }

  let data;
  try {
    data = JSON.parse(body + decoder.decode());
  } catch {
    return reply(400, invalid);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return reply(400, invalid);
  if (data.website) return reply(200);

  const fields = { company: 100, name: 50, email: 254, phone: 30, message: 1000 };
  for (const [field, max] of Object.entries(fields)) {
    if (typeof data[field] !== "string" || data[field].length > max) return reply(400, invalid);
    data[field] = data[field].trim();
  }
  const { company, name, email, phone, message, service, consent, requestId } = data;
  if (!company || !name || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email) ||
      typeof service !== "string" || !Object.hasOwn(brochures, service) || consent !== "yes" ||
      typeof requestId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId)) {
    return reply(400, invalid);
  }

  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !env.NOTIFY_TO) {
    throw new Error("Missing email configuration");
  }
  const attachments = await Promise.all([brochures[service]].flat().map(async (filename) => {
    const object = await env.BROCHURES.get(filename);
    if (!object || !object.size || object.size > 10 * 1024 * 1024) {
      throw new Error(`Missing or invalid brochure: ${filename}`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return { filename, content: bytes.toBase64(), content_type: "application/pdf" };
  }));

  await send(env, `brochure/${requestId}`, {
    to: [email],
    subject: "ご請求いただいたサービス資料｜ロジカソリューションズ",
    text: `${name} 様\n\n資料をご請求いただきありがとうございます。\nご希望の資料（${service}）を添付いたします。\n\nロジカソリューションズ`,
    attachments,
  });
  await send(env, `brochure-notice/${requestId}`, {
    to: [env.NOTIFY_TO],
    reply_to: email,
    subject: "サービス資料請求を受け付けました",
    text: [
      `会社名: ${company}`,
      `お名前: ${name}`,
      `メールアドレス: ${email}`,
      `電話番号: ${phone || "未入力"}`,
      `希望資料: ${service}`,
      `ご質問・ご相談:\n${message || "未入力"}`,
    ].join("\n"),
  });
  return reply(200);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error("Brochure request failed", error.message);
      return reply(503, "送信を完了できませんでした。入力内容を変更せず、時間をおいて再度お試しください。");
    }
  },
};
