// "Sign in with GitHub" using the OAuth device flow. Needs the client ID of an
// OAuth app with Device Flow enabled (no client secret). The plugin never sees
// the user's GitHub password.

import { requestUrl } from "obsidian";

const form = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

async function post(url: string, body: Record<string, string>) {
  const r = await requestUrl({
    url,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form(body),
    throw: false,
  });
  if (r.status >= 400) throw new Error(`GitHub answered ${r.status}`);
  return r.json as Record<string, string | number>;
}

export async function githubDeviceLogin(
  clientId: string,
  show: (userCode: string, verificationUri: string) => void,
  cancelled: () => boolean,
): Promise<string> {
  if (!clientId.trim()) throw new Error("Set the GitHub OAuth app client ID in the advanced settings first");
  const start = await post("https://github.com/login/device/code", { client_id: clientId.trim(), scope: "repo" });
  if (start.error) throw new Error(String(start.error_description ?? start.error));
  show(String(start.user_code), String(start.verification_uri));
  let interval = Number(start.interval ?? 5);
  const deadline = Date.now() + Number(start.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (cancelled()) throw new Error("Sign-in cancelled");
    const r = await post("https://github.com/login/oauth/access_token", {
      client_id: clientId.trim(),
      device_code: String(start.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.access_token) return String(r.access_token);
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") {
      interval = Number(r.interval ?? interval + 5);
      continue;
    }
    throw new Error(String(r.error_description ?? r.error ?? "GitHub sign-in failed"));
  }
  throw new Error("The sign-in code expired; try again");
}
