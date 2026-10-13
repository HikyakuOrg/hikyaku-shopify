import { describe, expect, it } from "vitest";
import {
  carrierCallbackUrl,
  findOwnCarrierService,
  planCarrierService,
  type CarrierServiceLike,
} from "./carrier-service";

const CALLBACK =
  "https://api.hikyaku.org/api/v1/integrations/shopify/carrier-rates";

function service(
  id: number,
  overrides: Partial<CarrierServiceLike> = {},
): CarrierServiceLike {
  return {
    id: `gid://shopify/DeliveryCarrierService/${id}`,
    name: "Hikyaku",
    callbackUrl: CALLBACK,
    active: true,
    ...overrides,
  };
}

describe("carrierCallbackUrl", () => {
  it("joins the callback path onto the API URL", () => {
    expect(carrierCallbackUrl("https://api.hikyaku.org")).toBe(CALLBACK);
    expect(carrierCallbackUrl("https://api.hikyaku.org/")).toBe(CALLBACK);
  });
});

describe("findOwnCarrierService", () => {
  const other = service(1, {
    name: "Other carrier",
    callbackUrl: "https://rates.example.com/",
  });

  it("prefers the stored GID", () => {
    const stored = service(2, { callbackUrl: "https://old.example.com/" });
    expect(
      findOwnCarrierService([other, service(3), stored], {
        knownId: stored.id,
        callbackUrl: CALLBACK,
      }),
    ).toBe(stored);
  });

  it("falls back to the callback URL when the GID is unknown or gone", () => {
    const ours = service(3, { callbackUrl: `${CALLBACK}/` });
    expect(
      findOwnCarrierService([other, ours], {
        knownId: null,
        callbackUrl: CALLBACK,
      }),
    ).toBe(ours);
    expect(
      findOwnCarrierService([other, ours], {
        knownId: "gid://shopify/DeliveryCarrierService/999",
        callbackUrl: CALLBACK,
      }),
    ).toBe(ours);
  });

  it("never picks another app's carrier service", () => {
    expect(
      findOwnCarrierService([other], { knownId: null, callbackUrl: CALLBACK }),
    ).toBeNull();
  });
});

describe("planCarrierService", () => {
  const desired = { name: "Hikyaku", callbackUrl: CALLBACK, active: true };

  it("creates when there is none", () => {
    expect(planCarrierService(null, desired)).toEqual({
      kind: "create",
      input: desired,
    });
  });

  it("does nothing when it already matches", () => {
    expect(planCarrierService(service(1), desired)).toEqual({
      kind: "none",
      id: service(1).id,
    });
  });

  it("changes only what differs", () => {
    expect(planCarrierService(service(1, { active: false }), desired)).toEqual({
      kind: "update",
      id: service(1).id,
      changes: { active: true },
    });
    expect(
      planCarrierService(
        service(1, { name: "Old", callbackUrl: "https://old.example.com/" }),
        { ...desired, active: true },
      ),
    ).toEqual({
      kind: "update",
      id: service(1).id,
      changes: { name: "Hikyaku", callbackUrl: CALLBACK },
    });
  });
});
