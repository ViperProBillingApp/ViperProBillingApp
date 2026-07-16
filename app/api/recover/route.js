import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSessionUser } from "../../../lib/auth.js";
import { rateLimit } from "../../../lib/security.js";

export async function POST(req) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // F-10: each call spends Opus tokens + web searches — cap per user.
  const { limited } = await rateLimit(`recover:${user.id}`, 30, 60 * 60 * 1000);
  if (limited) return NextResponse.json({ error: "Recovery limit reached (30/hour). Try again later." }, { status: 429 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Contact recovery needs an Anthropic API key. Add ANTHROPIC_API_KEY to .env.local and restart." },
      { status: 501 }
    );
  }
  const { name, company, email } = await req.json().catch(() => ({}));
  if (!company && !name) return NextResponse.json({ error: "Missing client details." }, { status: 400 });

  const prompt = `A business email has bounced and I need to recover a working contact for this company.

Company: ${company || name}
Contact name: ${name}
Bounced email: ${email}

Search the web for CURRENT, publicly listed business contact details for this company — a general enquiries or billing/accounts email and phone number from their official website or a reputable business directory. Do not invent anything.

Return ONLY a JSON array (no prose, no markdown fences) of up to 3 candidates, best first:
[{"email":"","phone":"","source":"url or directory name","note":"what this contact is","confidence":"high|medium|low"}]
If you cannot find anything reliable, return [].`;

  const client = new Anthropic();
  let messages = [{ role: "user", content: prompt }];
  let response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages,
  });
  // server-side search can pause the turn; re-send to let it resume (bounded)
  for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages,
    });
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  let j = text.replace(/```json|```/g, "").trim();
  const s = j.indexOf("[");
  const e = j.lastIndexOf("]");
  if (s !== -1 && e !== -1) j = j.slice(s, e + 1);
  let candidates = [];
  try {
    const parsed = JSON.parse(j);
    if (Array.isArray(parsed)) candidates = parsed;
  } catch {
    return NextResponse.json({ error: "Lookup returned an unreadable result — try again." }, { status: 502 });
  }
  return NextResponse.json({ candidates });
}
