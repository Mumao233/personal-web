// A failed lookup must never relabel the submitted private GPS as a city point.
export function reverseLocationCandidate(result) {
  const number = (value, limit) => {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
  };
  return {
    city: result.address?.city || result.address?.town || result.address?.county || result.name || "",
    cityLat: number(result.lat, 90),
    cityLng: number(result.lon, 180),
    location: result.display_name || "",
  };
}
