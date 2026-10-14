import { test } from "node:test";
import assert from "node:assert/strict";
import { reverseLocationCandidate } from "../server/location-result.js";

test("missing or malformed geocoder points stay missing; no original GPS fallback", () => {
  for (const value of [undefined, "", "invalid", "999"]) {
    const result = reverseLocationCandidate({ lat: value, lon: value, address: { city: "广州" } });
    assert.equal(result.cityLat, null);
    assert.equal(result.cityLng, null);
  }
  assert.deepEqual(reverseLocationCandidate({ lat: "0", lon: "0", address: { city: "合成城市" } }), { city: "合成城市", cityLat: 0, cityLng: 0, location: "" });
});
