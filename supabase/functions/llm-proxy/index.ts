// XWebAgent LLM Proxy — Supabase Edge Function
// Proxies requests to OpenRouter, keeping the API key server-side.
//
// Deploy:
//   supabase functions deploy llm-proxy --no-verify-jwt
//
// Set secret:
//   supabase secrets set OPENROUTER_API_KEY=sk-or-...

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const DEFAULT_MODEL   = "google/gemini-3-flash-preview";
const OPENROUTER_URL  = "https://openrouter.ai/api/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!OPENROUTER_KEY) {
    return json({ error: "Proxy not configured (missing OPENROUTER_API_KEY secret)" }, 500);
  }

  let body: { messages?: any[]; systemPrompt?: string; images?: any[]; model?: string; thinkingBudget?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { messages = [], systemPrompt = "", images = [], model = DEFAULT_MODEL, thinkingBudget } = body;

  // Build the user content string (extension sends single-turn messages)
  let userText = systemPrompt ? `[Instructions]\n${systemPrompt}\n\n` : "";
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    userText += typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }

  // Build content — multimodal if images are present
  let content: string | any[];
  if (images.length > 0) {
    content = [{ type: "text", text: userText }];
    for (const img of images) {
      if (img.label) content.push({ type: "text", text: `[${img.label}]:` });
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${img.base64}` },
      });
    }
  } else {
    content = userText;
  }

  // Determine max_tokens — router calls are short, normal calls need more
  const isRouterCall = body.messages?.some((m: any) =>
    typeof m.content === "string" && m.content.length < 512
  ) && !systemPrompt;
  const max_tokens = isRouterCall ? 256 : 4096;

  try {
    const orResp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer":  "https://xwebagent.app",
        "X-Title":       "XWebAgent",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
        max_tokens,
        ...(thinkingBudget ? { thinking: { budget_tokens: thinkingBudget } } : {}),
      }),
    });

    const data = await orResp.json();

    if (!orResp.ok) {
      return json({ error: data.error?.message ?? `OpenRouter error ${orResp.status}` }, orResp.status);
    }

    const text: string | undefined = data.choices?.[0]?.message?.content;
    if (!text) {
      return json({ error: "Empty response from model" }, 500);
    }

    return json({ content: text });
  } catch (e: any) {
    return json({ error: `Proxy network error: ${e.message}` }, 500);
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
