import { handleProxy } from "@/lib/forward";

export async function POST(req: Request): Promise<Response> {
  return handleProxy(req, { path: "/chat/completions" });
}