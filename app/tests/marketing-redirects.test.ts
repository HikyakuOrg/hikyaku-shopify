import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { MARKETING_URL } from "../lib/marketing";

// The app URL opened outside the Shopify admin: nothing may ask for the shop
// domain (App Store requirement 2.3.1), and `/auth/login?shop=` must keep
// starting installs for Hikyaku's Connected Apps.

vi.mock("../shopify.server", () => ({ login: vi.fn() }));

const { login } = await import("../shopify.server");
const { loader: indexLoader } = await import("../routes/_index/route");
const { loader: loginLoader } = await import("../routes/auth.login/route");

const INSTALL_URL =
  "https://admin.shopify.com/store/example/oauth/install?client_id=abc";

async function redirectFrom(
  loader: (args: LoaderFunctionArgs) => Promise<unknown>,
  url: string,
): Promise<string | null> {
  const thrown = await loader({
    request: new Request(url),
  } as LoaderFunctionArgs).then(
    () => {
      throw new Error("expected the loader to redirect");
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(302);
  return (thrown as Response).headers.get("Location");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("/", () => {
  it("sends admin requests on to the app with their params", async () => {
    await expect(
      redirectFrom(
        indexLoader,
        "https://app.example/?shop=example.myshopify.com&host=abc&embedded=1",
      ),
    ).resolves.toBe("/app?shop=example.myshopify.com&host=abc&embedded=1");
  });

  it("sends everyone else to the marketing page", async () => {
    await expect(
      redirectFrom(indexLoader, "https://app.example/"),
    ).resolves.toBe(MARKETING_URL);
  });
});

describe("/auth/login", () => {
  it("starts an install for a valid shop", async () => {
    vi.mocked(login).mockRejectedValue(redirect(INSTALL_URL));

    await expect(
      redirectFrom(
        loginLoader,
        "https://app.example/auth/login?shop=example.myshopify.com",
      ),
    ).resolves.toBe(INSTALL_URL);
  });

  it.each([
    ["no shop", "https://app.example/auth/login", {}],
    [
      "an invalid shop",
      "https://app.example/auth/login?shop=nope",
      { shop: "INVALID_SHOP" },
    ],
  ])("sends %s to the marketing page", async (_, url, loginResult) => {
    vi.mocked(login).mockResolvedValue(
      loginResult as Awaited<ReturnType<typeof login>>,
    );

    await expect(redirectFrom(loginLoader, url)).resolves.toBe(MARKETING_URL);
  });
});
