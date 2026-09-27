import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { saveConnection } from "../lib/hikyaku-api.server";
import {
  consumeAuthorizationState,
  exchangeCodeForTokens,
  fetchHikyakuUser,
} from "../lib/hikyaku-oauth.server";

// Reached by direct browser navigation in a new tab (opened from
// app._index.tsx), not through the embedded Shopify admin iframe — the
// Supabase consent screen can't render inside that iframe. No
// authenticate.admin() here; trust comes from the single-use `state` token
// matching a pending HikyakuOAuthState row.
type LoaderData =
  { status: "success"; email: string } | { status: "error"; message: string };

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const url = new URL(request.url);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return {
      status: "error",
      message: url.searchParams.get("error_description") ?? oauthError,
    };
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return { status: "error", message: "Missing code or state." };
  }

  const consumed = await consumeAuthorizationState(state);
  if (!consumed) {
    return {
      status: "error",
      message:
        "This connection link has expired or was already used. Go back to the app and click Connect Hikyaku again.",
    };
  }

  try {
    const tokens = await exchangeCodeForTokens(code, consumed.codeVerifier);
    const user = await fetchHikyakuUser(tokens.accessToken);
    await saveConnection(consumed.shop, tokens, user);
    return { status: "success", email: user.email };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Something went wrong connecting to Hikyaku.",
    };
  }
}

export default function HikyakuCallback() {
  const data = useLoaderData<typeof loader>();

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 480,
        margin: "80px auto",
        textAlign: "center",
        padding: "0 24px",
      }}
    >
      {data.status === "success" ? (
        <>
          <h1>Connected to Hikyaku</h1>
          <p>
            Signed in as {data.email}. You can close this tab and go back to
            Shopify to pick which organisation this store feeds.
          </p>
        </>
      ) : (
        <>
          <h1>Couldn&apos;t connect</h1>
          <p>{data.message}</p>
        </>
      )}
    </div>
  );
}
