// Cloudflare Pages Function — a "campainha" do B7 (Fase 2b). Endpoint: POST /telegram
// (https://sigaobaile.com/telegram). Recebe o callback do botão do Telegram e dispara a Action
// certa no repo PRIVADO via repository_dispatch. NÃO contém segredo: tudo vem do env (encriptado
// nas Pages settings): TELEGRAM_TOKEN, DISPATCH_PAT (Contents:write no privado), WEBHOOK_SECRET,
// OPERATOR_CHAT. Binding KV opcional: PENDING (estado multi-passo de editar/recriar; sem ele,
// aprovar/não já funcionam).
const GH = "andredemarzo/segue-o-baile-editorial"; // o repo PRIVADO (engine + Actions GERAR/PUBLICAR)

const tg = (tok, method, body) =>
  fetch(`https://api.telegram.org/bot${tok}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const dispatch = (pat, event_type, payload) =>
  fetch(`https://api.github.com/repos/${GH}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "copa-editorial-campainha",
    },
    body: JSON.stringify({ event_type, client_payload: payload }),
  });

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1) anti-forja: o secret_token DEVE estar configurado e bater (a URL é pública).
  if (!env.WEBHOOK_SECRET ||
      request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let u;
  try { u = await request.json(); } catch { return new Response("ok"); }

  const chat = String(env.OPERATOR_CHAT);
  const TOK = env.TELEGRAM_TOKEN;
  const PAT = env.DISPATCH_PAT;
  const fromOperator = (o, c) => String(o?.id) === chat || String(c?.id) === chat;

  // 2) toque de botão (callback_query)
  const cq = u.callback_query;
  if (cq) {
    await tg(TOK, "answerCallbackQuery", { callback_query_id: cq.id }); // mata o spinner SEMPRE
    if (!fromOperator(cq.from, cq.message?.chat)) return new Response("ok"); // só o operador decide
    const [verb, date] = String(cq.data || "").split(":");
    if (verb === "aprovar") {
      await dispatch(PAT, "publish", { date, mode: "publish" });
      await tg(TOK, "sendMessage", { chat_id: chat, text: `🚀 Publicando a coluna ${date}…` });
    } else if (verb === "nao") {
      if (env.PENDING) await env.PENDING.delete(chat);
      await tg(TOK, "sendMessage", { chat_id: chat, text: `🚫 Coluna ${date} NÃO publicada.` });
    } else if (verb === "editar" || verb === "recriar") {
      if (env.PENDING) {
        await env.PENDING.put(chat, JSON.stringify({ mode: verb, date }), { expirationTtl: 3600 });
        const ask = verb === "editar"
          ? "✏️ Manda o <b>texto editado</b> (a coluna inteira, da saudação ao bordão):"
          : "🔄 Manda as <b>instruções</b> (o que mudar/corrigir):";
        await tg(TOK, "sendMessage", { chat_id: chat, text: ask, parse_mode: "HTML" });
      } else {
        await tg(TOK, "sendMessage", { chat_id: chat,
          text: "⚠️ Editar/Recriar precisam do KV (ainda não configurado). Use Aprovar ou Não por ora." });
      }
    }
    return new Response("ok");
  }

  // 3) texto (follow-up de editar/recriar)
  const msg = u.message;
  if (msg && msg.text) {
    if (!fromOperator(msg.from, msg.chat)) return new Response("ok");
    if (!env.PENDING) return new Response("ok");
    const raw = await env.PENDING.get(chat);
    if (!raw) return new Response("ok"); // nada pendente → ignora msg comum
    const p = JSON.parse(raw);
    await env.PENDING.delete(chat);
    if (p.mode === "editar") {
      await dispatch(PAT, "publish", { date: p.date, mode: "edit", text: msg.text });
      await tg(TOK, "sendMessage", { chat_id: chat, text: `✏️ Publicando a versão editada de ${p.date}…` });
    } else if (p.mode === "recriar") {
      await dispatch(PAT, "gerar", { date: p.date, instructions: msg.text });
      await tg(TOK, "sendMessage", { chat_id: chat, text: `🔄 Recriando a coluna ${p.date} com tuas instruções…` });
    }
    return new Response("ok");
  }

  return new Response("ok");
}
