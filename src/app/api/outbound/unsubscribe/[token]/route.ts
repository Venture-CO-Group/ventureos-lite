import { unsubscribeByToken } from "@/modules/outbound/sender";
import { VENTURE_BRAND, brandFontStack, brandFrom } from "@/modules/workspaces/brand";
import { escapeHtml } from "@/modules/mail/layout";

/**
 * Unsubscribe from outbound mail (playbook-v6 F5/3). GET is the link in the
 * footer; POST is RFC 8058 one-click from the mail client's own button. Both
 * suppress at once — the address, the company's domain and its tax number,
 * across every campaign. No session: the recipient owns this action, and the
 * 256-bit token is the capability.
 */
async function handle(token: string): Promise<Response> {
  const res = await unsubscribeByToken(token);
  const brand = res.brand ? brandFrom(res.brand) : VENTURE_BRAND;
  // The same words whether or not the token existed.
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:${brandFontStack(brand.fontBody)};background:${brand.canvas};color:${brand.ink};display:grid;place-items:center;min-height:100vh;margin:0;padding:16px"><div style="text-align:center;max-width:420px"><p style="font-size:16px">Leiratkozott — nem kap tőlünk több levelet.</p><p style="color:${brand.muted};font-size:13px">You have been unsubscribed and will not hear from us again. — ${escapeHtml(brand.name)}</p></div></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle((await params).token);
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle((await params).token);
}
